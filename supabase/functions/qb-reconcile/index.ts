// qb-reconcile — Supabase Edge Function
//
// Server-side replacement for ~/.hermes/scripts/crm_qb_stage_reconcile.py (the
// 07:15 weekday cron on William's Mac). Reads every QuickBooks invoice for the
// current + prior year, matches each to a CRM deal, promotes billed deals to
// Won and refreshes the billing columns the A/R KPI reads. Records the run in
// `sync_runs` so the CRM rail can say when it last succeeded.
//
// Every judgement call here is inherited from the Python script and its reasons
// still hold; the ones that cost real money are restated where they bite.
//
// WHAT MOVED, AND WHAT DELIBERATELY DID NOT
// -----------------------------------------
// * The invoice-line cache is GONE. Python spent ~120 per-invoice GETs (~10
//   min cold) fetching Line[].Description because its query named columns
//   explicitly, and QuickBooks omits Line from a column-projected query.
//   `SELECT *` returns Line inline: two queries, ~7 seconds, no cache to go
//   stale. Do not reintroduce a column list here — it silently empties every
//   description and every invoice stops matching by project number.
// * Fuzzy customer-name matches are still REPORT-ONLY. See matchInvoices().
// * The noise policy is unchanged: a clean run says nothing. Only a real stage
//   change or a failure sends mail.
//
// Triggered two ways, exactly like dropbox-docs-sync:
//   - pg_cron at 07:15 weekdays via net.http_post with X-Sync-Secret
//     (migrations/009_qb_reconcile.sql)
//   - "Sync now" in the CRM with the user's JWT
//
// Body: {"apply": false} forces a dry run (report only, no writes). Default is
// to apply, because the daily job's whole purpose is to write.
//
//
// DEPLOY WITH --no-verify-jwt. pg_cron's net.http_post sends only Content-Type
// and X-Sync-Secret — no Authorization header — so with JWT verification on,
// the API gateway answers UNAUTHORIZED_NO_AUTH_HEADER before this code runs and
// the cron fails silently: pg_cron records "succeeded" (the request was sent),
// the 401 lands in net._http_response, and nothing reads it. That is exactly
// how migration 008's schedule sat broken from the day it shipped until
// 2026-09-08 — the document sync only ever ran when someone clicked "Sync now".
// Authorisation is not weakened by the flag: authorised() below still demands
// the shared secret or a real user JWT.
//   supabase functions deploy <name> --project-ref zhxwkntrndaeqtkmbtsh --no-verify-jwt
// Secrets: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REALM_ID, SYNC_SECRET,
//          QB_ALERT_TO (optional, defaults to William).
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("QBO_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET")!;
const REALM = Deno.env.get("QBO_REALM_ID")!;
const SYNC_SECRET = Deno.env.get("SYNC_SECRET") || "";
const ALERT_TO = (Deno.env.get("QB_ALERT_TO") || "william@plazaandassociates.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const QB_BASE = "https://quickbooks.api.intuit.com/v3/company";
const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

// Recognition set: 'Won-Pending Payment' was retired by migration 005 and must
// never be WRITTEN, but a deal stranded in it by an older run still counts as
// won, so it is not re-promoted. WON_STAGE is the only value this ever writes.
const WON_STAGE = "Won";
const WON_STAGES = new Set(["Won", "Won-Pending Payment"]);

// Deals that must never be auto-promoted even if an invoice appears: blanket /
// umbrella projects where billing is continuous and stage is managed by hand.
const STAGE_PINNED: Record<string, string> = {
  "26021": "ECS Windows blanket SI — always-open, billed per opening",
};

/* Project numbers as Plaza writes them: a 5-digit 2xxxx ("26011") or the older
   year-serial form ("2024-027").

   The (?<!\$) guard is not hypothetical. A line description reading
   "$20000 retainer" matches 2[0-9]\d{3} exactly, and the trace of the Terrazas
   account showed 20000 being picked up as a project-like token from the raw
   record. A dollar sign immediately before the digits never precedes a real
   project number, so refusing that one case costs nothing and stops an amount
   from being read as a project. */
const PROJ_RE = /(?<!\$)\b(2[0-9]\d{3}|20\d{2}-\d{3})\b/g;

/* Leading words too common in South Florida property names to identify a client
   on their own. Used only by the trace's loose customer search. */
const TRACE_GENERIC = new Set([
  "ocean", "bay", "palm", "grand", "north", "south", "east", "west", "park",
  "sunset", "coral", "gables", "beach", "harbour", "harbor", "island", "villas",
  "tower", "towers", "club", "plaza", "point", "pointe", "vista", "marina",
  "bayside", "seaside", "royal", "new", "old",
]);

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

// ---------- QuickBooks OAuth ----------
//
// Intuit ROTATES refresh tokens, so the live one lives in `qb_tokens` and is
// rewritten here, not in a function secret (see migration 009). Two things can
// go wrong and both are handled:
//   * an overlapping run rotated the token between our read and our exchange —
//     re-read and use what it wrote;
//   * we are mid-grace-window on a token Intuit has already superseded — fall
//     back to the previous one.
// Anything else means the 100-day connection has lapsed and a human has to
// reconnect in a browser; say so in those words rather than "401".
let ACCESS: string | null = null;

type TokenRow = {
  realm_id: string; refresh_token: string;
  prev_refresh_token: string | null; refresh_expires_at: string | null;
};

async function tokenRow(): Promise<TokenRow> {
  const rows = await sb(
    `qb_tokens?realm_id=eq.${encodeURIComponent(REALM)}&select=realm_id,refresh_token,prev_refresh_token,refresh_expires_at`);
  const row = rows?.[0];
  if (!row) {
    throw new Error(
      `qb_tokens has no row for realm ${REALM} — seed it once from ~/.env.qbo (see migration 009)`);
  }
  return row;
}

async function exchange(rt: string): Promise<any> {
  const r = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt }),
  });
  const raw = await r.text();
  if (!r.ok) {
    const e: any = new Error(`Intuit token refresh ${r.status}: ${raw.slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
  return JSON.parse(raw);
}

async function qbAccessToken(force = false): Promise<string> {
  if (ACCESS && !force) return ACCESS;
  const row = await tokenRow();
  let used = row.refresh_token;
  let tok: any;
  try {
    tok = await exchange(used);
  } catch (first) {
    // Re-read: a concurrent run may have rotated the token out from under us,
    // in which case the row now holds a token that does work.
    const fresh = await tokenRow();
    const candidates = [fresh.refresh_token, fresh.prev_refresh_token]
      .filter((t): t is string => !!t && t !== used);
    let ok = false;
    for (const c of candidates) {
      try { tok = await exchange(c); used = c; ok = true; break; } catch (_) { /* try next */ }
    }
    if (!ok) {
      throw new Error(
        "QuickBooks refresh token rejected — the connection has lapsed (Intuit " +
        "expires it after 100 days unused) and must be re-authorised in a browser, " +
        `then re-seeded into qb_tokens. Intuit said: ${(first as Error).message}`);
    }
  }

  const patch: Record<string, unknown> = {};
  if (tok.x_refresh_token_expires_in) {
    patch.refresh_expires_at =
      new Date(Date.now() + Number(tok.x_refresh_token_expires_in) * 1000).toISOString();
  }
  if (tok.refresh_token && tok.refresh_token !== used) {
    patch.refresh_token = tok.refresh_token;
    patch.prev_refresh_token = used;
    patch.rotated_at = new Date().toISOString();
  } else if (used !== row.refresh_token) {
    // Recovered on a fallback token: make it the current one so the next run
    // does not repeat the same failed exchange.
    patch.refresh_token = used;
  }
  if (Object.keys(patch).length) {
    await sb(`qb_tokens?realm_id=eq.${encodeURIComponent(REALM)}`,
      { method: "PATCH", body: JSON.stringify(patch) });
  }
  ACCESS = tok.access_token;
  return ACCESS!;
}

async function qbGet(path: string, retry = true): Promise<any> {
  const t = await qbAccessToken();
  const r = await fetch(`${QB_BASE}/${REALM}${path}`, {
    headers: { Authorization: `Bearer ${t}`, Accept: "application/json" },
  });
  if (r.status === 401 && retry) {
    await qbAccessToken(true);
    return qbGet(path, false);
  }
  const raw = await r.text();
  if (!r.ok) throw new Error(`QuickBooks ${path.split("?")[0]} ${r.status}: ${raw.slice(0, 300)}`);
  return JSON.parse(raw);
}

// MAXRESULTS caps at 1000, so page rather than assume Plaza stays under it.
const PAGE = 500;
async function qbQuery(sql: string, entity: string): Promise<any[]> {
  const out: any[] = [];
  for (let start = 1; ; start += PAGE) {
    const q = `${sql} STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
    const d = await qbGet(`/query?query=${encodeURIComponent(q)}`);
    const batch = d?.QueryResponse?.[entity] ?? [];
    out.push(...batch);
    if (batch.length < PAGE) return out;
  }
}

