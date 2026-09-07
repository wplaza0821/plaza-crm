// Plaza CRM — Graph email Edge Function
// Keeps the Microsoft Graph refresh token SERVER-SIDE. The browser never sees it.
// Every request must carry a valid Supabase user JWT, which is verified against
// the project's auth server before any mailbox access happens.

const TENANT_ID = "7b4a88f5-2be6-4196-a2a3-2a114390b93e";
const CLIENT_ID = "fe9862cc-2672-4bc8-b64e-68d0f902061c";
const GRAPH = "https://graph.microsoft.com/v1.0";

/* Outbound signature.
 *
 * Outlook applies the firm's formal signature client-side, so mail sent
 * through Graph gets none — this supplies it. Held in the GRAPH_SIGNATURE_HTML
 * secret rather than in source, so it can be corrected without a code change
 * and stays in step with the Outlook original:
 *
 *   supabase secrets set --project-ref zhxwkntrndaeqtkmbtsh \
 *     GRAPH_SIGNATURE_HTML="$(cat signature.html)"
 *
 * The fallback below is the abbreviated block that predates this and is NOT
 * the formal signature; it exists only so mail is never sent unsigned.
 */
const FALLBACK_SIGNATURE = `<br><br><div>Regards,</div><br>
<div><b>WILLIAM PLAZA</b><br>Principal</div><br>
<div><b>PLAZA &amp; ASSOCIATES</b><br>
2222 Ponce de Leon Boulevard<br>Coral Gables, Florida 33134<br>
O: (786) 310-5428 ext. 1<br>C: (305) 469-1120<br>
<a href="http://www.plazaandassociates.com">www.plazaandassociates.com</a></div>`;

const SIGNATURE = (Deno.env.get("GRAPH_SIGNATURE_HTML") || "").trim() || FALLBACK_SIGNATURE;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

/** Verify the caller is a logged-in Supabase user. */
async function requireUser(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") || "";
  const jwt = auth.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.email ?? null;
}

/** Exchange the stored refresh token for a short-lived Graph access token. */
async function graphToken(): Promise<string> {
  const rt = Deno.env.get("MS_REFRESH_TOKEN");
  if (!rt) throw new Error("MS_REFRESH_TOKEN secret not set");
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: rt,
    scope:
      "offline_access openid profile https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read",
  });
  const r = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", body },
  );
  if (!r.ok) throw new Error(`token refresh failed: ${r.status} ${await r.text()}`);
  const d = await r.json();
  return d.access_token;
}

const SELECT =
  "id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,webLink";

/**
 * Convert Graph HTML mail into readable plain text.
 * CRITICAL: block-level tags are turned into newlines BEFORE tags are stripped.
 * The old implementation stripped tags first and then collapsed ALL whitespace with
 * /\s+/ -> " ", which destroyed every paragraph break and produced one unreadable
 * wall of text in the CRM drawer.
 */
function htmlToText(h: string, n = 20000): string {
  let s = h || "";
  s = s.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // block boundaries -> newlines (must happen before generic tag strip)
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, "\n");
  s = s.replace(/<(p|div|tr|li|h[1-6]|blockquote)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/t[dh]>/gi, "\t");
  s = s.replace(/<[^>]+>/g, "");
  const ents: Record<string, string> = {
    "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&quot;": '"',
    "&rsquo;": "\u2019", "&lsquo;": "\u2018", "&ldquo;": "\u201c", "&rdquo;": "\u201d",
    "&mdash;": "\u2014", "&ndash;": "\u2013", "&hellip;": "\u2026", "&middot;": "\u00b7",
  };
  for (const [k, v] of Object.entries(ents)) s = s.split(k).join(v);
  s = s.replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_m, d) => String.fromCharCode(parseInt(d, 16)));
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");   // cap blank runs
  return s.trim().slice(0, n);
}

/**
 * Split the newest reply from the quoted history beneath it.
 * NOTE: sender addresses can arrive HTML-escaped (`From: Ken &lt;ken@x.com&gt;`), so the
 * marker must accept `<`, `[`, `&lt;` or a bare newline after the From: line.
 */
