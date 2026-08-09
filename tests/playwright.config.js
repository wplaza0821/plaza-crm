// Playwright config for the Plaza CRM functional suite.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  timeout: 45_000,
  retries: 1,
  workers: 4,
  reporter: [['list']],
  webServer: {
    command: 'python3 -m http.server 4180 --directory ..',
    port: 4180,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:4180',
    headless: true,
    serviceWorkers: 'block',
    launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
  },
});