type Inv = {
  id: string; doc: string; date: string; due: string | null;
  amt: number; bal: number; cust: string; projs: string[];
  desc?: string;
  match?: string; confident?: boolean;
  /** Set by a qb_invoice_links row with deal_id NULL: a human declared this
   *  invoice to belong to no CRM deal, so it is neither matched nor reported. */
  suppressed?: boolean;
};

/** A row of qb_invoice_links, keyed by QuickBooks Invoice.Id. See
 *  migrations/010_qb_invoice_links.sql for why the override is per invoice and
 *  not a per-deal alias. */
type Link = { qb_invoice_id: string; deal_id: number | null; reason: string | null };

async function fetchInvoices(years: number[]): Promise<Inv[]> {
  const out: Inv[] = [];
  for (const yr of years) {
    // SELECT * — not a column list. See the header note: a projected query
    // returns no Line, and no Line means no project numbers means no matches.
    const rows = await qbQuery(
      `SELECT * FROM Invoice WHERE TxnDate >= '${yr}-01-01' AND TxnDate <= '${yr}-12-31'`,
      "Invoice");
    for (const i of rows) {
      const desc = (i.Line ?? []).map((l: any) => l.Description || "").join(" ");
      const projs = [...new Set([...desc.matchAll(PROJ_RE)].map((m) => m[1]))].sort();
      out.push({
        id: i.Id, doc: i.DocNumber, date: i.TxnDate, due: i.DueDate ?? null,
        amt: Number(i.TotalAmt ?? 0), bal: Number(i.Balance ?? 0),
        cust: i.CustomerRef?.name ?? "", projs,
        // Kept so the review panel can show what an unmapped invoice is FOR.
        // A doc number and an amount are not enough to decide which deal it
        // belongs to; the line text is the thing a human actually reads.
        desc: desc.replace(/\s+/g, " ").trim().slice(0, 300),
      });
    }
  }
  return out;
}

