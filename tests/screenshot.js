// Capture CRM screenshots for review (not part of the test suite).
const { chromium } = require('@playwright/test');
const { stubBackend } = require('./helpers');

const OUT = process.argv[2] || '.';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await stubBackend(page);
  await page.addInitScript(() => {
    localStorage.setItem('plaza_crm_session', JSON.stringify({
      access_token: 'fake-token', refresh_token: 'r1', expires_at: Date.now() + 3600e3,
    }));
  });
  await page.goto('http://localhost:4180/index.html');
  await page.waitForSelector('.board .card');
  await page.screenshot({ path: `${OUT}/crm-board.png` });
  await page.locator('.card', { hasText: 'Dome Repairs' }).click();
  await page.locator('.drawer .tab', { hasText: 'Edit' }).click();
  await page.waitForSelector('#dfName');
  await page.screenshot({ path: `${OUT}/crm-edit.png` });
  await browser.close();
})();
