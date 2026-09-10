// CRM test harness: seeds a stored auth session and stubs the Supabase
// backend (REST + auth + graph-mail edge function) with a STATEFUL in-memory
// store, so created/edited/moved deals survive the app's re-load() calls.

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

// Rows mirror the deals_value view the app reads: the economics columns
// (proposal_fee/options_nte/rate/term_months/ca_fee) plus legacy `amount`,
// which dealValue() still honors as a fallback.
function fixtureDeals() {
  return [
    {
      id: 1, name: 'Dome Repairs', client: 'Dome Condo Assn', project_no: '26-101',
      contact_name: 'Dana Board', contact_email: 'board@dome.com',
      proposal_fee: 48000, options_nte: null, rate: null, rate_unit: null,
      term_months: null, ca_fee: 6000, billed_to_date: null, fee_source: null,
      amount: null, stage: 'Proposal Sent', priority: 'HIGH',
      proposal_sent_date: daysAgo(30), last_contact_date: daysAgo(20),
      next_action: 'Follow up on proposal', next_action_due: today(),
      keywords: ['dome'], dropbox_folder: '/Proposals/Dome', evidence: null,
    },
    {
      id: 2, name: 'Terrazas Facade', client: 'Terrazas HOA', project_no: '26-102',
      contact_name: 'Pat Manager', contact_email: 'pm@terrazas.com',
      proposal_fee: 120000, options_nte: null, rate: null, rate_unit: null,
      term_months: null, ca_fee: null, billed_to_date: null, fee_source: null,
      amount: null, stage: 'Proposal Sent', priority: 'MEDIUM',
      proposal_sent_date: null, last_contact_date: daysAgo(2),
      next_action: null, next_action_due: null,
      keywords: ['terrazas'], dropbox_folder: null, evidence: null,
    },
    {
      id: 3, name: 'North Bay Villas', client: 'NBV Assn', project_no: '26-103',
      contact_name: 'Lee Prez', contact_email: 'prez@nbv.com',
      proposal_fee: 50000, options_nte: null, rate: 1500, rate_unit: 'month',
      // Won, contract value 50000 + 1500x10 = 65000. QuickBooks says 25000 has
      // been invoiced and all 25000 is still open, so A/R is 25000 — NOT the
      // 40000 of unbilled backlog, which is a different figure entirely.
      term_months: 10, ca_fee: null, billed_to_date: 25000, fee_source: null,
      qb_open_balance: 25000, qb_synced_at: '2026-08-30T12:00:00Z',
      amount: null, stage: 'Won', priority: 'LOW',
      proposal_sent_date: daysAgo(60), last_contact_date: daysAgo(5),
      next_action: 'Invoice balance', next_action_due: null,
      keywords: ['north bay'], dropbox_folder: null, evidence: null,
    },
  ];
}

// Rows of deal_documents as the 7am Dropbox sync writes them.
function fixtureDocs() {
  return [
    {
      id: 11, deal_id: 1, file_name: 'Dome Proposal Rev2.pdf', size_bytes: 482000,
      modified_at: '2026-07-10T12:00:00Z', doc_kind: 'proposal', source_year: 2026,
      is_primary: true, is_signed: true, link_kind: 'shared_link',
      url: 'https://www.dropbox.com/scl/fi/abc/Dome%20Proposal%20Rev2.pdf?dl=0',
    },
    {
      id: 12, deal_id: 1, file_name: 'Dome Scope Notes.docx', size_bytes: 24000,
      modified_at: '2026-07-08T12:00:00Z', doc_kind: 'scope', source_year: 2026,
      is_primary: false, is_signed: false, link_kind: 'shared_link',
      url: 'https://www.dropbox.com/scl/fi/def/Dome%20Scope%20Notes.docx?dl=0',
    },
  ];
}