// ---------- name matching ----------
/** Normalize a client/customer name for fuzzy comparison. */
function norm(s: string | null | undefined): string {
  let t = (s || "").toLowerCase();
  t = t.replace(
    /\b(condominium|condo|association|assoc|inc|llc|ltd|coa|hoa|the|at|of|association's|no|number)\b/g,
    " ");
  t = t.replace(/[^a-z0-9 ]/g, " ");
  return t.split(/\s+/).filter(Boolean).join(" ");
}

/* Python's difflib.SequenceMatcher.ratio(), reimplemented — NOT an approximation.
 * The 0.90 accept threshold and the 0.93 containment boost below were both
 * calibrated against difflib's Ratcliff-Obershelp score on real Plaza customer
 * names; swapping in a different string metric (Levenshtein, Dice) silently
 * moves the line between "review this" and "ignore this".
 * autojunk is not modelled because it only engages past 200 characters and
 * these are normalized company names. */
function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  if (!total) return 1;
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const arr = b2j.get(b[j]);
    if (arr) arr.push(j); else b2j.set(b[j], [j]);
  }
  let matches = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const nextj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        nextj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = nextj2len;
    }
    if (bestsize) {
      matches += bestsize;
      if (alo < besti && blo < bestj) queue.push([alo, besti, blo, bestj]);
      if (besti + bestsize < ahi && bestj + bestsize < bhi) {
        queue.push([besti + bestsize, ahi, bestj + bestsize, bhi]);
      }
    }
  }
  return (2 * matches) / total;
}

/* Containment ("a in b") is only meaningful evidence when the contained string
 * is long enough to be distinctive. The 2026-08-17 run proved the danger: deal
 * 2025-097 "Parker Plaza Estates - PM" has client=="PM", which normalizes to
 * the 2-char token "pm" -- and "pm" is literally a substring of "develoPMent"
 * in "fumoir real estate development". That bare containment check promoted a
 * 0.125 similarity to 0.93 and attributed $210,000 of Fumoir threshold
 * special-inspection billing to a Parker Plaza deal where Plaza never worked.
 * Require a distinctive token, not an initialism, and match on word boundaries
 * so a short token cannot hide inside a longer word. */
const MIN_CONTAINMENT_LEN = 8;
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Returns [byDealId, unmapped].
 *
 * Each matched invoice gains confident=true when it was mapped by project
 * number (authoritative), false when mapped only by fuzzy customer name.
 * CALLERS MUST NOT DRIVE WRITES OFF NON-CONFIDENT INVOICES. Plaza bills the
 * same client across many sibling projects, so a name match sweeps in every
 * sibling's invoices: 26011 Terrazas showed "$409,450 billed" — every Terrazas
 * invoice across the restoration AND the aquatic projects. Plaza's invoices
 * cite "PA Proposal No. 26028" in the line description, so a project-number
 * match is authoritative and self-documenting; only those drive writes.
 *
 * A qb_invoice_links row beats both. It records a human decision — "invoice
 * 5755 is 26014's, whatever its lines say" — and is therefore confident, so it
 * does drive writes. A link with a NULL deal_id declares an invoice to have no
 * CRM deal at all; those are dropped from both maps and stop being reported.
 */
