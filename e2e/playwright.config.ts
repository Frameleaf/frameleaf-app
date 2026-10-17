import { defineConfig, devices, PlaywrightTestConfig } from '@playwright/test';
import dotenv from 'dotenv';
import { cpus } from 'node:os';
import { resolve } from 'node:path';

dotenv.config({ quiet: true, path: resolve(import.meta.dirname, '.env') });

export const playwrightHost = process.env.PLAYWRIGHT_HOST ?? '127.0.0.1';
export const playwrightDbHost = process.env.PLAYWRIGHT_DB_HOST ?? '127.0.0.1';
export const playwriteBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? `http://${playwrightHost}:2285`;
export const playwriteSlowMo = Number.parseInt(process.env.PLAYWRIGHT_SLOW_MO ?? '0');
export const playwrightDisableWebserver = process.env.PLAYWRIGHT_DISABLE_WEBSERVER;

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const config: PlaywrightTestConfig = {
  testDir: './src/specs/server',
  testMatch: /.*\.e2e-spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 4 : 0,
  reporter: 'html',
  use: {
    baseURL: playwriteBaseUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    launchOptions: {
      slowMo: playwriteSlowMo,
    },
  },

  workers: process.env.CI ? 4 : Math.round(cpus().length * 0.75),

  projects: [
    {
      name: 'web',
      use: { ...devices['Desktop Chrome'] },
      testDir: './src/specs/web',
      workers: 1,
    },
    {
      name: 'ui',
      use: { ...devices['Desktop Chrome'] },
      testDir: './src/ui/specs',
      fullyParallel: true,
      workers: process.env.CI ? 3 : Math.max(1, Math.round(cpus().length * 0.75) - 1),
    },
    {
      name: 'maintenance',
      use: { ...devices['Desktop Chrome'] },
      testDir: './src/specs/maintenance/web',
      workers: 1,
    },
    // FL-112 (STU-405): additional Studio-only browser evidence lanes. A bare `playwright test`
    // (e.g. `mise run //e2e:test-web`) runs every project with no `--project` filter, so naming a
    // project here is NOT by itself opt-in - it would run alongside `ui` on every unscoped
    // invocation. These two are gated behind PLAYWRIGHT_STUDIO_FIREFOX so they only exist in the
    // project list when explicitly requested (the two new package.json scripts set it); an unscoped
    // local or CI run is unaffected either way. Playwright WebKit is explicitly not accepted as
    // Safari/iPad evidence for this story - real hardware is required for that axis - so no WebKit
    // project is added here. Firefox is not installed by any CI/devcontainer `playwright install`
    // today (both call sites pin `chromium` only) - install it first (`playwright install firefox`)
    // before running either new script.
    ...(process.env.PLAYWRIGHT_STUDIO_FIREFOX
      ? [
          {
            name: 'studio-firefox',
            use: { ...devices['Desktop Firefox'] },
            testDir: './src/ui/specs/studio',
            fullyParallel: true,
            workers: process.env.CI ? 2 : Math.max(1, Math.round(cpus().length * 0.5)),
          },
          {
            name: 'studio-firefox-tablet',
            use: { ...devices['Desktop Firefox'], viewport: { width: 1024, height: 768 } },
            testDir: './src/ui/specs/studio',
            fullyParallel: true,
            workers: process.env.CI ? 2 : Math.max(1, Math.round(cpus().length * 0.5)),
          },
        ]
      : []),
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    command: 'docker compose up --build --renew-anon-volumes --force-recreate --remove-orphans',
    url: 'http://127.0.0.1:2285',
    stdout: 'pipe',
    stderr: 'pipe',
    reuseExistingServer: true,
  },
};
if (playwrightDisableWebserver) {
  delete config.webServer;
}
export default defineConfig(config);