// Stub the whole backend. Returns {captured, state} for assertions.
// opts.dropboxDown simulates the edge function not being deployed.
async function stubBackend(page, opts = {}) {
  const state = { deals: fixtureDeals(), docs: fixtureDocs(), activities: [], nextId: 100,
    qbLinks: opts.qbLinks ? opts.qbLinks.slice() : [],
    syncRuns: opts.syncRuns || [
      { job: 'dropbox_docs', finished_at: new Date(Date.now() - 6 * 36e5).toISOString(), ok: true },
      { job: 'qb_reconcile', finished_at: new Date(Date.now() - 3 * 36e5).toISOString(), ok: true,
        stats: opts.qbStats !== undefined ? opts.qbStats : {
          mode: 'applied', invoices: 198, deals: 129, write_failures: 0,
          findings: {
            stale_won: [
              { id: 3, project_no: '26-103', name: 'North Bay Villas', client: 'NBV Assn',
                proposal_sent_date: '2026-04-28', days: 135 },
            ],
            review: [
              { id: 1, project_no: '26-101', name: 'Dome Repairs', stage: 'Proposal Sent',
                invoices: 1, amount: 3500, why: 'customer-name match only, may include sibling projects' },
            ],
            unmapped: [
              { customer: 'Venetian Manor Condominium Association', invoices: 21, billed: 1290423, open: 0,
                more: 1, detail: [
                  { qb_id: '9001', doc: '5612', date: '2026-02-14', amt: 61000, bal: 0,
                    desc: 'Progress billing, facade restoration', projs: [] },
                ] },
              { customer: 'Bridge Industrial', invoices: 1, billed: 3600, open: 3600,
                more: 0, detail: [
                  { qb_id: '9002', doc: '5741', date: '2026-06-02', amt: 3600, bal: 3600,
                    desc: 'Change of Engineer fee due to structural subconsultant', projs: [] },
                ] },
            ],
            links: [],
          },
        } },
    ] };
  // opts.strandedStage leaves a deal in a stage that has been retired
  if (opts.strandedStage) state.deals[1].stage = opts.strandedStage;
  // opts.paidInFull clears the won deal's invoice in QuickBooks, which should
  // drop it out of A/R without changing its stage. Note billed_to_date stays
  // put: the money was still billed, it has just now been collected.
  if (opts.paidInFull) state.deals[2].qb_open_balance = 0;
  const captured = [];
  /* PostgREST returns ONLY the columns named in select=. Returning every column
     regardless let a real bug through: the app fetched sync_runs without
     `stats`, so the QuickBooks panel had nothing to render, and the suite still
     passed because the stub handed it stats anyway. Project the response to the
     requested columns so a missing one fails here instead of in production. */
  const project = (url, rows) => {
    const sel = new URL(url).searchParams.get('select');
    if (!sel || sel === '*' || !Array.isArray(rows)) return rows;
    const cols = sel.split(',').map((c) => c.trim().split(':').pop()).filter((c) => c && c !== '*');
    return rows.map((r) => Object.fromEntries(
      cols.filter((c) => c in r).map((c) => [c, r[c]])));
  };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/*.supabase.co/**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch (e) {}
    if (method !== 'GET') captured.push({ method, path: url.pathname + url.search, body, headers: req.headers() });

    if (url.pathname.startsWith('/auth/v1/user')) return json(route, { email: 'test@plaza.test' });
    if (url.pathname.startsWith('/auth/v1/token'))
      return json(route, { access_token: 'fake-token-2', refresh_token: 'r2', expires_in: 3600 });
    // graph-mail: opts.sentAttachments names the files the client was emailed.
    // Default: the Rev2 proposal was sent; Rev3 (live-only) never was.
    if (url.pathname.startsWith('/functions/v1/graph-mail')) {
      if (opts.mailDown) return json(route, { error: 'graph unavailable' }, 500);
      const names = opts.sentAttachments === undefined
        ? ['Dome Proposal Rev2.pdf'] : opts.sentAttachments;
      if (body?.action === 'search') {
        if (!names.length) return json(route, []);
        return json(route, [{
          id: 'msg-1', direction: 'out', hasAttachments: true,
          subject: 'Dome proposal', date: '2026-07-11T09:00:00Z',
          to: [{ address: 'board@dome.com' }], preview: 'Attached please find…',
        }]);
      }
      if (body?.action === 'message') {
        return json(route, {
          id: 'msg-1', subject: 'Dome proposal', date: '2026-07-11T09:00:00Z',
          from: { name: 'William', address: 'william@plazaandassociates.com' },
          to: [{ address: 'board@dome.com' }], body: 'Attached please find the proposal.',
          attachments: names.map((n) => ({ name: n, size: 482000 })),
        });
      }
      return json(route, []);
    }
    if (url.pathname.startsWith('/functions/v1/dropbox-files')) {
      if (opts.dropboxDown) return json(route, { error: 'Function not found' }, 404);
      // a boot failure or gateway error answers with plain text, not JSON
      if (opts.dropboxRawError) {
        return route.fulfill({ status: 500, contentType: 'text/plain', body: opts.dropboxRawError });
      }
      if (body?.action === 'list') {
        return json(route, { files: [
          { name: 'Dome Proposal Rev2.pdf', path: '/Proposals/Dome/Dome Proposal Rev2.pdf',
            is_folder: false, size: 482000, modified: '2026-07-10T12:00:00Z', is_pdf: true },
          // present in Dropbox but NOT in the deal_documents snapshot
          { name: 'Dome Proposal Rev3.pdf', path: '/Proposals/Dome/Dome Proposal Rev3.pdf',
            is_folder: false, size: 501000, modified: new Date().toISOString(), is_pdf: true },
          { name: 'Site Photos', path: '/Proposals/Dome/Site Photos',
            is_folder: true, size: null, modified: null, is_pdf: false },
        ] });
      }
      if (body?.action === 'link') return json(route, { url: 'https://dl.example.test/fake' });
      if (body?.action === 'value') {
        // accepts either a path or a shared_url
        if (!body.path && !body.shared_url) return json(route, { error: 'path or shared_url required' }, 400);
        return json(route, { file: 'Dome Proposal Rev2.pdf', candidates: [
          { amount: 52500, context: 'Total lump sum fee for the scope described herein: $52,500.00', score: 4 },
          { amount: 1500, context: 'permit allowance of $1,500', score: -1 },
        ] });
      }
      return json(route, { error: 'unknown action' }, 400);
    }
    // background-sync bookkeeping (migration 008). opts.syncRuns overrides;
    // opts.noSyncTable simulates the migration not having been run yet.
    if (url.pathname.startsWith('/rest/v1/sync_runs')) {
      if (opts.noSyncTable) return json(route, { message: 'relation "sync_runs" does not exist' }, 404);
      if (method === 'POST') { state.syncRuns.unshift({ ...body, id: state.nextId++ }); return json(route, [], 201); }
      return json(route, project(req.url(), state.syncRuns));
    }
    // "Sync now" fires both jobs; qb-reconcile must be stubbed or it reads as a
    // failure. opts.qbSyncFails exercises the one-failed-one-succeeded path.
    if (url.pathname.startsWith('/functions/v1/qb-reconcile')) {
      /* The read-only diagnostic behind "Find invoices". The default answer is
         modelled on the real Terrazas case: the deal's own number appears on no
         invoice, while two invoices for the same client cite a SIBLING project
         number — which is why the money never reached this deal and why the
         unmapped list cannot show it. */
      if (body?.action === 'trace') {
        if (opts.traceFails) return json(route, { error: 'Intuit token rejected' }, 500);
        const hits = opts.traceHits !== undefined ? opts.traceHits : [
          { qb_id: '7755', doc: '5755', date: '2026-05-04', customer: 'NBV Assn',
            total: 6500, balance: 0,
            lines: [{ description: '50% retainer for Proposal 26-101 - aquatic engineering', amount: 6500 }],
            projs_matcher_sees: ['26-101'], projs_anywhere: ['26-101'] },
          { qb_id: '7811', doc: '5811', date: '2026-08-01', customer: 'NBV Assn',
            total: 6500, balance: 0,
            lines: [{ description: 'Remaining balance for Proposal 26-101 - aquatic engineering', amount: 6500 }],
            projs_matcher_sees: ['26-101'], projs_anywhere: ['26-101'] },
        ];
        return json(route, { ok: true, searched: { customer: body.customer, years: [2026, 2025] },
          found: hits.length, invoices: hits });
      }
      if (opts.qbSyncFails) return json(route, { ok: false, error: 'Intuit token rejected' }, 500);
      state.syncRuns.unshift({ job: 'qb_reconcile', finished_at: new Date().toISOString(), ok: true });
      return json(route, { ok: true, stats: { billing_refreshed: 2, stage_changes: 1, invoices: 198 } });
    }
    if (url.pathname.startsWith('/functions/v1/dropbox-docs-sync')) {
      if (opts.dropboxDown) return json(route, { error: 'Function not found' }, 404);
      state.syncRuns.unshift({ job: 'dropbox_docs', finished_at: new Date().toISOString(), ok: true });
      return json(route, { ok: true, stats: { deals_matched: 3, docs_upserted: 5, docs_removed: 0, links_created: 1 } });
    }
    /* Manual invoice → deal overrides (migration 010). opts.noLinkTable
       simulates the migration not having been run: the panel must still work. */
    if (url.pathname.startsWith('/rest/v1/qb_invoice_links')) {
      if (opts.noLinkTable) return json(route, { message: 'relation "qb_invoice_links" does not exist' }, 404);
      if (method === 'POST') {
        state.qbLinks = state.qbLinks.filter((l) => l.qb_invoice_id !== body.qb_invoice_id);
        state.qbLinks.unshift({ ...body });
        return json(route, [body], 201);
      }
      if (method === 'DELETE') {
        const m = url.search.match(/qb_invoice_id=eq\.([^&]+)/);
        if (m) state.qbLinks = state.qbLinks.filter((l) => l.qb_invoice_id !== decodeURIComponent(m[1]));
        return json(route, [], 204);
      }
      return json(route, project(req.url(), state.qbLinks));
    }
    if (url.pathname.startsWith('/rest/v1/deal_documents')) {
      const m = url.search.match(/deal_id=eq\.(\d+)/);
      if (method === 'DELETE') {
        state.docs = state.docs.filter((d) => m && d.deal_id !== +m[1]);
        return json(route, []);
      }
      return json(route, state.docs.filter((d) => !m || d.deal_id === +m[1]));
    }
    if (url.pathname.startsWith('/rest/v1/deal_primary_doc')) {
      const byDeal = {};
      state.docs.forEach((d) => {
        const e = (byDeal[d.deal_id] = byDeal[d.deal_id] || {
          deal_id: d.deal_id, doc_count: 0, signed_count: 0, primary_name: null, primary_url: null });
        e.doc_count++;
        if (d.is_signed) e.signed_count++;
        if (d.is_primary) { e.primary_name = d.file_name; e.primary_url = d.url; }
      });
      return json(route, Object.values(byDeal));
    }

    // reads come from the deals_value view, writes go to the deals table
    if (url.pathname.startsWith('/rest/v1/deals')) {
      const idMatch = url.search.match(/id=eq\.(\d+)/);
      if (method === 'GET') return json(route, state.deals);
      if (method === 'POST') {
        const row = { ...body, id: state.nextId++ };
        state.deals.push(row);
        return json(route, [row], 201);
      }
      if (method === 'PATCH' && idMatch) {
        const d = state.deals.find((x) => x.id === +idMatch[1]);
        if (d) Object.assign(d, body);
        return json(route, d ? [d] : []);
      }
      if (method === 'DELETE' && idMatch) {
        // a real FK would block this while children remain
        if (opts.blockDelete) return json(route, { message: 'update or delete on table "deals" violates foreign key constraint' }, 409);
        state.deals = state.deals.filter((x) => x.id !== +idMatch[1]);
        return json(route, []);
      }
    }
    if (url.pathname.startsWith('/rest/v1/activities')) {
      if (method === 'GET') {
        const m = url.search.match(/deal_id=eq\.(\d+)/);
        return json(route, state.activities.filter((a) => !m || a.deal_id === +m[1]));
      }
      if (method === 'POST') {
        const row = { ...body, id: state.nextId++, occurred_at: new Date().toISOString() };
        state.activities.push(row);
        return json(route, [row], 201);
      }
      if (method === 'DELETE') {
        const m = url.search.match(/deal_id=eq\.(\d+)/);
        state.activities = state.activities.filter((a) => m && a.deal_id !== +m[1]);
        return json(route, []);
      }
    }
    return json(route, []);
  });
  return { captured, state };
}

// Boot the CRM with a valid stored session. Returns collected pageerrors.
async function bootCrm(page, { viewport } = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (viewport) await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    localStorage.setItem('plaza_crm_session', JSON.stringify({
      access_token: 'fake-token', refresh_token: 'r1',
      expires_at: Date.now() + 3600 * 1000,
    }));
  });
  await page.goto('/index.html');
  await page.waitForSelector('#app', { state: 'visible', timeout: 15_000 });
  await page.waitForSelector('.board .card', { timeout: 15_000 });
  return errors;
}

module.exports = { stubBackend, bootCrm, fixtureDeals };