function matchInvoices(invs: Inv[], deals: any[], links: Link[] = []): [Map<number, Inv[]>, Inv[]] {
  const byPn = new Map<string, any>();
  for (const d of deals) {
    const pn = String(d.project_no ?? "").trim();
    if (pn) byPn.set(pn, d);
  }
  const norms = deals.map((d) => [d, norm(d.client), norm(d.name)] as const);
  const byId = new Map<number, any>(deals.map((d) => [d.id, d]));
  const linkByInv = new Map<string, Link>(links.map((l) => [String(l.qb_invoice_id), l]));

  const byDeal = new Map<number, Inv[]>();
  const unmapped: Inv[] = [];
  for (const inv of invs) {
    let deal: any = null;

    /* A manual link outranks everything, including a project number the lines
       do cite. That is the entire point: on the Terrazas invoices the cited
       number is the one that is wrong. A link to a deal that has since been
       deleted falls through to the normal rules rather than dropping the
       invoice — the ON DELETE CASCADE removes the row, but a run that races
       the delete must not lose money. */
    const link = linkByInv.get(String(inv.id));
    if (link) {
      if (link.deal_id === null) { inv.suppressed = true; continue; }
      const target = byId.get(Number(link.deal_id));
      if (target) {
        deal = target;
        inv.match = `manual link${link.reason ? ` — ${link.reason}` : ""}`;
        inv.confident = true;
      }
    }

    if (!deal) {
      for (const p of inv.projs) {
        if (byPn.has(p)) {
          deal = byPn.get(p);
          inv.match = `project_no ${p}`;
          inv.confident = true;
          break;
        }
      }
    }
    if (!deal) {
      const cn = norm(inv.cust);
      let best: any = null, score = 0;
      for (const [d, dc, dn] of norms) {
        for (const cand of [dc, dn]) {
          if (!cand) continue;
          let r = ratio(cn, cand);
          for (const [hay, needle] of [[cn, cand], [cand, cn]] as const) {
            if (needle.length >= MIN_CONTAINMENT_LEN &&
                new RegExp(`\\b${reEsc(needle)}\\b`).test(hay)) {
              r = Math.max(r, 0.93);
              break;
            }
          }
          if (r > score) { best = d; score = r; }
        }
      }
      if (score >= 0.90) {
        deal = best;
        inv.match = `name ~${score.toFixed(2)}`;
        inv.confident = false;
      }
    }
    if (!deal) unmapped.push(inv);
    else {
      const list = byDeal.get(deal.id) ?? [];
      list.push(inv);
      byDeal.set(deal.id, list);
    }
  }
  return [byDeal, unmapped];
}

/** True when a numeric column needs rewriting.
 *
 * PostgREST hands numerics back as floats or strings depending on the column,
 * and null means 'never reconciled' rather than zero — so a plain !== would
 * rewrite every row on every run and make qb_synced_at meaningless. */
function differs(current: unknown, wanted: number): boolean {
  if (current === null || current === undefined) return true;
  const f = Number(current);
  if (!Number.isFinite(f)) return true;
  return Math.abs(f - wanted) > 0.005;
}

// Report-only rounding. Half-up, so a total ending in exactly .50 can print $1
// above what the Python script showed (it inherited Python's round-half-even).
// Nothing written to the database is rounded — billed_to_date and
// qb_open_balance keep full precision.
const money = (n: number) =>
  "$" + Math.round(n).toLocaleString("en-US");

/* Plaza's business day is Miami's, and proposal_sent_date is a bare calendar
 * date with no timezone. Edge functions run in UTC, so taking "today" from the
 * clock would make a 9pm "Sync now" think it is already tomorrow: the 45-day
 * stale-Won cutoff shifts a day, and on New Year's Eve the year pair would skip
 * the prior year entirely and lose every invoice in it. Ask for the Miami date
 * explicitly instead. */
const TZ = "America/New_York";
type Day = { y: number; m: number; d: number };
function todayMiami(): Day {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()).split("-").map(Number);
  return { y, m, d };
}
const daysBetween = (iso: string, today: Day): number | null => {
  const t = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (isNaN(t.getTime())) return null;
  return Math.floor((Date.UTC(today.y, today.m - 1, today.d) - t.getTime()) / 86_400_000);
};

