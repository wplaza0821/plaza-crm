// CRM test harness: seeds a stored auth session and stubs the Supabase
// backend (REST + auth + graph-mail edge function) with a STATEFUL in-memory
// store, so created/edited/moved deals survive the app's re-load() calls.

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

function fixtureDeals() {
  return [
    {
      id: 1, name: 'Dome Repairs', client: 'Dome Condo Assn', project_no: '26-101',
      contact_name: 'Dana Board', contact_email: 'board@dome.com',
      amount: 48000, value_note: null, stage: 'Proposal Sent', priority: 'HIGH',
      proposal_sent_date: daysAgo(30), last_contact_date: daysAgo(20),
      next_action: 'Follow up on proposal', next_action_due: today(),
      keywords: ['dome'], dropbox_folder: null, evidence: null,
    },
    {
      id: 2, name: 'Terrazas Facade', client: 'Terrazas HOA', project_no: '26-102',
      contact_name: 'Pat Manager', contact_email: 'pm@terrazas.com',
      amount: 120000, value_note: 'estimate', stage: 'Lead', priority: 'MEDIUM',
      proposal_sent_date: null, last_contact_date: daysAgo(2),
      next_action: null, next_action_due: null,
      keywords: ['terrazas'], dropbox_folder: null, evidence: null,
    },
    {
      id: 3, name: 'North Bay Villas', client: 'NBV Assn', project_no: '26-103',
      contact_name: 'Lee Prez', contact_email: 'prez@nbv.com',
      amount: 65000, value_note: null, stage: 'Won-Pending Payment', priority: 'LOW',
      proposal_sent_date: daysAgo(60), last_contact_date: daysAgo(5),
      next_action: 'Invoice', next_action_due: null,
      keywords: ['north bay'], dropbox_folder: null, evidence: null,
    },
  ];
}

// Stub the whole backend. Returns {captured, state} for assertions.
async function stubBackend(page) {
  const state = { deals: fixtureDeals(), activities: [], nextId: 100 };
  const captured = [];
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/*.supabase.co/**', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch (e) {}
    if (method !== 'GET') captured.push({ method, path: url.pathname + url.search, body });

    if (url.pathname.startsWith('/auth/v1/user')) return json(route, { email: 'test@plaza.test' });
    if (url.pathname.startsWith('/auth/v1/token'))
      return json(route, { access_token: 'fake-token-2', refresh_token: 'r2', expires_in: 3600 });
    if (url.pathname.startsWith('/functions/v1/graph-mail')) return json(route, []);

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
