// Functional suite: boot, every view, deal create/edit, drag-and-drop stage
// moves, and manual activity logging — all against the stubbed backend.
const { test, expect } = require('@playwright/test');
const { stubBackend, bootCrm } = require('./helpers');

test('boots from stored session: KPIs, board, nav counts', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  await expect(page.locator('.kpi')).toHaveCount(4);
  await expect(page.locator('.board .col')).toHaveCount(6);
  await expect(page.locator('.card', { hasText: 'Dome Repairs' })).toBeVisible();
  await expect(page.locator('#c-pipeline')).toHaveText('3');
  expect(errors).toEqual([]);
});

test('every view renders without errors', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  for (const v of ['deals', 'tasks', 'contacts', 'forecast', 'ar', 'pipeline']) {
    await page.locator(`#nav a[data-v="${v}"]`).click();
    await expect(page.locator('#view')).not.toBeEmpty();
  }
  expect(errors).toEqual([]);
});

test('creates a deal from the New deal form', async ({ page }) => {
  const { captured } = await stubBackend(page);
  const errors = await bootCrm(page);
  await page.locator('#ndBtn').click();
  await expect(page.locator('.drawer h2')).toHaveText('New deal');
  await page.locator('#dfName').fill('Test Tower Assessment');
  await page.locator('#dfClient').fill('Test Tower Assn');
  await page.locator('#dfFee').fill('25000');
  await page.locator('#dfStage').selectOption('Negotiation');
  await page.locator('.drawer button.pri', { hasText: 'Create deal' }).click();
  await expect(page.locator('#toast')).toHaveText('Deal created');
  const post = captured.find((c) => c.method === 'POST' && c.path.startsWith('/rest/v1/deals'));
  expect(post).toBeTruthy();
  expect(post.body.name).toBe('Test Tower Assessment');
  expect(post.body.proposal_fee).toBe(25000);
  expect(post.body.stage).toBe('Negotiation');
  // audit trail row for the create
  expect(captured.some((c) => c.path.startsWith('/rest/v1/activities') && c.body?.kind === 'created')).toBe(true);
  // drawer stays open on the new record's Edit tab; board shows the new card
  await expect(page.locator('.drawer .tab.on')).toHaveText('Edit');
  await page.locator('.drawer .x').click();
  await expect(page.locator('.card', { hasText: 'Test Tower Assessment' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('edits an existing deal via the Edit tab', async ({ page }) => {
  const { captured } = await stubBackend(page);
  const errors = await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Edit' }).click();
  await expect(page.locator('#dfName')).toHaveValue('Dome Repairs');
  await page.locator('#dfNAct').fill('Send revised proposal');
  await page.locator('.drawer button.pri', { hasText: 'Save changes' }).click();
  await expect(page.locator('#toast')).toHaveText('Deal updated');
  const patch = captured.find((c) => c.method === 'PATCH' && c.path.includes('/rest/v1/deals?id=eq.1'));
  expect(patch).toBeTruthy();
  expect(patch.body.next_action).toBe('Send revised proposal');
  // money is owned solely by the economics block — the edit form must not
  // carry (and therefore cannot silently blank) any fee column
  for (const k of ['proposal_fee', 'options_nte', 'rate', 'term_months', 'ca_fee', 'amount']) {
    expect(patch.body).not.toHaveProperty(k);
  }
  expect(errors).toEqual([]);
});

test('economics block still saves fees and drives the board total', async ({ page }) => {
  const { captured } = await stubBackend(page);
  const errors = await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('#edFee').fill('60000');
  await page.locator('#edCa').fill('5000');
  await page.locator('.drawer button', { hasText: 'Save economics' }).click();
  await expect.poll(() => captured.some((c) => c.method === 'PATCH' && c.body?.proposal_fee === 60000)).toBe(true);
  const patch = captured.find((c) => c.method === 'PATCH' && c.body?.proposal_fee === 60000);
  expect(patch.body.ca_fee).toBe(5000);
  // card + column reflect fee + CA
  await page.locator('.drawer .x').click();
  await expect(page.locator('.card', { hasText: 'Dome Repairs' })).toContainText('$65,000');
  expect(errors).toEqual([]);
});

test('recurring deal value counts rate x term on the card', async ({ page }) => {
  await stubBackend(page);
  await bootCrm(page);
  // North Bay: 50,000 fee + 1,500/mo x 10mo = 65,000
  await expect(page.locator('.card', { hasText: 'North Bay Villas' })).toContainText('$65,000');
});

test('drag-and-drop moves a deal to another stage and logs it', async ({ page }) => {
  const { captured } = await stubBackend(page);
  const errors = await bootCrm(page);
  const card = page.locator('.card', { hasText: 'Dome Repairs' });
  const target = page.locator('.col', { has: page.locator('.col-h .t', { hasText: 'Negotiation' }) });
  await card.dragTo(target);
  await expect(page.locator('#toast')).toContainText('Negotiation');
  const patch = captured.find((c) => c.method === 'PATCH' && c.path.includes('/rest/v1/deals?id=eq.1'));
  expect(patch).toBeTruthy();
  expect(patch.body.stage).toBe('Negotiation');
  const act = captured.find((c) => c.path.startsWith('/rest/v1/activities') && c.body?.kind === 'stage_change');
  expect(act).toBeTruthy();
  expect(act.body.summary).toContain('Proposal Sent -> Negotiation');
  // card now lives in the Negotiation column
  await expect(target.locator('.card', { hasText: 'Dome Repairs' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('logs a call from the Activity tab and bumps last contact', async ({ page }) => {
  const { captured } = await stubBackend(page);
  const errors = await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Activity log' }).click();
  await page.locator('#nk').selectOption('call');
  await expect(page.locator('#nlc')).toBeChecked(); // calls default to counting as contact
  await page.locator('#nb').fill('Called Dana — board votes Thursday');
  await page.locator('.drawer button', { hasText: 'Log activity' }).click();
  await expect(page.locator('.act .ak', { hasText: 'call' })).toBeVisible();
  const act = captured.find((c) => c.path.startsWith('/rest/v1/activities') && c.body?.kind === 'call');
  expect(act).toBeTruthy();
  const bump = captured.find((c) => c.method === 'PATCH' && c.path.includes('deals?id=eq.1') && c.body?.last_contact_date);
  expect(bump).toBeTruthy();
  expect(errors).toEqual([]);
});

test('plain note does not bump last contact by default', async ({ page }) => {
  const { captured } = await stubBackend(page);
  await bootCrm(page);
  await page.locator('.card', { hasText: 'Terrazas Facade' }).click();
  await page.locator('.drawer .tab', { hasText: 'Activity log' }).click();
  await expect(page.locator('#nlc')).not.toBeChecked();
  await page.locator('#nb').fill('Internal note');
  await page.locator('.drawer button', { hasText: 'Log activity' }).click();
  await expect(page.locator('.act .ak', { hasText: 'note' })).toBeVisible();
  expect(captured.some((c) => c.method === 'PATCH' && c.body?.last_contact_date)).toBe(false);
});

test('Files tab is gone; Documents is the single Dropbox surface', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await expect(page.locator('.drawer .tab', { hasText: 'Files' })).toHaveCount(0);
  await expect(page.locator('.drawer .tab', { hasText: 'Documents' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Documents rows offer Scan for fee on PDFs only', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Documents' }).click();
  await expect(page.locator('.drawer .act', { hasText: 'Dome Proposal Rev2.pdf' })).toBeVisible();
  // the PDF gets a scan button; the .docx row does not
  await expect(page.locator('.drawer button', { hasText: 'Scan for fee' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('scanning a document routes the amount to Design or CA fee', async ({ page }) => {
  const { captured } = await stubBackend(page);
  const errors = await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Documents' }).click();
  await page.locator('.drawer button', { hasText: 'Scan for fee' }).click();
  await expect(page.locator('#scanout')).toContainText('$52,500');
  await expect(page.locator('#scanout')).toContainText('lump sum fee');
  // both phase targets are offered
  await expect(page.locator('#scanout button', { hasText: '→ Design fee' }).first()).toBeVisible();
  await expect(page.locator('#scanout button', { hasText: '→ CA fee' }).first()).toBeVisible();
  await page.locator('#scanout button', { hasText: '→ Design fee' }).first().click();
  await expect(page.locator('#toast')).toContainText('$52,500');
  const patch = captured.find((c) => c.method === 'PATCH' && c.body?.proposal_fee === 52500);
  expect(patch).toBeTruthy();
  expect(patch.body.fee_source).toBe('Dome Proposal Rev2.pdf');
  expect(patch.body.fee_verified_at).toBeTruthy();
  await expect(page.locator('#edFee')).toHaveValue('52500');
  expect(errors).toEqual([]);
});

test('scanning can route an amount to the CA phase instead', async ({ page }) => {
  const { captured } = await stubBackend(page);
  await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Documents' }).click();
  await page.locator('.drawer button', { hasText: 'Scan for fee' }).click();
  await page.locator('#scanout button', { hasText: '→ CA fee' }).first().click();
  const patch = captured.find((c) => c.method === 'PATCH' && c.body?.ca_fee === 52500);
  expect(patch).toBeTruthy();
  // fee_source describes the proposal fee, so a CA write must not claim it
  expect(patch.body.fee_source).toBeUndefined();
});

test('live Dropbox check flags files missing from the 7am snapshot', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Documents' }).click();
  await page.locator('.drawer button', { hasText: 'Check Dropbox now' }).click();
  // stub folder holds the known proposal plus one newer file
  await expect(page.locator('#livedocs')).toContainText('not yet in the 7am sync');
  await expect(page.locator('#livedocs')).toContainText('Dome Proposal Rev3.pdf');
  expect(errors).toEqual([]);
});

test('live check degrades gracefully when the function is unavailable', async ({ page }) => {
  await stubBackend(page, { dropboxDown: true });
  await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Documents' }).click();
  await page.locator('.drawer button', { hasText: 'Check Dropbox now' }).click();
  await expect(page.locator('#livedocs')).toContainText('needs the dropbox-files function deployed');
  // the snapshot list must survive a failed live check
  await expect(page.locator('.drawer .act', { hasText: 'Dome Proposal Rev2.pdf' })).toBeVisible();
});

test('value splits into Design and CA phases', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  // Dome: 48,000 design fee + 6,000 CA
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  const econ = page.locator('.drawer .callout', { hasText: 'Deal economics' });
  await expect(econ).toContainText('$48,000');
  await expect(econ).toContainText('$6,000');
  await expect(econ).toContainText('$54,000');
  await page.locator('.drawer .x').click();
  // table view carries Design / CA / Value columns
  await page.locator('#nav a[data-v="deals"]').click();
  const head = page.locator('#view thead');
  await expect(head).toContainText('Design');
  await expect(head).toContainText('CA');
  // forecast splits by phase too
  await page.locator('#nav a[data-v="forecast"]').click();
  await expect(page.locator('#view thead')).toContainText('Design');
  expect(errors).toEqual([]);
});

test('recurring CA rate x term lands in the CA phase, not Design', async ({ page }) => {
  await stubBackend(page);
  await bootCrm(page);
  // North Bay: 50,000 design + (1,500/mo x 10mo) = 15,000 CA
  await page.locator('.card', { hasText: 'North Bay Villas' }).click();
  const econ = page.locator('.drawer .callout', { hasText: 'Deal economics' });
  await expect(econ).toContainText('$50,000');
  await expect(econ).toContainText('$15,000');
  await expect(econ).toContainText('$65,000');
});

test('Documents badges the revision the client actually received', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Documents' }).click();
  const row = page.locator('.drawer .act', { hasText: 'Dome Proposal Rev2.pdf' });
  await expect(row).toContainText('SENT 2026-07-11');
  await expect(row).toContainText('LATEST SENT');
  await expect(page.locator('#tabbody')).toContainText('Latest sent to client');
  expect(errors).toEqual([]);
});

test('an unsent PDF is flagged NOT SENT and its fee scan is blocked', async ({ page }) => {
  // nothing was ever emailed, so no document may be scanned
  await stubBackend(page, { sentAttachments: [] });
  const errors = await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Documents' }).click();
  const row = page.locator('.drawer .act', { hasText: 'Dome Proposal Rev2.pdf' });
  await expect(row).toContainText('NOT SENT');
  await expect(page.locator('.drawer button', { hasText: 'Scan for fee' })).toHaveCount(0);
  await expect(page.locator('.drawer button', { hasText: 'Scan blocked' })).toHaveCount(1);
  await expect(page.locator('#tabbody')).toContainText('Nothing sent yet');
  expect(errors).toEqual([]);
});

test('a sent PDF stays scannable', async ({ page }) => {
  await stubBackend(page);
  await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Documents' }).click();
  await expect(page.locator('.drawer button', { hasText: 'Scan for fee' })).toHaveCount(1);
  await expect(page.locator('.drawer button', { hasText: 'Scan blocked' })).toHaveCount(0);
});

test('send status degrades to a notice when Graph is unavailable', async ({ page }) => {
  await stubBackend(page, { mailDown: true });
  await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Documents' }).click();
  await expect(page.locator('#tabbody')).toContainText('Send status unavailable');
  // documents still list, and an unverifiable send status must not block scanning
  await expect(page.locator('.drawer .act', { hasText: 'Dome Proposal Rev2.pdf' })).toBeVisible();
  await expect(page.locator('.drawer button', { hasText: 'Scan blocked' })).toHaveCount(0);
});

test('RFP Received is gone from the pipeline', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  await expect(page.locator('.board .col')).toHaveCount(6);
  await expect(page.locator('.board .col-h .t', { hasText: 'RFP Received' })).toHaveCount(0);
  // and it is not offerable on a new deal
  await page.locator('#ndBtn').click();
  const opts = await page.locator('#dfStage option').allTextContents();
  expect(opts.some((o) => o.includes('RFP Received'))).toBe(false);
  expect(errors).toEqual([]);
});

test('a deal stranded in a retired stage stays visible and keeps its stage', async ({ page }) => {
  const { captured } = await stubBackend(page, { strandedStage: 'RFP Received' });
  const errors = await bootCrm(page);
  // the retired column reappears only because a deal is still in it
  const col = page.locator('.board .col', { has: page.locator('.col-h .t', { hasText: 'RFP Received' }) });
  await expect(col).toBeVisible();
  await expect(col.locator('.card', { hasText: 'Terrazas Facade' })).toBeVisible();
  // saving an unrelated field must not silently reassign the stage
  await page.locator('.card', { hasText: 'Terrazas Facade' }).click();
  await expect(page.locator('#edStage')).toHaveValue('RFP Received');
  await page.locator('.drawer button', { hasText: 'Save' }).first().click();
  await expect.poll(() => captured.some((c) => c.method === 'PATCH' && c.body?.stage)).toBe(true);
  const patch = captured.find((c) => c.method === 'PATCH' && c.body?.stage);
  expect(patch.body.stage).toBe('RFP Received');
  expect(errors).toEqual([]);
});

test('delete requires typing the deal name', async ({ page }) => {
  const { captured } = await stubBackend(page);
  const errors = await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Edit' }).click();
  await page.locator('#dzStart').click();
  const go = page.locator('#dzGo');
  await expect(go).toBeDisabled();
  await page.locator('#dzName').fill('Dome Repair');   // one char short
  await expect(go).toBeDisabled();
  await page.locator('#dzName').fill('Dome Repairs');
  await expect(go).toBeEnabled();
  // nothing destructive has been sent while confirming
  expect(captured.some((c) => c.method === 'DELETE')).toBe(false);
  expect(errors).toEqual([]);
});

test('deleting removes the deal and its children, then refreshes the board', async ({ page }) => {
  const { captured, state } = await stubBackend(page);
  const errors = await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Edit' }).click();
  await page.locator('#dzStart').click();
  await page.locator('#dzName').fill('Dome Repairs');
  await page.locator('#dzGo').click();
  await expect(page.locator('#toast')).toContainText('Deleted Dome Repairs');
  // children go first, then the deal itself
  const dels = captured.filter((c) => c.method === 'DELETE').map((c) => c.path);
  expect(dels.some((p) => p.startsWith('/rest/v1/activities'))).toBe(true);
  expect(dels.some((p) => p.startsWith('/rest/v1/deal_documents'))).toBe(true);
  expect(dels[dels.length - 1]).toContain('/rest/v1/deals?id=eq.1');
  expect(state.deals.some((d) => d.id === 1)).toBe(false);
  // drawer closes and the card is gone from the board
  await expect(page.locator('.drawer')).not.toHaveClass(/\bon\b/);
  await expect(page.locator('.card', { hasText: 'Dome Repairs' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('cancel leaves the deal untouched', async ({ page }) => {
  const { captured } = await stubBackend(page);
  await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Edit' }).click();
  await page.locator('#dzStart').click();
  await page.locator('#dzName').fill('Dome Repairs');
  await page.locator('.drawer button', { hasText: 'Cancel' }).click();
  await expect(page.locator('#dzStart')).toBeVisible();
  expect(captured.some((c) => c.method === 'DELETE')).toBe(false);
});

test('a failed delete surfaces the error and keeps the deal', async ({ page }) => {
  await stubBackend(page, { blockDelete: true });
  await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Edit' }).click();
  await page.locator('#dzStart').click();
  await page.locator('#dzName').fill('Dome Repairs');
  await page.locator('#dzGo').click();
  await expect(page.locator('#dzst')).toContainText('foreign key constraint');
  // the drawer stays open and the deal is still on the board
  await expect(page.locator('#dzGo')).toBeEnabled();
  await page.locator('.drawer .x').click();
  await expect(page.locator('.card', { hasText: 'Dome Repairs' })).toBeVisible();
});

test('Won-Pending Payment is gone from the pipeline', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  await expect(page.locator('.board .col-h .t', { hasText: 'Won-Pending Payment' })).toHaveCount(0);
  await page.locator('#ndBtn').click();
  const opts = await page.locator('#dfStage option').allTextContents();
  expect(opts.some((o) => o.includes('Won-Pending Payment'))).toBe(false);
  expect(errors).toEqual([]);
});

test('Lead is merged into Proposal Sent and is the default for a new deal', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  await expect(page.locator('.board .col-h .t', { hasText: 'Lead' })).toHaveCount(0);
  await page.locator('#ndBtn').click();
  const opts = await page.locator('#dfStage option').allTextContents();
  expect(opts.some((o) => o.includes('Lead'))).toBe(false);
  // a new deal must not default into a stage the pipeline no longer shows
  await expect(page.locator('#dfStage')).toHaveValue('Proposal Sent');
  expect(errors).toEqual([]);
});

test('A/R is derived from billing, not from a stage', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  // North Bay Villas: 25000 invoiced and still open in QB -> A/R is 25000.
  // It must NOT read 40000, which is the unbilled backlog (65000 - 25000).
  await expect(page.locator('#c-ar')).toHaveText('1');
  const ar = page.locator('.kpi', { hasText: 'A/R pending' });
  await expect(ar).toContainText('$25,000');
  await expect(ar).not.toContainText('$40,000');
  await expect(ar).toContainText('1 invoiced, awaiting payment');
  // it is Won, so it must also count toward Won 2026 at its FULL value —
  // A/R measures the unbilled slice and must never be netted off Won
  await expect(page.locator('.kpi', { hasText: 'Won 2026' })).toContainText('$65,000');
  await page.locator('#nav a[data-v="ar"]').click();
  await expect(page.locator('td', { hasText: 'North Bay Villas' })).toBeVisible();
  await expect(page.locator('td', { hasText: 'Dome Repairs' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a paid won deal leaves A/R but keeps its stage', async ({ page }) => {
  await stubBackend(page, { paidInFull: true });
  const errors = await bootCrm(page);
  await expect(page.locator('#c-ar')).toHaveText('0');
  await expect(page.locator('.kpi', { hasText: 'A/R pending' })).toContainText('$0');
  // still Won, still on the board, still counted in Won 2026
  await expect(page.locator('.kpi', { hasText: 'Won 2026' })).toContainText('$65,000');
  const won = page.locator('.board .col', { has: page.locator('.col-h .t', { hasText: 'Won' }) });
  await expect(won.locator('.card', { hasText: 'North Bay Villas' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('rail footer shows sync freshness and Sync now runs the job', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  const docs = page.locator('#syncstat .row', { hasText: 'Documents' });
  await expect(docs).toContainText('6h ago');
  await expect(docs).toHaveClass(/\bok\b/);
  // No qb_reconcile run is recorded, so QuickBooks freshness falls back to the
  // newest qb_synced_at on the deals (North Bay, 2026-08-30) — old enough to be red
  const qb = page.locator('#syncstat .row', { hasText: 'QuickBooks' });
  await expect(qb).not.toContainText('never');
  await expect(qb).toHaveClass(/\bcrit\b/);
  await page.locator('#syncNow').click();
  await expect(page.locator('#toast')).toContainText('Synced 5 documents across 3 deals');
  await expect(docs).toContainText('just now');
  expect(errors).toEqual([]);
});

test('a stale or failed sync is called out, not hidden', async ({ page }) => {
  await stubBackend(page, { syncRuns: [
    { job: 'dropbox_docs', finished_at: new Date(Date.now() - 5 * 864e5).toISOString(), ok: false, error: 'invalid_grant' },
    { job: 'qb_reconcile', finished_at: new Date(Date.now() - 40 * 36e5).toISOString(), ok: true },
  ] });
  await bootCrm(page);
  const docs = page.locator('#syncstat .row', { hasText: 'Documents' });
  await expect(docs).toContainText('failed');
  await expect(docs).toHaveClass(/\bcrit\b/);
  await expect(docs).toHaveAttribute('title', 'invalid_grant');
  const qb = page.locator('#syncstat .row', { hasText: 'QuickBooks' });
  await expect(qb).toHaveClass(/\bwarn\b/);   // 40h: amber, not yet red
});

test('footer survives the sync_runs table not existing yet', async ({ page }) => {
  await stubBackend(page, { noSyncTable: true });
  const errors = await bootCrm(page);
  await expect(page.locator('#syncstat .row', { hasText: 'Documents' })).toContainText('never');
  await expect(page.locator('.board .card').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('Sync now reports a failure and re-enables itself', async ({ page }) => {
  await stubBackend(page, { dropboxDown: true });
  await bootCrm(page);
  await page.locator('#syncNow').click();
  await expect(page.locator('#toast')).toContainText('Sync failed');
  await expect(page.locator('#syncNow')).toBeEnabled();
});

test('mobile viewport: burger nav present, board scrolls', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page, { viewport: { width: 390, height: 844 } });
  await expect(page.locator('#burger')).toBeVisible();
  await page.locator('#burger').click();
  await page.locator('#nav a[data-v="deals"]').click();
  await expect(page.locator('#view table')).toBeVisible();
  expect(errors).toEqual([]);
});