// ---------- the reconcile ----------
async function reconcile(apply: boolean) {
  const today = todayMiami();
  const years = [today.y, today.y - 1];

  const deals: any[] = await sb(
    "deals?select=id,project_no,name,client,stage,next_action," +
    "proposal_sent_date,last_contact_date,billed_to_date,qb_open_balance&order=id");

  /* Manual overrides. A missing table (migration 010 not yet run) must not take
     the whole reconcile down — it degrades to the pre-010 behaviour, which is
     exactly what it did before this existed. */
  let links: Link[] = [];
  try {
    links = await sb("qb_invoice_links?select=qb_invoice_id,deal_id,reason") || [];
  } catch (_) { links = []; }

  const invs = await fetchInvoices(years);
  const [byDeal, unmapped] = matchInvoices(invs, deals, links);
  const dealsById = new Map<number, any>(deals.map((d) => [d.id, d]));

  const drift: any[] = [], review: any[] = [], billing: any[] = [];
  const promoted = new Map<number, { ok: boolean; err: string }>();
  const staleWon: [any, number | null][] = [];

  for (const did of [...byDeal.keys()].sort((a, b) => a - b)) {
    const dinvs = byDeal.get(did)!;
    const d = dealsById.get(did)!;
    const pn = String(d.project_no ?? "").trim();
    if (Object.hasOwn(STAGE_PINNED, pn)) continue;  // hasOwn: a project_no of "constructor" must not read as pinned
    const conf = dinvs.filter((x) => x.confident);
    const fuzzy = dinvs.filter((x) => !x.confident);

    // Only project-number-matched invoices may justify a stage change, and
    // their totals are the only ones quoted as fact.
    const billed = conf.reduce((a, x) => a + x.amt, 0);
    const openbal = conf.reduce((a, x) => a + x.bal, 0);
    const cur = d.stage;

    if (!conf.length) {
      // Fuzzy-only evidence: surface for human review, never write.
      if (!WON_STAGES.has(cur)) {
        review.push({ deal: d, cur, n: fuzzy.length,
          amt: fuzzy.reduce((a, x) => a + x.amt, 0), invs: fuzzy,
          why: "customer-name match only, may include sibling projects" });
      }
      continue;
    }
    // A $0 confident total (voided/placeholder invoice) proves nothing.
    if (billed <= 0) {
      review.push({ deal: d, cur, n: conf.length, amt: 0, invs: conf,
        why: "confident invoices total $0" });
      continue;
    }

    const latest = conf.map((x) => x.date).sort().pop();
    const note = `QB: ${conf.length} invoice(s), ${money(billed)} billed, ` +
      `${money(openbal)} open (latest ${latest}).`;

    // Money is refreshed independently of stage. A deal already marked Won
    // still needs writing when a payment clears, and that must not be skipped
    // just because the stage is already correct.
    if (differs(d.billed_to_date, billed) || differs(d.qb_open_balance, openbal)) {
      billing.push({ deal: d, billed, open: openbal,
        was_billed: d.billed_to_date, was_open: d.qb_open_balance });
    }

    // A confident invoice means Won, full stop — the balance no longer picks
    // between two stages (migration 005). Never downgrade a deal already won.
    if (WON_STAGES.has(cur)) continue;
    const prev = String(d.next_action ?? "").trim();
    const newna = (!prev || prev.includes(note)) ? note : `${note} | prior: ${prev}`.slice(0, 500);
    drift.push({ deal: d, cur, want: WON_STAGE, billed, open: openbal,
      invs: conf, note, newna, fuzzy_ignored: fuzzy.length });
  }

  // STALE WON: marked Won but never billed. Deliberately uses ANY match
  // (confident or fuzzy) to suppress the alarm — some real billing legitimately
  // carries no project number in the line description (Terrazas, UM, Venetian),
  // so demanding a confident match here would cry "never billed" about invoices
  // that plainly exist.
  for (const d of deals) {
    if (WON_STAGES.has(d.stage) && !byDeal.has(d.id)) {
      const age = d.proposal_sent_date ? daysBetween(d.proposal_sent_date, today) : null;
      if (age === null || age > 45) staleWon.push([d, age]);
    }
  }

  if (apply) {
    // A deal can need both a stage move and a billing refresh; collapse them
    // into ONE patch so it cannot be written twice or half-written.
    const bodies = new Map<number, Record<string, unknown>>();
    const nowIso = new Date().toISOString();
    for (const item of drift) {
      const b = bodies.get(item.deal.id) ?? {};
      bodies.set(item.deal.id, { ...b, stage: item.want, next_action: item.newna });
    }
    for (const item of billing) {
      const b = bodies.get(item.deal.id) ?? {};
      bodies.set(item.deal.id, { ...b,
        billed_to_date: item.billed, qb_open_balance: item.open, qb_synced_at: nowIso });
    }
    for (const [did, body] of bodies) {
      try {
        await sb(`deals?id=eq.${did}`, { method: "PATCH", body: JSON.stringify(body) });
        promoted.set(did, { ok: true, err: "" });
      } catch (e) {
        promoted.set(did, { ok: false, err: (e as Error).message.slice(0, 120) });
      }
    }
  }

  return { deals, invs, byDeal, unmapped, drift, review, billing, staleWon,
           promoted, apply, links };
}

