// Built UI against explicit API fixtures. Real HTTPS/authentication has separate container coverage.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, join } from 'node:path';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../ui/dist/', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url));
    if (!path.startsWith(root)) throw Error('invalid path');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.setHeader(
      'Content-Type',
      {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.avif': 'image/avif',
      }[extname(path)] ?? 'application/octet-stream',
    );
    res.end(await readFile(path));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const errors = [];
let expectedHttpErrors = 0;
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (e) => {
  if (e.type() === 'error') {
    if (expectedHttpErrors > 0 && e.text().includes('status of 401')) expectedHttpErrors--;
    else errors.push(e.text());
  }
});
const requests = [];
const source = {
  id: 'a'.repeat(64),
  project: 'family',
  version: '3.1.0',
  summary: { assets: 24860, users: 4, albums: 126, databaseBytes: 1024 ** 3 },
  mounts: [
    { type: 'bind', source: '/fixture/media', target: '/data', readOnly: false },
    { type: 'bind', source: '/fixture/archive', target: '/archive', readOnly: true },
  ],
  database: { name: 'immich', host: 'database', port: 5432, credentials: 'configured' },
  postgres: { major: 14, extensions: [{ name: 'vector' }] },
  settings: ['smtp'],
  environment: ['TZ'],
  settingsAuthority: 'database',
  unsupportedSettings: [],
};
const installation = {
  id: 'a'.repeat(12),
  name: 'Family library',
  project: 'frameleaf-' + 'a'.repeat(12),
  release: 'frameleaf-v3.2.0-1',
  port: 2283,
  ml: false,
  origin: 'new_import',
  mounts: source.mounts,
  databasePath: '/fixture/appdata/old',
  mayHaveWrittenMedia: true,
};
const dashboard = {
  csrf: 'fixture-csrf',
  administrator: { name: 'Owner' },
  host: {
    name: 'home-server',
    platform: 'linux/amd64',
    version: '28.4',
    available: true,
    memory: 16 * 1024 ** 3,
    processors: 8,
  },
  backupRoot: '/fixture/backup',
  storageRoots: ['/fixture/media'],
  databaseStorage: { suggestedPath: '/fixture/appdata', roots: ['/fixture/appdata'] },
  installation,
  operations: [],
  profile: null,
  onboardingFinished: false,
  appUrl: 'http://photos.example.test:2283',
  services: [
    { id: 'b'.repeat(64), service: 'frameleaf-server', running: true, health: 'unknown' },
    { id: 'c'.repeat(64), service: 'database', running: true, health: 'healthy' },
  ],
  summary: source.summary,
  librarySetup: { phase: 'rescanning', rescanComplete: false, verificationPassed: false, canFinish: false },
};
let backupAction = 'reuse',
  sources = [source],
  refused = [],
  failCredential = false;
