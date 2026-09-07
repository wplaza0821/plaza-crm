// dropbox-docs-sync — Supabase Edge Function
//
// Server-side replacement for ~/.hermes/scripts/crm_dropbox_docs.py (the 7am
// cron on William's Mac). Walks the Dropbox project folders, attaches every
// proposal-like PDF/DOCX to its deal in `deal_documents`, keeps one PRIMARY per
// deal, and records the run in `sync_runs` so the CRM can show freshness — and
// say so when the sync has silently stopped.
//
// Matching, classification and exclusion rules are lifted from
// supabase/extract_proposal_fees.py so both tools agree on what a proposal is.
//
// Triggered two ways:
//   - pg_cron at 7am via net.http_post with header X-Sync-Secret (see
//     migrations/008_sync_runs.sql)
//   - "Sync now" in the CRM with the user's JWT
//
// Secrets:
//   DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN  (shared with dropbox-files)
//   DROPBOX_PROJECTS_ROOTS  comma-separated Dropbox paths, default
//                           "/William Plaza/2026 PROJECTS,/William Plaza/2025 PROJECTS"
//   SYNC_SECRET             shared secret for the cron trigger
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_KEY = Deno.env.get("DROPBOX_APP_KEY")!;
const APP_SECRET = Deno.env.get("DROPBOX_APP_SECRET")!;
const REFRESH_TOKEN = Deno.env.get("DROPBOX_REFRESH_TOKEN")!;
const SYNC_SECRET = Deno.env.get("SYNC_SECRET") || "";
const ROOTS = (Deno.env.get("DROPBOX_PROJECTS_ROOTS") ||
  "/William Plaza/2026 PROJECTS,/William Plaza/2025 PROJECTS")
  .split(",").map((s) => s.trim()).filter(Boolean);

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// ---------- auth: cron secret OR a signed-in user ----------
async function authorised(req: Request): Promise<boolean> {
  const s = req.headers.get("x-sync-secret");
  if (SYNC_SECRET && s && s === SYNC_SECRET) return true;
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_ANON, Authorization: auth },
  });
  return r.ok;
}

// ---------- Dropbox ----------
let cachedToken: { token: string; exp: number } | null = null;
async function dropboxToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.exp - 60_000) return cachedToken.token;
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: REFRESH_TOKEN,
      client_id: APP_KEY, client_secret: APP_SECRET,
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
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e: any = new Error(d.error_summary || `Dropbox ${endpoint} failed (${r.status})`);
    e.summary = d.error_summary || ""; e.status = r.status;
    throw e;
  }
  return d;
}
// One recursive listing per root: every file under every project folder.
async function listRoot(root: string) {
  const out: any[] = [];
  let d = await dbx("files/list_folder", { path: root, recursive: true, limit: 2000 });
  for (;;) {
    out.push(...d.entries.filter((e: any) => e[".tag"] === "file"));
    if (!d.has_more) break;
    d = await dbx("files/list_folder/continue", { cursor: d.cursor });
  }
  return out;
}
// Permanent client-safe share link; the app has sharing.write since 2026-08-10.
async function shareLink(path: string): Promise<string | null> {
  try {
    const d = await dbx("sharing/create_shared_link_with_settings", { path });
    return d.url || null;
  } catch (e: any) {
    if (String(e.summary).includes("shared_link_already_exists")) {
      const d = await dbx("sharing/list_shared_links", { path, direct_only: true });
      return d.links?.[0]?.url || null;
    }
    if (String(e.summary).includes("missing_scope")) return null; // fall back to web path
    throw e;
  }
}
const webPath = (pathDisplay: string) =>
  "https://www.dropbox.com/home" + pathDisplay.split("/").map(encodeURIComponent).join("/");

// ---------- classification (mirrors extract_proposal_fees.py) ----------
const EXCLUDE = /(FR|SI|SM)-\d|Permit|Notice_of_Comm|Bidsheet|SUPERSEDED|REMOVED/i;
const SIGNED = /SIGNED|EXECUTED|FULLY[\s_-]*EXECUTED/i;
function kindOf(name: string): string | null {
  if (/proposal/i.test(name)) return "proposal";
  if (/agreement|contract/i.test(name)) return "agreement";
  if (/terms|t&c|conditions/i.test(name)) return "t&c";
  return null;
}
function isCandidate(name: string, projectNo: string) {
  if (!/\.(pdf|docx?)$/i.test(name)) return false;
  if (EXCLUDE.test(name)) return false;
  return /proposal/i.test(name) || name.startsWith(projectNo) || !!kindOf(name);
}
// PRIMARY = the client-facing proposal. Prefer the executed copy when one
// exists (that is what the client holds); otherwise the newest proposal.
function pickPrimary(rows: any[]): any | null {
  const props = rows.filter((r) => r.doc_kind === "proposal");
  const pool = props.length ? props : rows;
  if (!pool.length) return null;
  const signed = pool.filter((r) => r.is_signed);
  const from = signed.length ? signed : pool;
  return from.sort((a, b) => String(b.modified_at).localeCompare(String(a.modified_at)))[0];
}