// ---------- report (same shape and order as the Python it replaces) ----------
function buildReport(r: any): string[] {
  const mode = r.apply ? "APPLIED" : "DRY RUN";
  const lines: string[] = [];
  const label = (d: any, w = 44) =>
    `${d.project_no || "(no #)"} ${String(d.name ?? "").slice(0, w)}`;

  if (r.drift.length) {
    lines.push(`CRM/QB stage drift — ${r.drift.length} deal(s) billed but not marked Won [${mode}]`);
    for (const item of r.drift) {
      const d = item.deal;
      let tag = "";
      if (r.apply) {
        const hit = r.promoted.get(d.id);
        tag = hit && hit.ok ? " OK" : ` WRITE-FAILED ${hit ? hit.err : "?"}`;
      }
      const extra = item.fuzzy_ignored ? ` (+${item.fuzzy_ignored} name-matched inv ignored)` : "";
      lines.push(`  ${label(d)} · ${item.cur} -> ${item.want}` +
        ` · ${money(item.billed)} billed / ${money(item.open)} open${extra}${tag}`);
      for (const x of item.invs) {
        lines.push(`      inv ${x.doc} ${x.date} ${money(x.amt)}` +
          ` (open ${money(x.bal)}) [${x.match ?? "?"}]`);
      }
    }
  }
  // A billing-only write that failed still has to be visible; the drift block
  // above only tags deals whose STAGE was moving.
  const silentFails = [...r.promoted.entries()]
    .filter(([id, p]: any) => !p.ok && !r.drift.some((x: any) => x.deal.id === id));
  if (silentFails.length) {
    lines.push(`WRITE-FAILED — ${silentFails.length} billing-only update(s) did not save`);
    for (const [id, p] of silentFails) {
      const d = r.deals.find((x: any) => x.id === id);
      lines.push(`  ${d ? label(d) : `deal ${id}`} · ${(p as any).err}`);
    }
  }
  if (r.review.length) {
    lines.push(`NEEDS REVIEW — ${r.review.length} deal(s), evidence too weak to auto-apply`);
    for (const item of r.review) {
      lines.push(`  ${label(item.deal)} · ${item.cur} · ${item.n} inv` +
        ` · ${money(item.amt)} UNVERIFIED · ${item.why}`);
    }
  }
  if (r.unmapped.length) {
    const agg = new Map<string, any[]>();
    for (const x of r.unmapped) {
      const l = agg.get(x.cust) ?? []; l.push(x); agg.set(x.cust, l);
    }
    lines.push(`QB invoices with no CRM deal — ${r.unmapped.length} invoice(s), ${agg.size} customer(s)`);
    const sorted = [...agg.entries()].sort((a, b) =>
      b[1].reduce((s: number, i: any) => s + i.amt, 0) - a[1].reduce((s: number, i: any) => s + i.amt, 0));
    for (const [cust, xs] of sorted) {
      const tot = xs.reduce((s: number, i: any) => s + i.amt, 0);
      const ob = xs.reduce((s: number, i: any) => s + i.bal, 0);
      lines.push(`  ${cust.slice(0, 52)} · ${xs.length} inv · ${money(tot)} billed / ${money(ob)} open`);
    }
  }
  if (r.staleWon.length) {
    lines.push(`Marked Won but NEVER billed — ${r.staleWon.length} deal(s)`);
    for (const [d, age] of r.staleWon.slice(0, 12)) {
      lines.push(`  ${label(d, 46)} · ${d.stage} · proposal ${d.proposal_sent_date || "n/a"}` +
        (age ? ` (${age}d)` : ""));
    }
  }
  // Billing refresh goes LAST on purpose, as in the Python: payments clear
  // constantly and are not news. Only stage changes are.
  if (r.billing.length) {
    const tb = r.billing.reduce((a: number, x: any) => a + x.billed, 0);
    const to = r.billing.reduce((a: number, x: any) => a + x.open, 0);
    lines.push(`Billing refreshed from QB — ${r.billing.length} deal(s), ` +
      `${money(tb)} billed / ${money(to)} open [${mode}]`);
    for (const item of r.billing.slice(0, 15)) {
      const was = item.was_billed === null || item.was_billed === undefined
        ? "never synced" : `was ${money(Number(item.was_billed))}`;
      lines.push(`  ${label(item.deal)} · billed ${money(item.billed)} (${was})` +
        ` · open ${money(item.open)}`);
    }
  }
  return lines;
}

// ---------- alerting ----------
/* The Mac wrapper's noise policy, preserved: a normal run is SILENT. Payments
 * clearing and unmapped historical invoices are not news. Mail goes out only
 * when a stage actually moved, a write failed, or the run died. */
const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* graph-mail drops the body into HTML and turns newlines into <br>, so the
 * report's leading indentation would collapse and its invoice detail would run
 * together. Escape it and hold the indent open with &nbsp;. */
async function alert(subject: string, lines: string[]) {
  if (!ALERT_TO.length || !SYNC_SECRET) return;
  const body = lines
    .map((l) => escHtml(l).replace(/^ +/, (m) => "&nbsp;".repeat(m.length)))
    .join("\n");
  try {
    await fetch(`${SB_URL}/functions/v1/graph-mail`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // graph-mail keeps verify_jwt on — it reads a mailbox — so the API
        // gateway demands a JWT before our code is ever reached. The anon key
        // gets us past the gateway; X-Sync-Secret is what graph-mail itself
        // checks, and it is the one that actually authorises the send.
        apikey: SB_ANON,
        Authorization: `Bearer ${SB_ANON}`,
        "X-Sync-Secret": SYNC_SECRET,
      },
      body: JSON.stringify({ action: "send", to: ALERT_TO, subject, body }),
    });
  } catch (_) { /* an alert that cannot be sent must not fail the sync */ }
}

