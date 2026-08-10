// dropbox-files — Supabase Edge Function
//
// Bridges the CRM to the firm's Dropbox so each deal's `dropbox_folder` can be
// browsed in-app and proposal PDFs can be scanned for their fee amount.
//
// Actions (POST JSON):
//   { action:"list",  path:"/Proposals/Dome" }         -> { files:[{name,path,size,modified,is_pdf}] }
//   { action:"link",  path:"/Proposals/Dome/p.pdf" }   -> { url }               (4-hour temp link)
//   { action:"value", path:"/Proposals/Dome/p.pdf" }   -> { candidates:[{amount,context,score}], file }
//
// Secrets (supabase secrets set):
//   DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN
//
// Auth: caller must present a valid Supabase JWT (same gate as graph-mail);
// verified against GoTrue before any Dropbox call.

import { extractText, getDocumentProxy } from "npm:unpdf";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_KEY = Deno.env.get("DROPBOX_APP_KEY")!;
const APP_SECRET = Deno.env.get("DROPBOX_APP_SECRET")!;
const REFRESH_TOKEN = Deno.env.get("DROPBOX_REFRESH_TOKEN")!;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

async function verifyCaller(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_ANON, Authorization: auth },
  });
  return r.ok;
}

let cachedToken: { token: string; exp: number } | null = null;
async function dropboxToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.exp - 60_000) return cachedToken.token;
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id: APP_KEY,
      client_secret: APP_SECRET,
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || "Dropbox auth failed");
  cachedToken = { token: d.access_token, exp: Date.now() + (d.expires_in || 14400) * 1000 };
  return cachedToken.token;
}

async function dbx(endpoint: string, body: unknown): Promise<any> {
  const t = await dropboxToken();
  const r = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_summary || `Dropbox ${endpoint} failed`);
  return d;
}

async function dbxDownload(path: string): Promise<Uint8Array> {
  const t = await dropboxToken();
  const r = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${t}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  });
  if (!r.ok) throw new Error(`Dropbox download failed (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}

async function listFolder(path: string) {
  const out: any[] = [];
  let d = await dbx("files/list_folder", { path, limit: 200 });
  for (;;) {
    out.push(...d.entries);
    if (!d.has_more) break;
    d = await dbx("files/list_folder/continue", { cursor: d.cursor });
  }
  return out
    .filter((e) => e[".tag"] === "file" || e[".tag"] === "folder")
    .map((e) => ({
      name: e.name,
      path: e.path_display || e.path_lower,
      is_folder: e[".tag"] === "folder",
      size: e.size ?? null,
      modified: e.server_modified ?? null,
      is_pdf: /\.pdf$/i.test(e.name),
    }))
    .sort((a, b) =>
      (b.is_folder ? 1 : 0) - (a.is_folder ? 1 : 0) ||
      String(b.modified || "").localeCompare(String(a.modified || ""))
    );
}

/* Find dollar amounts in proposal text with enough surrounding context to
   judge them. Lines mentioning fee/total/lump sum/contract outrank naked
   numbers; tiny amounts (permits, unit rates) rank down. */
function findAmounts(text: string) {
  const seen = new Map<number, { amount: number; context: string; score: number }>();
  const re = /\$\s?((?:\d{1,3}(?:,\d{3})+|\d{4,})(?:\.\d{2})?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const amount = Number(m[1].replace(/,/g, ""));
    if (!amount || amount < 500) continue; // ignore permit-fee noise
    const ctx = text
      .slice(Math.max(0, m.index - 90), m.index + m[0].length + 50)
      .replace(/\s+/g, " ")
      .trim();
    let score = 0;
    if (/fee|total|lump\s*sum|contract|proposal\s*(amount|price)|grand/i.test(ctx)) score += 3;
    if (/not\s*to\s*exceed|nte/i.test(ctx)) score += 2;
    if (/per\s*(hour|hr|sf|unit|day)|hourly|allowance|reimburs/i.test(ctx)) score -= 2;
    if (amount >= 5000) score += 1;
    const prev = seen.get(amount);
    if (!prev || score > prev.score) seen.set(amount, { amount, context: ctx, score });
  }
  return [...seen.values()]
    .sort((a, b) => b.score - a.score || b.amount - a.amount)
    .slice(0, 6);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await verifyCaller(req))) return json({ error: "Unauthorized" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }

  try {
    if (body.action === "list") {
      if (!body.path) return json({ error: "path required" }, 400);
      return json({ files: await listFolder(String(body.path)) });
    }
    if (body.action === "link") {
      if (!body.path) return json({ error: "path required" }, 400);
      const d = await dbx("files/get_temporary_link", { path: String(body.path) });
      return json({ url: d.link });
    }
    if (body.action === "value") {
      if (!body.path) return json({ error: "path required" }, 400);
      const bytes = await dbxDownload(String(body.path));
      const pdf = await getDocumentProxy(bytes);
      const { text } = await extractText(pdf, { mergePages: true });
      const candidates = findAmounts(String(text || ""));
      return json({ file: String(body.path).split("/").pop(), candidates });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
