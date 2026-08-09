// Functional suite: boot, every view, deal create/edit, drag-and-drop stage
// moves, and manual activity logging — all against the stubbed backend.
const { test, expect } = require('@playwright/test');
const { stubBackend, bootCrm } = require('./helpers');

test('boots from stored session: KPIs, board, nav counts', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  await expect(page.locator('.kpi')).toHaveCount(4);
  await expect(page.locator('.board .col')).toHaveCount(9);
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
  await page.locator('#dfAmount').fill('25000');
  await page.locator('#dfStage').selectOption('RFP Received');
  await page.locator('.drawer button.pri', { hasText: 'Create deal' }).click();
  await expect(page.locator('#toast')).toHaveText('Deal created');
  const post = captured.find((c) => c.method === 'POST' && c.path.startsWith('/rest/v1/deals'));
  expect(post).toBeTruthy();
  expect(post.body.name).toBe('Test Tower Assessment');
  expect(post.body.amount).toBe(25000);
  expect(post.body.stage).toBe('RFP Received');
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
  await page.locator('#dfAmount').fill('52500');
  await page.locator('#dfNAct').fill('Send revised proposal');
  await page.locator('.drawer button.pri', { hasText: 'Save changes' }).click();
  await expect(page.locator('#toast')).toHaveText('Deal updated');
  const patch = captured.find((c) => c.method === 'PATCH' && c.path.includes('/rest/v1/deals?id=eq.1'));
  expect(patch).toBeTruthy();
  expect(patch.body.amount).toBe(52500);
  expect(patch.body.next_action).toBe('Send revised proposal');
  expect(errors).toEqual([]);
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

test('Files tab lists the deal Dropbox folder', async ({ page }) => {
  await stubBackend(page);
  const errors = await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Files' }).click();
  await expect(page.locator('.drawer .act', { hasText: 'Dome Proposal Rev2.pdf' })).toBeVisible();
  await expect(page.locator('.drawer .act', { hasText: 'Site Photos' })).toBeVisible();
  // folders get no Open button, PDFs get a scan button
  await expect(page.locator('.drawer button', { hasText: 'Scan for value' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('scanning a proposal PDF applies its fee as the deal value', async ({ page }) => {
  const { captured } = await stubBackend(page);
  const errors = await bootCrm(page);
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Files' }).click();
  await page.locator('.drawer button', { hasText: 'Scan for value' }).click();
  await expect(page.locator('#scanout')).toContainText('$52,500');
  await expect(page.locator('#scanout')).toContainText('lump sum fee');
  await page.locator('#scanout button', { hasText: 'Use as deal value' }).first().click();
  await expect(page.locator('#toast')).toContainText('$52,500');
  const patch = captured.find((c) => c.method === 'PATCH' && c.path.includes('deals?id=eq.1') && c.body?.amount === 52500);
  expect(patch).toBeTruthy();
  expect(patch.body.value_note).toBe('from Dome Proposal Rev2.pdf');
  expect(captured.some((c) => c.path.startsWith('/rest/v1/activities') && c.body?.kind === 'value_set')).toBe(true);
  // drawer refreshes with the new amount
  await expect(page.locator('.drawer .grid2')).toContainText('$52,500');
  expect(errors).toEqual([]);
});

test('Files tab explains itself when no folder is linked', async ({ page }) => {
  await stubBackend(page);
  await bootCrm(page);
  await page.locator('.card', { hasText: 'Terrazas Facade' }).click();
  await page.locator('.drawer .tab', { hasText: 'Files' }).click();
  await expect(page.locator('#tabbody')).toContainText('No Dropbox folder linked');
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