async function recordRun(started: string, ok: boolean, stats: unknown, error: string | null) {
  try {
    await sb("sync_runs", {
      method: "POST",
      body: JSON.stringify({ job: "qb_reconcile", started_at: started,
        finished_at: new Date().toISOString(), ok, stats, error }),
    });
  } catch (_) { /* a missing sync_runs table must not fail the sync itself */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await authorised(req))) return json({ error: "Unauthorized" }, 401);

  const payload = await req.json().catch(() => ({}));

  /* Diagnostic. Answers "this WAS billed, why does the CRM say it was not" by
     showing the raw invoice as QuickBooks holds it — every line description,
     both memo fields, and any project-like token found anywhere in the record —
     rather than only the fields the matcher happens to read. Read-only.

       {"action":"trace","project_no":"26014"}      search everywhere for a token
       {"action":"trace","customer":"terrazas"}     dump a customer's invoices

     Also the CRM's "Find invoices" button on a Won-but-never-invoiced row: it
     traces the deal's client name so the invoice can be found and linked even
     when it is already matched — wrongly — to another deal, which is precisely
     the case the unmapped list cannot show.
  */
  if (payload?.action === "trace") {
    const want = String(payload.project_no || "").trim();
    const cust = String(payload.customer || "").trim().toLowerCase();
    /* Customer matching here is deliberately loose, and must stay that way.
       This is a read-only diagnostic a human reads: showing a few invoices that
       turn out to belong to a sibling costs a glance, whereas showing none
       looks like proof the work was never billed — which is the exact wrong
       answer, and the one that sent this search back empty the first time.

       A plain substring test fails on the common shape: the CRM holds "Terrazas
       River Park Village Condominium Association" and QuickBooks holds a
       shorter or differently-suffixed name, so neither contains the other in
       full. Test containment BOTH ways, then again after norm() has stripped
       the condominium/association/LLC noise, then fall back to a shared leading
       word — which is what actually distinguishes one client from the next. */
    const custMatches = (qbName: string): boolean => {
      const a = qbName.toLowerCase();
      if (!cust) return false;
      if (a.includes(cust) || cust.includes(a)) return true;
      const na = norm(qbName), nb = norm(cust);
      if (na && nb && (na.includes(nb) || nb.includes(na))) return true;
      const wa = na.split(" ").filter(Boolean), wb = nb.split(" ").filter(Boolean);
      if (!(wa[0] && wa[0] === wb[0] && wa[0].length >= 4)) return false;
      /* A shared leading word only identifies a client when the word is
         distinctive. Miami condominium names are built out of the same scenery
         — "Ocean Reef Club" and "Ocean View Towers" are unrelated clients — so
         a generic first word has to be backed by a second one. */
      if (!TRACE_GENERIC.has(wa[0])) return true;
      return !!(wa[1] && wa[1] === wb[1]);
    };
    if (!want && !cust) return json({ error: "project_no or customer required" }, 400);
    const yrs = Array.isArray(payload.years) && payload.years.length
      ? payload.years.map(Number)
      : [new Date().getFullYear(), new Date().getFullYear() - 1];

    const hits: any[] = [];
    for (const yr of yrs) {
      const rows = await qbQuery(
        `SELECT * FROM Invoice WHERE TxnDate >= '${yr}-01-01' AND TxnDate <= '${yr}-12-31'`,
        "Invoice");
      for (const i of rows) {
        const blob = JSON.stringify(i);
        const custName = i.CustomerRef?.name ?? "";
        /* Search the WHOLE record, not just the fields the matcher reads: that
           is the point of the trace. */
        const matched = (want && blob.includes(want)) || custMatches(custName);
        if (!matched) continue;
        const lines = (i.Line ?? [])
          .filter((l: any) => l.DetailType !== "SubTotalLineDetail")
          .map((l: any) => ({ description: l.Description ?? null, amount: Number(l.Amount ?? 0) }));
        const desc = lines.map((l: any) => l.description || "").join(" ");
        hits.push({
          // Invoice.Id, not DocNumber: it is the key qb_invoice_links uses, so
          // the CRM can offer "link this one" straight off a trace result.
          qb_id: i.Id,
          doc: i.DocNumber, date: i.TxnDate, customer: custName,
          total: Number(i.TotalAmt ?? 0), balance: Number(i.Balance ?? 0),
          lines,
          private_note: i.PrivateNote ?? null,
          customer_memo: i.CustomerMemo?.value ?? null,
          /* What the matcher currently sees (line descriptions only) versus
             what a project-like token search finds across the whole record. */
          projs_matcher_sees: [...new Set([...desc.matchAll(PROJ_RE)].map((m) => m[1]))].sort(),
          projs_anywhere: [...new Set([...blob.matchAll(PROJ_RE)].map((m) => m[1]))].sort(),
        });
      }
    }
    return json({ ok: true, searched: { project_no: want || null, customer: cust || null, years: yrs },
                  found: hits.length, invoices: hits });
  }

  const apply = payload?.apply !== false;
  const started = new Date().toISOString();

  try {
    const r = await reconcile(apply);
    const report = buildReport(r);
    const failed = [...r.promoted.values()].filter((p: any) => !p.ok).length;
    const stats = {
      mode: apply ? "applied" : "dry_run",
      invoices: r.invs.length,
      deals: r.deals.length,
      stage_changes: r.drift.length,
      billing_refreshed: r.billing.length,
      needs_review: r.review.length,
      unmapped_invoices: r.unmapped.length,
      manual_links: r.links.length,
      stale_won: r.staleWon.length,
      write_failures: failed,
      report,
      /* Structured twin of `report`. The text array is for the alert email and
         a human reading the row; the CRM's QuickBooks panel renders from these
         instead, because parsing prose in the UI breaks the moment a wording
         changes. Trimmed to what the panel shows — full detail stays in the
         alert. */
      findings: {
        stale_won: r.staleWon.map(([d, age]: any) => ({
          id: d.id, project_no: d.project_no, name: d.name, client: d.client,
          proposal_sent_date: d.proposal_sent_date, days: age,
        })),
        review: r.review.map((x: any) => ({
          id: x.deal.id, project_no: x.deal.project_no, name: x.deal.name,
          stage: x.cur, invoices: x.n, amount: x.amt, why: x.why,
        })),
        unmapped: (() => {
          type Row = {
            customer: string; invoices: number; billed: number; open: number;
            detail: any[]; more: number;
          };
          const byCust = new Map<string, Row>();
          for (const inv of r.unmapped as any[]) {
            const k = String(inv.cust || "(no customer)");
            const e = byCust.get(k) ??
              { customer: k, invoices: 0, billed: 0, open: 0, detail: [], more: 0 };
            e.invoices++; e.billed += Number(inv.amt) || 0; e.open += Number(inv.bal) || 0;
            e.detail.push({
              qb_id: inv.id, doc: inv.doc, date: inv.date,
              amt: Number(inv.amt) || 0, bal: Number(inv.bal) || 0,
              // The trimmed line text. Without it the review panel can only
              // offer "invoice 5741, $5,700" and nobody can tell which deal
              // that is; with it the answer is usually obvious on sight.
              desc: String(inv.desc || "").slice(0, 160),
              projs: inv.projs || [],
            });
            byCust.set(k, e);
          }
          /* Every unmapped invoice is individually linkable from the panel, so
             the detail has to be here — but stats is a jsonb column written on
             every run and kept forever, and the historic book has hundreds of
             these. Cap per customer, biggest open balance first (the ones that
             cost money to ignore), and say how many were withheld. */
          const CAP = 20;
          for (const e of byCust.values()) {
            e.detail.sort((a, b) => b.bal - a.bal || (a.date < b.date ? 1 : -1));
            if (e.detail.length > CAP) {
              e.more = e.detail.length - CAP;
              e.detail = e.detail.slice(0, CAP);
            }
          }
          return [...byCust.values()].sort((a, b) => b.open - a.open || b.billed - a.billed);
        })(),
        /* Manual overrides in force, so the panel can show what has been
           corrected by hand and let it be undone. Attribution matters here:
           these are the numbers no invoice text supports. */
        links: (r.links as Link[]).map((l) => {
          const inv = (r.invs as Inv[]).find((x) => String(x.id) === String(l.qb_invoice_id));
          const d = (r.deals as any[]).find((x) => x.id === l.deal_id);
          return {
            qb_invoice_id: l.qb_invoice_id,
            doc: inv?.doc ?? null,
            date: inv?.date ?? null,
            amt: inv?.amt ?? null,
            bal: inv?.bal ?? null,
            deal_id: l.deal_id,
            project_no: d?.project_no ?? null,
            deal_name: d?.name ?? null,
            reason: l.reason ?? null,
            // A link whose invoice is outside the two-year window, or whose
            // deal was deleted, is dead weight — say so rather than showing a
            // row of nulls.
            stale: !inv ? "invoice not in range" : (l.deal_id !== null && !d ? "deal missing" : null),
          };
        }),
      },
    };
    await recordRun(started, failed === 0, stats, failed ? `${failed} write(s) failed` : null);

    if (failed) {
      await alert("CRM/QB reconcile — WRITE FAILURES", report);
    } else if (r.drift.length && apply) {
      await alert(`CRM stages corrected from QuickBooks — ${r.drift.length} deal(s)`, report);
    }
    return json({ ok: failed === 0, stats });
  } catch (e) {
    const msg = (e as Error).message;
    await recordRun(started, false, null, msg);
    await alert("CRM/QB reconcile ERROR", [msg]);
    return json({ ok: false, error: msg }, 500);
  }
});