// ---------- Supabase (service role: the sync writes for everyone) ----------
async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`,
      "Content-Type": "application/json", ...(init.headers || {}),
    },
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`${path}: ${raw.slice(0, 300)}`);
  return raw ? JSON.parse(raw) : null;
}

async function runSync() {
  const started = new Date().toISOString();
  const stats = { roots: ROOTS.length, files_seen: 0, deals_matched: 0, docs_upserted: 0, docs_removed: 0, links_created: 0, unmatched_folders: [] as string[] };

  const deals: any[] = await sb("deals?select=id,project_no&project_no=not.is.null");
  const byNo = new Map<string, any>();
  for (const d of deals) if (d.project_no) byNo.set(String(d.project_no).trim(), d);

  // group candidate files by deal
  const perDeal = new Map<number, { deal: any; year: string; files: any[] }>();
  for (const root of ROOTS) {
    const year = (root.match(/(20\d\d)/) || [])[1] || null;
    let files: any[] = [];
    try { files = await listRoot(root); }
    catch (e: any) {
      if (String(e.summary).includes("not_found")) continue; // root absent this year
      throw e;
    }
    stats.files_seen += files.length;
    const prefix = root.toLowerCase().replace(/\/+$/, "") + "/";
    for (const f of files) {
      const rel = String(f.path_lower).startsWith(prefix) ? f.path_display.slice(root.length + 1) : null;
      if (!rel) continue;
      const folder = rel.split("/")[0];
      const projectNo = folder.split(" ")[0];
      const deal = byNo.get(projectNo);
      if (!deal) { if (!stats.unmatched_folders.includes(folder)) stats.unmatched_folders.push(folder); continue; }
      if (!isCandidate(f.name, projectNo)) continue;
      const g = perDeal.get(deal.id) || { deal, year: year || "", files: [] as any[] };
      g.files.push(f); perDeal.set(deal.id, g);
    }
  }
  stats.deals_matched = perDeal.size;

  for (const [dealId, g] of perDeal) {
    const existing: any[] = await sb(`deal_documents?deal_id=eq.${dealId}&select=id,path_lower,url,link_kind`);
    const byPath = new Map(existing.map((r) => [r.path_lower, r]));

    const rows = [];
    for (const f of g.files) {
      const prev = byPath.get(f.path_lower);
      let url = prev?.link_kind === "shared_link" ? prev.url : null;
      let link_kind = url ? "shared_link" : "web_path";
      if (!url) {
        const l = await shareLink(f.path_lower);
        if (l) { url = l; link_kind = "shared_link"; stats.links_created++; }
        else url = webPath(f.path_display);
      }
      rows.push({
        deal_id: dealId, path_lower: f.path_lower, path_display: f.path_display,
        file_name: f.name, url, link_kind, size_bytes: f.size ?? null,
        modified_at: f.server_modified ?? null,
        is_signed: SIGNED.test(f.name), doc_kind: kindOf(f.name) || "other",
        source_year: g.year || null, is_primary: false, updated_at: new Date().toISOString(),
      });
    }
    const primary = pickPrimary(rows);
    if (primary) primary.is_primary = true;

    // rows for files that vanished from Dropbox
    const keep = new Set(rows.map((r) => r.path_lower));
    const gone = existing.filter((r) => !keep.has(r.path_lower)).map((r) => r.id);
    if (gone.length) {
      await sb(`deal_documents?id=in.(${gone.join(",")})`, { method: "DELETE" });
      stats.docs_removed += gone.length;
    }
    // clear primary first so the partial unique index never sees two trues
    await sb(`deal_documents?deal_id=eq.${dealId}`, { method: "PATCH", body: JSON.stringify({ is_primary: false }) });
    if (rows.length) {
      await sb(`deal_documents?on_conflict=deal_id,path_lower`, {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rows),
      });
      stats.docs_upserted += rows.length;
    }
  }
  return { started, stats };
}

async function recordRun(job: string, started: string, ok: boolean, stats: unknown, error: string | null) {
  try {
    await sb("sync_runs", {
      method: "POST",
      body: JSON.stringify({ job, started_at: started, finished_at: new Date().toISOString(), ok, stats, error }),
    });
  } catch (_) { /* a missing sync_runs table must not fail the sync itself */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await authorised(req))) return json({ error: "Unauthorized" }, 401);
  const started = new Date().toISOString();
  try {
    const { stats } = await runSync();
    await recordRun("dropbox_docs", started, true, stats, null);
    return json({ ok: true, stats });
  } catch (e) {
    const msg = (e as Error).message;
    await recordRun("dropbox_docs", started, false, null, msg);
    return json({ ok: false, error: msg }, 500);
  }
});