function splitQuoted(text: string): { body: string; quoted: string } {
  const re =
    /\n(?=(?:From:\s*.{0,120}?(?:<|\[|&lt;)|On .{5,80}\bwrote:|-{2,}\s*Original Message|_{5,}))/i;
  const idx = text.search(re);
  if (idx < 0) return { body: text.trim(), quoted: "" };
  return { body: text.slice(0, idx).trim(), quoted: text.slice(idx).trim() };
}

/**
 * Trim ONLY the exact Plaza letterhead block from the visible body.
 *
 * Deliberately conservative. Earlier attempts used heuristics ("sign-off followed by
 * short lines", "trailing contact-detail lines") and they destroyed real content —
 * one test removed 9,906 characters of a legitimate quarantine digest, another sliced
 * a phone number out of the MIDDLE of a vendor's signature leaving the rest behind.
 * Hiding real email content is far worse than showing a few extra signature lines,
 * so only the known-exact Plaza footer is removed and everything else is preserved.
 */
function stripSignature(t: string): string {
  // Cut from the Plaza letterhead marker to the end (appears in William's and staff mail).
  const s = t.replace(
    /\n+(?:WILLIAM PLAZA\s*\n\s*Principal|PLAZA\s*&(?:amp;)?\s*ASSOCIATES\s*\n\s*2222\s+Ponce)[\s\S]*$/i,
    "",
  );
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

// Kept for the search-result preview line (single-line, no paragraphs needed).
function stripHtml(h: string, n = 6000): string {
  return htmlToText(h, n).replace(/\s+/g, " ").trim().slice(0, n);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const email = await requireUser(req);
  if (!email) return json({ error: "unauthorized — please sign in" }, 401);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const action = String(payload.action || "");

  try {
    const tok = await graphToken();
    const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };

    // ---------------- search across mailbox for a deal's keywords ----------------
    // NOTE: Graph $search is a RELEVANCE ranker, not a filter. It matches subject, body,
    // sender AND attachment content, then pads results with loosely-related mail. Searching
    // "terrazas" returned Echo Brickell submittals, GoDaddy quarantine notices and QuickBooks
    // invoices. Every hit is therefore re-verified below: the keyword must literally appear in
    // subject / sender / recipients / bodyPreview, otherwise it is discarded.
    if (action === "search") {
      const kws = (payload.keywords as string[] | undefined)?.slice(0, 3) ?? [];

      // ---- CLIENT-PARTICIPANT GATE (added 2026-08-03) -------------------------------
      // Keyword matching alone let 33.8% noise through (297 of 879 messages measured
      // across all 40 deals). A keyword says what a message is ABOUT; it cannot say who
      // it is WITH. "novoa" matched an American Airlines receipt and an Apple Card
      // notice; "cooling tower" matched a BuildingConnected bid invite for an unrelated
      // building; "pine ridge" matched Zendesk and VendorSmart robots.
      //
      // A message now only qualifies as client correspondence if the CLIENT is actually
      // a participant (from / to / cc). Automated senders are rejected outright.
      const contactEmail = String(payload.contact_email || "").toLowerCase().trim();
      const extraDomains = ((payload.client_domains as string[] | undefined) ?? [])
        .map((d) => d.toLowerCase().replace(/^@/, "").trim()).filter(Boolean);
      const strict = payload.strict_client !== false; // default ON

      const OWN = "plazaandassociates.com";
      const contactDomain = contactEmail.includes("@") ? contactEmail.split("@")[1] : "";
      // Free mail hosts: never trust the DOMAIN, only the exact address.
      const FREEMAIL = new Set([
        "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
        "icloud.com", "me.com", "comcast.net", "att.net", "bellsouth.net", "msn.com",
        "live.com", "protonmail.com", "mac.com", "verizon.net", "sbcglobal.net",
      ]);
      const clientDomains = new Set<string>(extraDomains);
      if (contactDomain && !FREEMAIL.has(contactDomain) && contactDomain !== OWN) {
        clientDomains.add(contactDomain);
      }

      // Automated / bulk senders — never real client correspondence even when the
      // keyword genuinely appears in the subject.
      // NOTE: JS regex has NO /x extended flag (that's Python). Keep these on one line.
      const AUTO_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply|bounce|mailer|postmaster|notification|notifications|alert|alerts|automated|auto|system|billing|marketing|news|newsletter|update|updates|mail|email|team)$/;
      const AUTO_LOCAL_PREFIX = /^(no[-_.]?reply|noreply|donotreply|mailer|bounce|notification)/;
      const AUTO_HOST = /(^|\.)(sendgrid|mailchimp|mandrill|sparkpostmail|amazonses|mailgun|postmarkapp|zendesk|freshdesk|intercom|hubspot|salesforce|buildingconnected|vendorsmart|procore|docusign|dropboxmail|inmomentfeedback|beside|gridsystems|applecard|ppines)\./;
      const AUTO_HOST_EXACT = /^(microsoft\.com|office365\.com|godaddy\.com|intuit\.com|quickbooks\.com|apple\.com|google\.com|dropbox\.com|info\.email\.aa\.com|post\.applecard\.apple)$/;
      const isAutomated = (addr: string): boolean => {
        const a = addr.toLowerCase();
        if (!a.includes("@")) return false;
        const local = a.split("@")[0];
        const host = a.split("@")[1] || "";
        if (AUTO_LOCAL.test(local)) return true;
        if (AUTO_LOCAL_PREFIX.test(local)) return true;
        if (AUTO_HOST.test(host)) return true;
        if (AUTO_HOST_EXACT.test(host)) return true;
        return false;
      };

      /** Is the deal's client actually on this message? */
      const clientOnMessage = (m: any): boolean => {
        const addrs: string[] = [];
        const fa = (m.from?.emailAddress?.address || "").toLowerCase();
        if (fa) addrs.push(fa);
        for (const x of [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])]) {
          const a = (x.emailAddress?.address || "").toLowerCase();
          if (a) addrs.push(a);
        }
        if (!addrs.length) return false;

        // 1. EXACT contact address wins outright — checked BEFORE the automation
        //    heuristic, because real client contacts legitimately use role addresses
        //    (info@alliedpropertygroup.net on 26004/26018, management@echobrickell.com,
        //    manager@domecondominium.com, gm@trpvillage.com). Rejecting those as
        //    "automated" would drop genuine client mail.
        if (contactEmail && addrs.includes(contactEmail)) return true;

        // 2. Otherwise reject anything sent BY an automated system.
        if (fa && isAutomated(fa)) return false;

        // 3. Same-company domain match (never for freemail hosts).
        for (const a of addrs) {
          const h = a.split("@")[1] || "";
          if (h && clientDomains.has(h)) return true;
        }
        return false;
      };

      // Generic terms that match half the mailbox on their own. Only trusted in the subject
      // line or sender address, never on a bodyPreview substring hit.
      const WEAK = new Set([
        "proposal", "civil proposal", "civil", "invoice", "statement", "plaza",
        "structural", "engineering", "inspection", "report", "pool", "review",
      ]);

      const matches = (m: any, kw: string): boolean => {
        const k = kw.toLowerCase().trim();
        if (!k) return false;
        const subject = (m.subject || "").toLowerCase();
        const fromAddr = (m.from?.emailAddress?.address || "").toLowerCase();
        const fromName = (m.from?.emailAddress?.name || "").toLowerCase();
        const rcpts = [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])]
          .map((x: any) => (x.emailAddress?.address || "").toLowerCase())
          .join(" ");
        const strong = `${subject} ${fromAddr} ${fromName} ${rcpts}`;
        const body = (m.bodyPreview || "").toLowerCase();

        // Short keywords (<=4 chars, e.g. "rtu", "ph55") must match as a WHOLE WORD,
        // otherwise they hit substrings inside unrelated words.
        const test = (hay: string): boolean => {
          if (k.length > 4) return hay.includes(k);
          const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(hay);
        };

        // Weak/generic keywords must hit the subject or a participant address —
        // a body mention is not enough to tie the mail to this deal.
        if (WEAK.has(k)) return test(strong);
        if (test(strong)) return true;
        return test(body);
      };

      const seen = new Set<string>();
      const out: unknown[] = [];

      const push = (m: any, folder: string, kw: string, via: string) => {
        seen.add(m.id);
        out.push({
          matchedKeyword: kw,
          matchedVia: via, // "keyword+client" | "client-address"
          id: m.id,
          conversationId: m.conversationId,
          direction: folder === "sentitems" ? "out" : "in",
          subject: m.subject || "(no subject)",
          preview: stripHtml(m.bodyPreview || "", 300),
          from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "",
          from_addr: m.from?.emailAddress?.address || "",
          to: (m.toRecipients ?? []).map((x: any) => x.emailAddress?.address || ""),
          to_names: (m.toRecipients ?? []).map(
            (x: any) => x.emailAddress?.name || x.emailAddress?.address || "",
          ),
          cc_count: (m.ccRecipients ?? []).length,
          date: (m.sentDateTime || m.receivedDateTime || "").slice(0, 19),
          hasAttachments: !!m.hasAttachments,
          webLink: m.webLink,
        });
      };

      // PASS 1 — keyword search, then require BOTH a real keyword match AND the client
      // being a participant. This is the change that removes the 33.8% noise.
      let droppedNoClient = 0;
      for (const kw of kws) {
        if (!kw) continue;
        for (const folder of ["inbox", "sentitems"]) {
          const u = new URL(`${GRAPH}/me/mailFolders/${folder}/messages`);
          u.searchParams.set("$search", `"${kw}"`);
          u.searchParams.set("$top", "25");
          u.searchParams.set("$select", SELECT);
          const r = await fetch(u, { headers: H });
          if (!r.ok) continue;
          const d = await r.json();
          for (const m of d.value ?? []) {
            if (seen.has(m.id)) continue;
            if (!matches(m, kw)) continue; // drop relevance-ranker noise
            if (strict && !clientOnMessage(m)) { droppedNoClient++; continue; }
            push(m, folder, kw, "keyword+client");
          }
        }
      }

      // PASS 2 — search the CLIENT ADDRESS directly. Recovers real client threads whose
      // subject/body never spells the project keyword ("Re: Call", "Signed App"), which
      // the keyword-only filter always missed. Cheap: one extra query per folder.
      //
      // SHARED-CONTACT GUARD: several deals can share one contact (Dome =
      // 26015 retaining wall / 26019 recert / 26026 mechanical, all
      // manager@domecondominium.com; Terrazas = 26011 + 26014; North Bay Villas =
      // 26016/24/30). Without this, pass 2 would copy the SAME client thread into every
      // sibling deal — recertification mail showing up under the mechanical project.
      // `sibling_keywords` = keywords owned by the client's OTHER deals; a pass-2 hit
      // that matches a sibling but NOT this deal belongs to the sibling, so drop it.
      const siblingKws = ((payload.sibling_keywords as string[] | undefined) ?? [])
        .map((s) => s.toLowerCase().trim()).filter(Boolean);
      const belongsToSibling = (m: any): boolean => {
        if (!siblingKws.length) return false;
        const mine = kws.some((k) => matches(m, k));
        if (mine) return false; // explicitly ours — keep
        return siblingKws.some((k) => matches(m, k));
      };

      if (contactEmail) {
        for (const folder of ["inbox", "sentitems"]) {
          const u = new URL(`${GRAPH}/me/mailFolders/${folder}/messages`);
          u.searchParams.set("$search", `"${contactEmail}"`);
          u.searchParams.set("$top", "25");
          u.searchParams.set("$select", SELECT);
          const r = await fetch(u, { headers: H });
          if (!r.ok) continue;
          const d = await r.json();
          for (const m of d.value ?? []) {
            if (seen.has(m.id)) continue;
            if (!clientOnMessage(m)) continue;   // must genuinely involve the client
            if (belongsToSibling(m)) continue;   // belongs to another deal of same client
            push(m, folder, contactEmail, "client-address");
          }
        }
      }

      out.sort((a: any, b: any) => (b.date || "").localeCompare(a.date || ""));
      return json(out.slice(0, 40));
    }

    // ---------------- full body of one message ----------------
    if (action === "message") {
      const id = String(payload.id || "");
      if (!id) return json({ error: "id required" }, 400);
      const r = await fetch(
        `${GRAPH}/me/messages/${id}?$select=id,subject,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,webLink`,
        { headers: H },
      );
      if (!r.ok) return json({ error: `graph ${r.status}` }, 502);
      const m = await r.json();

      const full = htmlToText(m.body?.content ?? "");
      const { body, quoted } = splitQuoted(full);

      // Attachment names (skip inline images — they're layout noise, not documents).
      let attachments: { name: string; size: number }[] = [];
      if (m.hasAttachments) {
        const ar = await fetch(
          `${GRAPH}/me/messages/${id}/attachments?$select=name,size,isInline,contentType`,
          { headers: H },
        );
        if (ar.ok) {
          const ad = await ar.json();
          attachments = (ad.value ?? [])
            .filter((a: any) => !a.isInline)
            .map((a: any) => ({ name: a.name || "attachment", size: a.size || 0 }));
        }
      }

      const addr = (x: any) => ({
        name: x?.emailAddress?.name || x?.emailAddress?.address || "",
        address: x?.emailAddress?.address || "",
      });
      return json({
        subject: m.subject,
        body: stripSignature(body),
        quoted,
        from: addr(m.from),
        to: (m.toRecipients ?? []).map(addr),
        cc: (m.ccRecipients ?? []).map(addr),
        date: m.sentDateTime || m.receivedDateTime,
        attachments,
        webLink: m.webLink,
      });
    }

    // ---------------- reply-all in thread ----------------
    if (action === "reply") {
      const id = String(payload.id || "");
      const body = String(payload.body || "").trim();
      if (!id || !body) return json({ error: "id and body required" }, 400);
      const html = `<div>${body.replace(/\n/g, "<br>")}</div>${SIGNATURE}`;
      const r = await fetch(`${GRAPH}/me/messages/${id}/replyAll`, {
        method: "POST", headers: H, body: JSON.stringify({ comment: html }),
      });
      if (!r.ok) return json({ error: `graph ${r.status}: ${(await r.text()).slice(0, 300)}` }, 502);
      return json({ ok: true, sent_by: email });
    }

    // ---------------- new message ----------------
    if (action === "send") {
      const to = (payload.to as string[] | undefined) ?? [];
      const cc = (payload.cc as string[] | undefined) ?? [];
      const subject = String(payload.subject || "").trim();
      const body = String(payload.body || "").trim();
      if (!to.length || !subject || !body) {
        return json({ error: "to, subject and body required" }, 400);
      }
      const html = `<div>${body.replace(/\n/g, "<br>")}</div>${SIGNATURE}`;
      const r = await fetch(`${GRAPH}/me/sendMail`, {
        method: "POST", headers: H,
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "HTML", content: html },
            toRecipients: to.map((a) => ({ emailAddress: { address: a } })),
            ccRecipients: cc.map((a) => ({ emailAddress: { address: a } })),
          },
          saveToSentItems: true,
        }),
      });
      if (!r.ok) return json({ error: `graph ${r.status}: ${(await r.text()).slice(0, 300)}` }, 502);
      return json({ ok: true, sent_by: email });
    }

    return json({ error: `unknown action '${action}'` }, 400);
  } catch (e) {
    return json({ error: String(e).slice(0, 400) }, 500);
  }
});