const snapshot = { id: 'd'.repeat(64), time: '2026-10-07T02:00:00Z' };
await page.route('**/manager-api/**', async (route) => {
  const req = route.request(),
    path = new URL(req.url()).pathname.split('/').at(-1),
    body = req.postDataJSON();
  requests.push({ path, body, headers: req.headers() });
  let value;
  if (path === 'status') value = { claimed: true };
  else if (path === 'dashboard') value = dashboard;
  else if (path === 'sources') value = { sources, refused };
  else if (path === 'source-review')
    value = {
      source: sources.find((s) => s.id === body.sourceId),
      backup: { action: backupAction, takenAt: Date.now() - 3600000 },
    };
  else if (path === 'storage')
    value = [
      { path: '/fixture/media', totalBytes: 4 * 1024 ** 4, freeBytes: 3 * 1024 ** 4, availableBytes: 3 * 1024 ** 4 },
    ];
  else if (path === 'backup-status')
    value = { configured: true, unlocked: true, keyAvailable: true, snapshots: [snapshot] };
  else if (path === 'releases')
    value = [
      {
        tag: 'frameleaf-v3.2.1-1',
        publishedAt: '2026-10-07T01:00:00Z',
        notes: 'Verified release notes <script>never execute</script>',
      },
    ];
  else if (path === 'logs') value = { logs: 'Application ready\npassword=[redacted]' };
  else if (path === 'review-update')
    value = { id: 'update-review', from: installation.release, to: body.tag, recovery: 'Database only' };
  else if (path === 'review-restore')
    value = {
      id: 'restore-review',
      release: installation.release,
      mounts: installation.mounts,
      databaseStorage: { root: body.databaseRoot },
      replacesInstallation: true,
    };
  else if (path === 'review')
    value = {
      id: 'install-review',
      tag: body.tag,
      databaseStorage: { root: body.databaseRoot },
      requiredBytes: 3 * 1024 ** 3,
      source: body.kind === 'import' ? source : null,
      backup: { action: backupAction },
      recovery: 'Database only; original media stays in place',
    };
  else if (['control', 'update', 'restore', 'install'].includes(path)) {
    const kind =
      path === 'control'
        ? body.action
        : path === 'install'
          ? dashboard.installation
            ? 'install'
            : requests.findLast((r) => r.path === 'review').body.kind
          : path;
    const operation = {
      id: 'operation-' + requests.length,
      kind,
      state: 'failed',
      step: kind === 'update' ? 'database-checkpoint' : 'download-images',
      completed: [],
      error: 'fixture_interruption',
      createdAt: Date.now(),
      canCancel: true,
    };
    dashboard.operations = [operation];
    value = { id: operation.id };
  } else if (path === 'resume') {
    dashboard.operations[0].state = 'complete';
    dashboard.operations[0].error = null;
    value = { id: body.id };
  } else if (path === 'recover') {
    dashboard.operations[0].state = 'complete';
    dashboard.operations[0].error = 'backup_cancelled';
    value = { sourceStopped: true };
  } else if (path === 'profile') {
    dashboard.profile = body;
    value = { saved: true };
  } else if (path === 'finish-setup') {
    assert.equal(dashboard.librarySetup.canFinish, true);
    dashboard.onboardingFinished = true;
    value = { complete: true };
  } else if (path === 'administrator') {
    if (failCredential)
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'invalid_credentials' }),
      });
    dashboard.administrator.name = body.name;
    value = { csrf: 'rotated-csrf' };
    dashboard.csrf = value.csrf;
  } else if (['backup-key', 'export'].includes(path))
    return route.fulfill({
      contentType: 'application/octet-stream',
      headers: { 'Content-Disposition': 'attachment; filename="fixture-recovery.txt"' },
      body: 'synthetic recovery fixture',
    });
  else if (path === 'logout') value = { signedOut: true };
  else if (path === 'login') value = { csrf: dashboard.csrf };
  else throw Error('Unexpected API request: ' + path);
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
});
const button = (name) => page.getByRole('button', { name, exact: true });
const mainButton = (name) => page.locator('main').getByRole('button', { name, exact: true });
const nav = async (name) => {
  await page.getByRole('navigation', { name: 'Manager' }).getByRole('button', { name, exact: true }).click();
  await page.locator('main[aria-busy="false"]').waitFor();
  if (page.viewportSize().width <= 760) {
    await page.waitForFunction(() => {
      const sidebar = document.querySelector('.sidebar');
      return sidebar.getBoundingClientRect().right <= 0.5 && getComputedStyle(sidebar).visibility === 'hidden';
    });
  }
};
const refresh = () => button('Refresh Manager').click();
const check = async (name, action) => {
  await action();
  assert.deepEqual(errors, [], name + ': browser errors');
  console.log('PASS ' + name);
};
const screenshot = async (name) => {
  if (process.env.MANAGER_SCREENSHOTS) {
    await mkdir(process.env.MANAGER_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.MANAGER_SCREENSHOTS, name + '.png') });
  }
};
try {
  await page.goto(origin);
  await check('full installed navigation, real counts, service states and themes', async () => {
    await page.getByRole('heading', { name: 'Family library', exact: true }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: 'Manager' }).getByRole('button').count(), 8);
    assert.ok((await page.locator('.metric-grid').innerText()).includes('24,860'));
    await screenshot('overview-dark');
    await button('Toggle light or dark theme').click();
    await screenshot('overview-light');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await nav('Services');
    await mainButton('Logs').first().click();
    await page.getByText('password=[redacted]', { exact: false }).waitFor();
    await mainButton('Stop stack').click();
    assert.equal(await page.locator('dialog').isVisible(), true);
    await button('Cancel').click();
    await nav('Storage');
    assert.equal(await page.getByRole('progressbar').count(), 1);
    await screenshot('storage');
  });
  await check('backups, protected downloads and installed restore review', async () => {
    await nav('Backups');
    await mainButton('Export recovery key').click();
    await page.getByLabel('Current Manager password').fill('fixture proof password');
    const download = page.waitForEvent('download');
    await button('Download').click();
    await download;
    assert.ok(requests.some((r) => r.path === 'backup-key' && r.body.password === 'fixture proof password'));
    await mainButton('Restore').click();
    await mainButton('Choose a recovery point').click();
    await mainButton('Review restore').click();
    assert.equal(await mainButton('Restore database').isDisabled(), true);
    await page.getByRole('checkbox').check();
    assert.equal(await mainButton('Restore database').isEnabled(), true);
    await screenshot('restore-review');
  });
  await check('eligible update notes, confirmation, interrupted operation, resume and activity', async () => {
    await nav('Updates');
    await page.getByLabel('Eligible release').selectOption('frameleaf-v3.2.1-1');
    await mainButton('Verify and review update').click();
    await mainButton('Update Frameleaf').click();
    await page.locator('dialog').getByRole('button', { name: 'Update Frameleaf', exact: true }).click();
    await mainButton('Resume safely').waitFor();
    assert.equal(await page.getByRole('progressbar').getAttribute('value'), '0');
    await screenshot('interrupted-update');
    await mainButton('Resume safely').click();
    await mainButton('Continue').waitFor();
    await mainButton('Continue').click();
    await nav('Activity');
    await mainButton('Details').click();
    await mainButton('Continue').click();
  });
  await check('administrator errors clear password, editing and recovery procedure', async () => {
    await nav('Manager settings');
    await mainButton('Edit account').click();
    failCredential = true;
    expectedHttpErrors = 1;
    await page.getByLabel('Current Manager password').fill('wrong password');
    await button('Save account').click();
    await page.locator('dialog').getByRole('alert').waitFor();
    assert.equal(await page.getByLabel('Current Manager password').inputValue(), '');
    failCredential = false;
    await page.getByLabel('Administrator name').fill('Changed owner');
    await page.getByLabel('Current Manager password').fill('fixture proof password');
    await button('Save account').click();
    await page.getByRole('button', { name: 'Local administrator menu' }).waitFor();
    assert.equal(dashboard.administrator.name, 'Changed owner');
    await mainButton('View procedure').click();
    await page.getByText('Keep the existing state folder', { exact: true }).waitFor();
    await button('Done').click();
    await mainButton('Export').click();
    await page.getByLabel('Current Manager password').fill('fixture proof password');
    const download = page.waitForEvent('download');
    await button('Download').click();
    await download;
  });
  await check('onboarding local profile, official QR/downloads and authoritative Finish gate', async () => {
    await nav('Overview');
    await mainButton('Continue setup').click();
    await page.getByLabel('First name').fill('Test');
    await page.getByLabel('Email address').fill('test@example.test');
    await mainButton('Continue without a Cloud account').click();
    await page.getByRole('heading', { name: 'Your whole library. In your pocket.' }).waitFor();
    assert.equal(await page.locator('.download-qr').count(), 2);
    await screenshot('downloads');
    await mainButton('Continue to library preparation').click();
    assert.equal(await mainButton('Finish setup').isDisabled(), true);
    dashboard.librarySetup = { phase: 'complete', rescanComplete: true, verificationPassed: true, canFinish: true };
    await refresh();
    await mainButton('Finish setup').click();
    await mainButton('Open overview').waitFor();
    assert.equal(dashboard.onboardingFinished, true);
  });
  await check('single and multiple source import, backup reuse, missing backup and refused source', async () => {
    dashboard.installation = null;
    dashboard.operations = [];
    dashboard.onboardingFinished = false;
    await refresh();
    await nav('Set up Frameleaf');
    await mainButton('Review import').click();
    await mainButton('Review library & settings').click();
    await page.getByRole('heading', { name: 'Your library, in the same place' }).waitFor();
    assert.equal(await page.locator('.steps li').count(), 3);
    await page.getByRole('checkbox').check();
    await mainButton('Review cutover').click();
    await page.getByLabel('Library name', { exact: true }).fill('Family library');
    await page.getByRole('checkbox', { name: 'Docker or Unraid', exact: false }).check();
    await mainButton('Check and review cutover').click();
    await page.getByText('Preflight passed', { exact: true }).waitFor();
    assert.equal(await mainButton('Start import').isDisabled(), true);
    await page.getByRole('checkbox').check();
    await screenshot('import-cutover');
    await nav('Set up Frameleaf');
    backupAction = 'create';
    sources = [source, { ...source, id: 'e'.repeat(64), project: 'another-library' }];
    await mainButton('Review import').click();
    await page.getByRole('heading', { name: 'Choose an Immich installation' }).waitFor();
    assert.equal(await page.getByRole('radio').count(), 2);
    await page.getByRole('radio').last().check();
    await mainButton('Review library & settings').click();
    await page.getByRole('heading', { name: 'Your library, in the same place' }).waitFor();
    assert.equal(await page.locator('.steps li').count(), 4);
    await page.getByRole('checkbox').check();
    await mainButton('Review database backup').click();
    await page.getByRole('heading', { name: 'Back up the Immich database' }).waitFor();
    sources = [];
    refused = [{ code: 'unsupported_source' }];
    await nav('Set up Frameleaf');
    await mainButton('Find installations').click();
    await page.getByText('unsupported source', { exact: true }).waitFor();
    assert.equal(await mainButton('Review import').count(), 0);
  });
  await check('new library native validation, configuration checks and reviewed install', async () => {
    await mainButton('Set up Frameleaf').click();
    await page.getByLabel(/^Media location/).selectOption('/fixture/media');
    await page.getByRole('checkbox', { name: 'Docker or Unraid', exact: false }).check();
    await page.getByLabel('Frameleaf port').fill('12');
    const count = requests.filter((r) => r.path === 'review').length;
    await mainButton('Check this configuration').click();
    assert.equal(requests.filter((r) => r.path === 'review').length, count);
    await page.getByLabel('Frameleaf port').fill('2283');
    await mainButton('Check this configuration').click();
    await mainButton('Review installation').click();
    await screenshot('install-review');
    await mainButton('Install Frameleaf').click();
    await mainButton('Resume safely').waitFor();
    assert.ok(requests.findLast((r) => r.path === 'install').body.key);
  });
  await check('narrow layouts, mobile navigation, focus and sign out', async () => {
    dashboard.operations = [];
    dashboard.installation = installation;
    await refresh();
    for (const width of [390, 768, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      const menu = button('Toggle navigation');
      if (await menu.isVisible()) {
        await menu.click();
        await page.getByRole('navigation', { name: 'Manager' }).waitFor({ state: 'visible' });
        assert.equal(await menu.getAttribute('aria-expanded'), 'true');
      }
      await nav('Overview');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H1');
      if (width <= 760) assert.equal(await menu.getAttribute('aria-expanded'), 'false');
      await screenshot('overview-' + width);
    }
    await button('Dismiss notification').click();
    await page.locator('#toast.visible').waitFor({ state: 'hidden' });
    await button('Local administrator menu').click();
    await page.locator('.account-menu').getByRole('button', { name: 'Sign out', exact: true }).click();
    await mainButton('Sign in').waitFor();
  });
  assert.deepEqual(errors, []);
  console.log('All Manager browser checks passed.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
