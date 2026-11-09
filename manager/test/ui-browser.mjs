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
await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined }));
const errors = [];
let expectedHttpErrors = 0;
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (e) => {
  if (e.type() === 'error') {
    if (expectedHttpErrors > 0 && /status of (?:40[19]|502)\b/u.test(e.text())) expectedHttpErrors--;
    else errors.push(e.text());
  }
});
const requests = [];
const source = {
  id: 'a'.repeat(64),
  project: 'family',
  product: 'Noodle Gallery',
  version: '3.1.0',
  summary: { assets: 24860, users: 4, albums: 126, databaseBytes: 1024 ** 3 },
  mounts: [
    { type: 'bind', source: '/fixture/media', target: '/data', readOnly: false },
    { type: 'bind', source: '/fixture/archive', target: '/archive', readOnly: true },
  ],
  database: { name: 'immich', host: 'database', port: 5432, credentials: 'configured' },
  configuration: [
    { icon: 'database', title: 'PostgreSQL 14', detail: 'Database: immich · vector', status: 'configured' },
    { icon: 'network', title: 'Database connection resolved', detail: 'database:5432 · Settings from database' },
  ],
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
    acceleration: 'openvino',
  },
  backupRoot: '/fixture/backup',
  storageRoots: ['/fixture/media', '/fixture/new-drive'],
  databaseStorage: { suggestedPath: '/fixture/appdata', roots: ['/fixture/appdata'] },
  installation,
  operations: [],
  profile: null,
  onboardingFinished: false,
  appUrl: 'http://photos.example.test:2283',
  suggestedPort: 2286,
  installations: [
    { name: 'Family library', current: true, appPort: 2283, running: true },
    { name: 'Studio archive', current: false, managerUrl: 'https://photos.example.test:2284', appPort: 2285, running: true },
  ],
  services: [
    { id: 'b'.repeat(64), service: 'frameleaf-server', running: true, health: 'unknown' },
    { id: 'c'.repeat(64), service: 'database', running: true, health: 'healthy' },
  ],
  summary: source.summary,
  librarySetup: { phase: 'rescanning', rescanComplete: false, verificationPassed: false, canFinish: false },
};
// FL-1323: the Storage page's places, drives and suggestions.
const GB = 1024 ** 3;
const cachePool = { path: '/fixture', hostPath: '/fixture', name: 'Cache pool', label: 'Cache pool (NVMe SSD)', kind: 'nvme', speed: 'fast', freeBytes: 180 * GB, totalBytes: 500 * GB, base: '/fixture/appdata' };
let thumbnails = { path: '/fixture/media/thumbs', own: false, missing: false, bytes: 86 * GB, files: 412880 };
const storageUsage = () => ({
  media: { path: '/fixture/media', bytes: 1.85 * 1024 * GB },
  database: { path: '/fixture/appdata', bytes: 12 * GB },
  thumbnails,
  drives: [cachePool],
  suggestions: {
    database: null,
    thumbs: thumbnails.own
      ? null
      : {
          status: 'found',
          drive: cachePool,
          needBytes: 86 * GB,
          title: 'Suggested: Cache pool (NVMe SSD)',
          reason: 'It has 180 GB free, and thumbnails need about 86 GB. The timeline loads hundreds of small images at once, so large libraries scroll faster from an SSD or NVMe drive.',
          folder: '/fixture/appdata/frameleaf-thumbnails',
        },
  },
});
const storageOperation = (id, kind, step, completed) => {
  dashboard.operations = [{ id, kind, state: 'running', step, completed, error: null, canStop: kind === 'move-thumbnails', canCancel: false }];
  return { id };
};
let backupAction = 'reuse',
  sources = [source],
  refused = [],
  failCredential = false,
  commonReview = null,
  photoAppSources = [],
  photoAppInspection = null,
  // FL-1317: the next review reports these problems once, then the server is ready.
  reviewProblems = null,
  reviewFails = false,
  // FL-1320 in the FL-1317 list: the first restore review finds the thumbnails drive gone.
  restoreThumbnailsGone = true;
const okChecks = (restore = false) => [
  { id: 'docker', status: 'ok', facts: { version: '28.4' } },
  { id: 'media', status: 'ok', facts: { free: 3 * 1024 ** 4 } },
  { id: 'database', status: 'ok', facts: { free: 200 * 1024 ** 3 } },
  ...(restore ? [] : [{ id: 'backups', status: 'ok', facts: { free: 3 * 1024 ** 4 } }, { id: 'manager', status: 'ok', facts: { free: 200 * 1024 ** 3 } }]),
  { id: 'port', status: 'ok', facts: { port: 2283 } },
  { id: 'release', status: 'ok', facts: { tag: 'frameleaf-v3.2.1-1' } },
];
const snapshot = { id: 'd'.repeat(64), time: '2026-10-07T02:00:00Z' };
let snapshots = [snapshot];
const containerSettings = {
  'frameleaf-server': { environment: { TZ: 'America/Toronto' }, mounts: [{ source: '/fixture/archive', target: '/old-archive', readOnly: true }], memory: '4g' },
};
await page.route('**/manager-api/**', async (route) => {
  const req = route.request(),
    path = new URL(req.url()).pathname.split('/').at(-1),
    body = req.postDataJSON();
  requests.push({ path, body, headers: req.headers() });
  let value;
  if (path === 'status') value = { claimed: true };
  else if (path === 'dashboard') value = dashboard;
  else if (path === 'sources') value = { sources, refused };
  else if (path === 'photo-app-sources') value = { sources: photoAppSources };
  else if (path === 'photo-app-capture') {
    const operation = {
      id: '7c0a3f52-5b8e-4a59-9d3e-2f0c1d4e5a6b', kind: 'import', state: 'running', step: 'capture-common-source',
      completed: [], error: null, createdAt: Date.now(), canCancel: false, photoApp: { kind: 'lychee', name: 'Lychee' },
    };
    dashboard.operations = [operation];
    value = { id: operation.id };
  } else if (path === 'photo-app-folder') {
    if (!body.path.startsWith('/fixture/media/'))
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'import_folder_outside_roots' }) });
    const operation = {
      id: '3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d', kind: 'import', state: 'running', step: 'capture-common-source',
      completed: [], error: null, createdAt: Date.now(), canCancel: false, photoApp: { kind: 'ente', name: 'Ente Photos' },
    };
    dashboard.operations = [operation];
    value = { id: operation.id };
  } else if (path === 'photo-app-inspect') value = photoAppInspection;
  else if (path === 'photo-app-prepare')
    value = {
      id: body.operationId,
      approvalToken: '0d9b8c1e-2f3a-4b5c-8d7e-6f5a4b3c2d1e',
      downtime: 'Lychee stays stopped while your library is imported.',
      recovery: 'Lychee’s own data is unchanged.',
      commonImport: {
        source: 'lychee', version: '5.0.0', requiresBootstrap: false, requiredMediaBytes: 3 * 1024 ** 2,
        summary: { assets: 3, albums: 1, owners: 2 },
      },
    };
  else if (path === 'photo-app-cancel') {
    dashboard.operations = [];
    value = { cancelled: true };
  }
  else if (path === 'source-review')
    value = {
      source: sources.find((s) => s.id === body.sourceId),
      backup: { action: backupAction, takenAt: Date.now() - 3600000 },
    };
  else if (path === 'source-settings') {
    const settings = body.settings ?? { forkOnly: {}, oauth: { clientSecret: '[unchanged]' } };
    const current = sources.find((s) => s.id === body.sourceId);
    value = {
      settings,
      source: { ...current, unsupportedSettings: Object.keys(settings).filter((k) => k === 'forkOnly'), settingsEdited: !!body.settings },
    };
  } else if (path === 'storage')
    value = [
      { path: '/fixture/media', totalBytes: 4 * 1024 ** 4, freeBytes: 3 * 1024 ** 4, availableBytes: 3 * 1024 ** 4 },
    ];
  else if (path === 'backup-status')
    value = { configured: true, unlocked: true, keyAvailable: true, snapshots };
  else if (path === 'releases')
    value = [
      {
        tag: 'frameleaf-v3.2.1-1',
        publishedAt: '2026-10-07T01:00:00Z',
        notes: 'Verified release notes <script>never execute</script>\n<!-- Release notes generated using configuration in .github/release.yml -->\n**Full Changelog**: compare',
      },
      // Older than the running frameleaf-v3.2.0-1: never offered as an update.
      { tag: 'frameleaf-v3.1.0', publishedAt: '2026-10-06T01:00:00Z', notes: 'Older release' },
    ];
  else if (path === 'container-settings' && !body)
    value = { services: containerSettings };
  else if (path === 'logs')
    value = { logs: [...Array.from({ length: 200 }, (_, i) => `Mapped route ${i}`), 'Application ready\npassword=[redacted]'].join('\n') };
  else if (path === 'diagnostics')
    value = {
      checks: [
        { name: 'Docker', ok: true, detail: 'Docker 27.3.1, Compose 2.29.7, linux/amd64 (41 ms)' },
        { name: 'Server → database', ok: true, detail: 'PostgreSQL accepts connections.' },
        { name: 'Server → machine learning', ok: false, detail: 'Machine learning no answer (ECONNREFUSED)' },
        { name: 'Network discovery', ok: null, detail: 'Stopped: phones on the network will not find this library automatically.' },
      ],
    };
  else if (path === 'storage-usage') value = storageUsage();
  else if (path === 'review-move')
    value = { available: true, id: '019aa111-1111-7111-8111-111111111111', root: body.root, files: 2, bytes: 4096 };
  else if (path === 'review-thumbnail-move')
    value = { available: true, id: '019aa111-1111-7111-8111-111111111113', root: body.root, files: 412880, bytes: 86 * GB };
  else if (path === 'move-thumbnails') value = storageOperation('thumbnail-operation', 'move-thumbnails', 'move-freeze', ['move-stop-writers', 'move-checkpoint', 'move-fence-stack']);
  else if (path === 'review-thumbnails-home')
    value = { id: '019aa111-1111-7111-8111-111111111114', missing: thumbnails.path, folder: '/fixture/media/thumbs', assets: 412880 };
  else if (path === 'thumbnails-home') value = storageOperation('home-operation', 'thumbnails-home', 'thumbs-queue', ['thumbs-home-switch', 'start']);
  else if (path === 'move-library') {
    dashboard.operations = [
      {
        id: 'move-operation',
        kind: 'move-library',
        state: 'running',
        step: 'move-copy',
        completed: ['move-stop-writers', 'move-checkpoint', 'move-fence-stack', 'move-freeze'],
        error: null,
        canStop: true,
        canCancel: false,
      },
    ];
    value = { id: 'move-operation' };
  } else if (path === 'stop-move') {
    dashboard.operations[0].state = 'failed';
    dashboard.operations[0].error = 'media_move_cancelled';
    dashboard.operations[0].canCancel = true;
    dashboard.operations[0].canStop = false;
    value = { requested: true };
  } else if (path === 'review-update')
    value = { id: 'update-review', from: installation.release, to: body.tag, recovery: 'Database only' };
  else if (path === 'review-restore' && restoreThumbnailsGone && !body.thumbnailFallback)
    value = {
      ready: false,
      host: 'unraid',
      port: 2283,
      checks: [
        { id: 'docker', status: 'ok', facts: { version: '28.4' } },
        { id: 'thumbnails', status: 'problem', code: 'thumbnail_folder_missing', facts: { missing: '/fixture/fast/thumbs', folder: '/fixture/media/thumbs' } },
        ...okChecks(true).slice(1),
      ],
    };
  else if (path === 'review-restore')
    value = {
      ...(body.thumbnailFallback && { thumbnailFallback: { missing: '/fixture/fast/thumbs', folder: '/fixture/media/thumbs' } }),
      ready: true,
      host: 'linux',
      checks: okChecks(true),
      id: 'restore-review',
      release: installation.release,
      mounts: installation.mounts,
      databaseStorage: { root: body.databaseRoot },
      replacesInstallation: true,
    };
  else if (path === 'review' && reviewFails) {
    reviewFails = false;
    expectedHttpErrors++;
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'installation_already_exists' }) });
  } else if (path === 'review') {
    await new Promise((done) => setTimeout(done, 300));
    const problems = reviewProblems;
    reviewProblems = null;
    value = commonReview ?? (problems ? { ready: false, host: 'unraid', kind: body.kind, checks: problems } : {
      ready: true,
      host: 'linux',
      checks: okChecks(),
      id: 'install-review',
      tag: body.tag,
      databaseStorage: { root: body.databaseRoot },
      requiredBytes: 3 * 1024 ** 3,
      source: body.kind === 'import' ? source : null,
      backup: { action: backupAction },
      recovery: 'Database only; original media stays in place',
    });
  } else if (['control', 'update', 'restore', 'install', 'container-settings'].includes(path)) {
    const kind =
      path === 'control'
        ? body.action
        : path === 'container-settings'
          ? 'reconfigure'
        : path === 'install'
          ? dashboard.installation
            ? 'install'
            : requests.findLast((r) => r.path === 'review').body.kind
          : path;
    const operation = {
      id: 'operation-' + requests.length,
      kind,
      state: 'failed',
      step: kind === 'update' ? 'database-checkpoint' : kind === 'reconfigure' ? 'start' : 'download-images',
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
  } else if (path === 'diagnostics-report')
    // The first answer is a proxy's HTML error page; the next one is the report.
    return route.fulfill(
      requests.filter((r) => r.path === 'diagnostics-report').length === 1
        ? { status: 502, contentType: 'text/html', body: '<html><body>Bad gateway</body></html>' }
        : { contentType: 'text/plain', body: 'Frameleaf troubleshooting report\n' },
    );
  else if (['backup-key', 'export'].includes(path))
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
const refresh = async () => {
  await button('Refresh Manager').click();
  await page.locator('main[aria-busy="false"]').waitFor();
};
// Before anything is installed, setup runs in its own shell; its rail returns to the chooser.
const chooser = async () => {
  if (!(await page.locator('.setup-rail').count())) return nav('Set up Frameleaf');
  await page.locator('.setup-rail').getByRole('button', { name: 'Choose how to begin', exact: true }).click();
  await page.locator('main[aria-busy="false"]').waitFor();
};
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
  await check('native first-run status directs setup to Desktop', async () => {
    const statusRoute = '**/manager-api/status';
    await page.route(statusRoute, (route) => route.fulfill({ json: { claimed: false, claimProofRequired: true } }));
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Finish setup in Frameleaf Desktop' }).waitFor({ timeout: 5000 });
    assert.equal(await button('Create administrator').count(), 0);
    assert.equal(await page.getByLabel('Password').count(), 0);
    await page.unroute(statusRoute);
  });
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
    // The newest lines are what an owner opens logs for.
    await page.waitForFunction(() => {
      const log = document.querySelector('pre.log');
      return log.scrollHeight > log.clientHeight && log.scrollTop + log.clientHeight >= log.scrollHeight - 2;
    });
    await page.getByRole('button', { name: 'Check connections' }).click();
    await page.getByText('Machine learning no answer (ECONNREFUSED)', { exact: true }).waitFor();
    assert.equal(await page.getByText('Problem', { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Check again' }).waitFor();
    assert.equal(
      await page.getByRole('link', { name: 'Post on the community ↗' }).getAttribute('href'),
      'https://frameleaf.app/help/community/c/bug-reports/9',
    );
    await screenshot('services-troubleshooting');
    expectedHttpErrors = 1;
    await page.getByRole('button', { name: 'Download report' }).click();
    await page.locator('#main').getByText('Manager sent an unexpected answer.', { exact: false }).waitFor();
    const report = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download report' }).click();
    assert.match((await report).suggestedFilename(), /^frameleaf-troubleshooting-\d{4}-\d{2}-\d{2}\.txt$/);
    await page.getByText('Report downloaded. Read it, then attach it to a post in Community › Bug reports.', { exact: true }).waitFor();
    assert.equal(requests.filter((r) => r.path === 'diagnostics-report').length, 2);
    await mainButton('Stop stack').click();
    assert.equal(await page.locator('dialog').isVisible(), true);
    await button('Cancel').click();
    // Advanced container settings: pre-filled from the installed stack, saved through a journaled restart.
    await page.getByText('Frameleaf server: 1 variable · 1 folder · 4g memory', { exact: true }).waitFor();
    await page.getByText('Advanced container settings', { exact: true }).click();
    const installedEnvironment = page.getByLabel('Environment variables').first();
    assert.equal(await installedEnvironment.inputValue(), 'TZ=America/Toronto');
    assert.equal(await page.getByLabel('Extra folders').first().inputValue(), '/fixture/archive:/old-archive:ro');
    await installedEnvironment.fill('TZ=UTC\nPOSTGRES_DB=nope');
    const before = requests.length;
    await mainButton('Save and restart Frameleaf').click();
    await page.getByText('POSTGRES_DB is set by Manager', { exact: true }).waitFor();
    assert.equal(requests.length, before);
    await installedEnvironment.fill('TZ=UTC');
    await page.getByLabel('Memory limit').first().fill('');
    await screenshot('services-advanced');
    await mainButton('Save and restart Frameleaf').click();
    await page.getByRole('heading', { name: 'Applying container settings' }).waitFor();
    assert.deepEqual(requests.findLast((r) => r.path === 'container-settings').body.services, {
      'frameleaf-server': { environment: { TZ: 'UTC' }, mounts: [{ source: '/fixture/archive', target: '/old-archive', readOnly: true }] },
    });
    await mainButton('Resume safely').click();
    await mainButton('Continue').click();
    await page.getByRole('heading', { name: 'Services', exact: true }).waitFor();
    await nav('Storage');
    const places = page.getByRole('list', { name: 'Where your library keeps its data' });
    assert.deepEqual(await places.getByRole('heading').allInnerTexts(), ['Photos and videos', 'Database', 'Thumbnails']);
    assert.ok((await places.innerText()).includes('86 GB used, with your photos and videos'));
    await screenshot('storage');
  });
  await check('installation switcher lists this server’s libraries and explains adding one', async () => {
    assert.match(await page.title(), /^Family library · Frameleaf Manager/);
    await button('Switch installation').click();
    const menu = page.getByRole('menu', { name: 'Frameleaf installations' });
    assert.equal(await menu.getByRole('menuitem').count(), 3);
    assert.equal(await menu.getByRole('menuitem', { name: /Studio archive/ }).getAttribute('href'), 'https://photos.example.test:2284');
    await screenshot('installation-switcher');
    await menu.getByRole('menuitem', { name: /Add installation/ }).click();
    await page.getByRole('heading', { name: 'Add another installation' }).waitFor();
    assert.ok((await page.locator('dialog').innerText()).includes('For example 2286'));
    await page.waitForTimeout(400); // dialog entrance animation
    await screenshot('add-installation');
    await button('Cancel').click();
  });
  await check('library move requires review and backup acknowledgement, then stops safely', async () => {
    await nav('Storage');
    await mainButton('Move…').first().click();
    await page.getByRole('dialog', { name: 'Choose a bigger drive' }).getByRole('button', { name: '/fixture/new-drive' }).click();
    const review = page.getByRole('dialog', { name: 'Move photos and videos' });
    await review.getByText('4 KB to copy').waitFor();
    assert.equal(await review.getByRole('button', { name: 'Move the library' }).isDisabled(), true);
    await review.getByRole('checkbox', { name: /I have a separate backup/ }).check();
    await review.getByRole('button', { name: 'Move the library' }).click();
    await mainButton('Stop safely').waitFor();
    assert.equal(requests.findLast((r) => r.path === 'review-move').body.root, '/fixture/new-drive');
    await mainButton('Stop safely').click();
    await mainButton('Cancel safely').waitFor();
    assert.ok(requests.some((r) => r.path === 'stop-move'));
    dashboard.operations = [];
    await refresh();
  });
  await check('thumbnails move straight to the suggested drive, with the real file count in the review', async () => {
    await nav('Storage');
    await mainButton('Move to Cache pool…').click();
    const review = page.getByRole('dialog', { name: 'Move thumbnails' });
    await review.getByText('412,880 files · 86 GB to copy').waitFor();
    assert.ok((await review.innerText()).includes('/fixture/appdata/frameleaf-thumbnails'));
    assert.equal(requests.findLast((r) => r.path === 'review-thumbnail-move').body.root, '/fixture/appdata/frameleaf-thumbnails');
    await screenshot('storage-move-thumbnails');
    await review.getByRole('button', { name: 'Move thumbnails' }).click();
    await page.getByRole('heading', { name: 'Moving thumbnails' }).waitFor();
    const steps = await page.locator('ol.timeline li strong').allInnerTexts();
    assert.deepEqual(steps, ['Pause uploads and background work', 'Copy thumbnails', 'Check every file', 'Switch to the new folder', 'Start Frameleaf']);
    dashboard.operations = [];
    await refresh();
  });
  await check('a missing thumbnail drive is named, checked again, and thumbnails can go back with the photos', async () => {
    thumbnails = { path: '/fixture/fast/thumbnails', own: true, missing: true, bytes: null, files: null };
    await nav('Storage');
    await page.getByRole('heading', { name: 'The thumbnail drive isn’t connected' }).waitFor();
    await mainButton('Check again').click();
    await mainButton('Check again').waitFor();
    assert.ok(requests.filter((r) => r.path === 'storage-usage').length >= 2);
    await screenshot('storage-thumbnails-missing');
    await mainButton('Put back with your photos…').click();
    const review = page.getByRole('dialog', { name: 'Put thumbnails back with your photos' });
    await review.getByText('412,880 thumbnails to make again').waitFor();
    assert.ok((await review.innerText()).includes('Your photos and videos are not touched.'));
    await review.getByRole('button', { name: 'Put back and rebuild' }).click();
    await page.getByRole('heading', { name: 'Putting thumbnails back with your photos' }).waitFor();
    assert.deepEqual(await page.locator('ol.timeline li strong').allInnerTexts(), ['Switch to your photos folder', 'Start Frameleaf', 'Queue new thumbnails']);
    thumbnails = { path: '/fixture/media/thumbs', own: false, missing: false, bytes: 86 * GB, files: 412880 };
    dashboard.operations = [];
    await refresh();
  });
  await check('backups, protected downloads and installed restore review', async () => {
    // A container setting left invalid on Services never blocks a restore, which sends none.
    await nav('Services');
    await page.getByText('Advanced container settings', { exact: true }).click();
    await page.getByLabel('Environment variables').first().fill('POSTGRES_DB=nope');
    await nav('Backups');
    await mainButton('Export recovery key').click();
    await page.getByLabel('Current Manager password').fill('fixture proof password');
    const download = page.waitForEvent('download');
    await button('Download').click();
    await download;
    assert.ok(requests.some((r) => r.path === 'backup-key' && r.body.password === 'fixture proof password'));
    await mainButton('Restore').click();
    await mainButton('Choose a recovery point').click();
    await mainButton('Check this server').click();
    await page.getByRole('heading', { name: '1 thing to fix before restoring' }).waitFor();
    await page.getByRole('heading', { name: 'The thumbnails drive isn’t connected' }).waitFor();
    await mainButton('Keep thumbnails with your photos').click();
    await page.getByRole('heading', { name: 'This server is ready' }).waitFor();
    assert.equal(requests.findLast((r) => r.path === 'review-restore').body.thumbnailFallback, true);
    await mainButton('Review restore').click();
    await page.getByText('Thumbnails go back in the photos folder', { exact: true }).waitFor();
    // Another recovery point's missing thumbnails folder is checked again, never kept with the photos unasked.
    snapshots = [snapshot, { id: 'e'.repeat(64), time: '2026-10-06T02:00:00Z' }];
    await nav('Backups');
    await mainButton('Restore').first().click();
    await mainButton('Choose a recovery point').click();
    await page.getByRole('radio').last().check();
    await mainButton('Check this server').click();
    await page.getByRole('heading', { name: 'The thumbnails drive isn’t connected' }).waitFor();
    assert.equal(requests.findLast((r) => r.path === 'review-restore').body.thumbnailFallback, undefined);
    await mainButton('Keep thumbnails with your photos').click();
    await page.getByRole('heading', { name: 'This server is ready' }).waitFor();
    await mainButton('Back').click();
    await page.getByRole('radio').first().check();
    await mainButton('Check this server').click();
    await page.getByRole('heading', { name: 'The thumbnails drive isn’t connected' }).waitFor();
    assert.equal(requests.findLast((r) => r.path === 'review-restore').body.thumbnailFallback, undefined);
    snapshots = [snapshot];
    await mainButton('Keep thumbnails with your photos').click();
    await mainButton('Review restore').click();
    assert.equal(await mainButton('Restore database').isDisabled(), true);
    await page.getByRole('checkbox').check();
    assert.equal(await mainButton('Restore database').isEnabled(), true);
    await screenshot('restore-review');
    assert.equal(await page.locator('.nav-item.active > span').first().innerText(), 'Backups');
  });
  await check('eligible update notes, confirmation, interrupted operation, resume and activity', async () => {
    await nav('Updates');
    assert.deepEqual(await page.getByLabel('Eligible release').locator('option').allInnerTexts(), [
      'Select a release',
      'frameleaf-v3.2.1-1 · ' + new Date('2026-10-07T01:00:00Z').toLocaleDateString(),
    ]);
    assert.equal(await page.locator('.nav-badge').innerText(), '1');
    await page.getByLabel('Eligible release').selectOption('frameleaf-v3.2.1-1');
    const notes = await page.locator('main pre.log').innerText();
    assert.ok(notes.includes('<script>never execute</script>') && notes.includes('Full Changelog: compare'));
    assert.ok(!notes.includes('<!--') && !notes.includes('**'));
    await mainButton('Verify and review update').click();
    await mainButton('Update Frameleaf').click();
    await page.locator('dialog').getByRole('button', { name: 'Update Frameleaf', exact: true }).click();
    await mainButton('Resume safely').waitFor();
    assert.equal(await page.locator('.nav-item.active > span').first().innerText(), 'Updates');
    assert.equal(await page.getByRole('progressbar').getAttribute('value'), '0');
    await screenshot('interrupted-update');
    await mainButton('Resume safely').click();
    await mainButton('Continue').waitFor();
    await mainButton('Continue').click();
    await nav('Activity');
    await mainButton('Details').click();
    await mainButton('Continue').click();
    installation.release = 'frameleaf-v3.2.1-1';
    await refresh();
    await nav('Overview');
    await page.getByRole('heading', { name: 'Up to date', exact: true }).waitFor();
    assert.equal(await page.locator('.nav-badge').count(), 0);
    installation.release = 'frameleaf-v3.2.0-1';
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
    // An owner who would rather not wait can always skip; the server just runs.
    assert.equal(await mainButton('Skip and let the server run').isEnabled(), true);
    await screenshot('library-preparation');
    dashboard.librarySetup = { phase: 'complete', rescanComplete: true, verificationPassed: true, canFinish: true };
    await refresh();
    await mainButton('Finish setup').click();
    await mainButton('Open overview').waitFor();
    assert.equal(dashboard.onboardingFinished, true);
  });
  // Rendering fixtures only: no source discovery, capture or migration qualification is implied.
  await check('one source-configuration panel renders all ten families without PostgreSQL-specific fields', async () => {
    dashboard.installation = null;
    dashboard.operations = [];
    dashboard.onboardingFinished = false;
    await refresh();
    for (const [product, title] of [
      ['Immich', 'PostgreSQL 19'],
      ['PhotoPrism', 'MariaDB 11.4'],
      ['LibrePhotos', 'SQLite snapshot'],
      ['Photoview', 'SQLite snapshot'],
      ['Piwigo', 'MySQL 8'],
      ['Lychee', 'SQLite snapshot'],
      ['PiGallery2', 'SQLite snapshot'],
      ['Ente Photos', 'Decrypted staging export'],
      ['Nextcloud Photos / Memories', 'Decrypted staging export'],
      ['Synology Photos', 'Private exporter bundle'],
    ]) {
      sources = [{
        ...source, product, postgres: undefined, database: undefined,
        configuration: [{ icon: 'folder', title, detail: 'Synthetic setup summary' }],
      }];
      await chooser();
      await mainButton('Review import').click();
      await page.getByRole('heading', { name: `Review your ${product} installation`, exact: true }).waitFor();
      await page.getByText(title, { exact: true }).waitFor();
      assert.deepEqual(errors, [], product + ': configuration rendering');
    }
    sources = [source];
  });
  await check('single and multiple source import, backup reuse, missing backup and refused source', async () => {
    dashboard.installation = null;
    dashboard.operations = [];
    dashboard.onboardingFinished = false;
    await refresh();
    await chooser();
    await mainButton('Review import').click();
    await page.getByRole('heading', { name: 'Review your Noodle Gallery installation' }).waitFor();
    assert.doesNotMatch(await page.locator('main').innerText(), /Immich/u);
    await mainButton('Review library & settings').click();
    await page.getByRole('heading', { name: 'Your library, in the same place' }).waitFor();
    assert.equal(await page.locator('.setup-rail ul li').count(), 4);
    await page.getByRole('checkbox', { name: /reviewed the mappings/ }).check();
    await page.getByLabel('Library name', { exact: true }).fill('Family library');
    await page.getByRole('checkbox', { name: 'Docker or Unraid', exact: false }).check();
    await mainButton('Check this server').click();
    await page.getByRole('heading', { name: 'This server is ready' }).waitFor();
    await screenshot('import-checks');
    await mainButton('Review the switch').click();
    await page.getByText('Preflight passed', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('main').innerText(), /Immich/u);
    assert.equal(await mainButton('Start import').isDisabled(), true);
    await page.getByRole('checkbox').check();
    await screenshot('import-cutover');
    await chooser();
    backupAction = 'create';
    sources = [source, { ...source, id: 'e'.repeat(64), project: 'another-library' }];
    await mainButton('Review import').click();
    await page.getByRole('heading', { name: 'Choose a photo installation' }).waitFor();
    assert.equal(await page.getByRole('radio').count(), 2);
    await page.getByRole('radio').last().check();
    await mainButton('Review library & settings').click();
    await page.getByRole('heading', { name: 'Your library, in the same place' }).waitFor();
    assert.equal(await page.locator('.setup-rail ul li').count(), 5);
    await page.getByRole('checkbox', { name: /reviewed the mappings/ }).check();
    await page.getByRole('checkbox', { name: 'Docker or Unraid', exact: false }).check();
    await mainButton('Review database backup').click();
    await page.getByRole('heading', { name: 'Back up the source database' }).waitFor();
    sources = [{ ...source, settings: ['forkOnly', 'oauth'], unsupportedSettings: ['forkOnly'] }];
    await chooser();
    await mainButton('Review import').click();
    await mainButton('Review library & settings').click();
    await page.getByText('Settings require review', { exact: true }).waitFor();
    const editor = page.getByLabel('Settings JSON');
    await page.waitForFunction(() => document.querySelector('.settings-editor')?.value.includes('forkOnly'));
    assert.match(await editor.inputValue(), /\[unchanged\]/);
    await page.getByRole('checkbox', { name: /reviewed the mappings/ }).check();
    await page.getByRole('checkbox', { name: 'Docker or Unraid', exact: false }).check();
    assert.equal(await page.locator('.wizard-footer .button.primary').isDisabled(), true);
    await editor.fill('{"oauth":{"clientSecret":"[unchanged]"}}');
    await mainButton('Save settings').click();
    await page.getByText('Advanced settings · edited').waitFor();
    assert.equal(await page.getByText('Settings require review', { exact: true }).count(), 0);
    assert.equal(await page.locator('.wizard-footer .button.primary').isDisabled(), false);
    await editor.fill('{oops');
    await mainButton('Save settings').click();
    await page.getByText('Settings must be a JSON object', { exact: false }).first().waitFor();
    await page.getByLabel('Settings JSON').scrollIntoViewIfNeeded();
    await screenshot('import-advanced-settings');
    sources = [];
    refused = [{ code: 'unsupported_source' }];
    await chooser();
    await mainButton('Find installations').click();
    await page.getByText('unsupported source', { exact: true }).waitFor();
    assert.equal(await mainButton('Review import').count(), 0);
  });
  await check('new library native validation, configuration checks and reviewed install', async () => {
    await mainButton('Set up Frameleaf').click();
    await page.getByLabel(/^Media location/).selectOption('/fixture/media');
    // A detected GPU is named and turns machine learning on by default.
    await page.getByText('Intel GPU', { exact: true }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: 'Enable' }).isChecked(), true);
    if (process.env.MANAGER_SCREENSHOTS)
      await page
        .locator('section.card', { has: page.getByRole('heading', { name: 'Processing' }) })
        .screenshot({ path: join(process.env.MANAGER_SCREENSHOTS, 'install-processing.png') });
    // A second library on the same server starts on a free port and names the ports already in use.
    assert.equal(await page.getByLabel('Frameleaf port').inputValue(), '2286');
    await page.getByText('Studio archive uses port 2285.', { exact: false }).waitFor();
    if (process.env.MANAGER_SCREENSHOTS)
      await page
        .locator('section.card', { has: page.getByRole('heading', { name: 'Storage & access' }) })
        .screenshot({ path: join(process.env.MANAGER_SCREENSHOTS, 'install-port.png') });
    await page.getByRole('checkbox', { name: 'Docker or Unraid', exact: false }).check();
    await page.getByLabel('Frameleaf port').fill('12');
    const count = requests.filter((r) => r.path === 'review').length;
    await mainButton('Check this server').click();
    assert.equal(requests.filter((r) => r.path === 'review').length, count);
    await page.getByLabel('Frameleaf port').fill('2283');
    // Advanced container settings reach the review as structured overrides; a bad line keeps the review local.
    await page.getByText('Advanced container settings', { exact: true }).click();
    const serverEnvironment = page.getByLabel('Environment variables').first();
    await serverEnvironment.fill('TZ=America/Toronto\nDB_PASSWORD=nope');
    await page.getByLabel('Memory limit').first().fill('4g');
    await mainButton('Check this server').click();
    await page.getByText('DB_PASSWORD is set by Manager', { exact: true }).waitFor();
    assert.equal(requests.filter((r) => r.path === 'review').length, count);
    await serverEnvironment.fill('TZ=America/Toronto');
    await screenshot('install-advanced');
    // FL-1317: every problem at once, problems first; a fix in place checks again.
    const twoProblems = [
      { id: 'docker', status: 'ok', facts: { version: '28.4' } },
      { id: 'media', status: 'ok', facts: { free: 3 * 1024 ** 4 } },
      { id: 'database', status: 'problem', code: 'insufficient_database_space' },
      { id: 'backups', status: 'ok', facts: { free: 3 * 1024 ** 4 } },
      { id: 'port', status: 'problem', code: 'port_in_use', facts: { port: 2283, free: 2287 } },
    ];
    reviewProblems = twoProblems;
    await mainButton('Check this server').click();
    // The slow server check shows it is still working.
    await page.getByRole('heading', { name: 'Checking this server' }).waitFor();
    assert.equal(await mainButton('Checking…').getAttribute('aria-busy'), 'true');
    await page.getByRole('heading', { name: '2 things to fix before installing' }).waitFor();
    assert.deepEqual(await page.locator('.check-issue h2').allInnerTexts(), ['Not enough room in the database folder', 'Port 2283 is in use']);
    assert.equal(await mainButton('Review installation').count(), 0);
    await mainButton('Check again').waitFor();
    await screenshot('install-checks-problems');
    // A recheck that can't finish returns to the step before the checks, never a Checking… screen with no way out.
    reviewFails = true;
    await mainButton('Check again').click();
    await page.getByRole('heading', { name: 'Give your library a home' }).waitFor();
    assert.equal(await mainButton('Check this server').isEnabled(), true);
    reviewProblems = twoProblems;
    await mainButton('Check this server').click();
    await page.getByRole('heading', { name: '2 things to fix before installing' }).waitFor();
    await mainButton('Use port 2287').click();
    await page.getByRole('heading', { name: 'This server is ready' }).waitFor();
    assert.equal(requests.findLast((r) => r.path === 'review').body.port, 2287);
    await mainButton('Review installation').click();
    await screenshot('install-review');
    await page.getByText('Intel GPU · Machine learning on', { exact: true }).waitFor();
    await page.getByText('1 variable · 4g memory', { exact: true }).waitFor();
    assert.equal(requests.findLast((r) => r.path === 'review').body.ml, true);
    assert.deepEqual(requests.findLast((r) => r.path === 'review').body.services, {
      'frameleaf-server': { environment: { TZ: 'America/Toronto' }, mounts: [], memory: '4g' },
    });
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
  await check('a captured library can approve only its current review while awaiting approval', async () => {
    dashboard.installation = null;
    dashboard.operations = [];
    sources = [source];
    refused = [];
    backupAction = 'reuse';
    commonReview = {
      id: '31e3b62f-d324-42fb-9010-6a4c8299e888',
      approvalToken: '61257d33-1ab0-40ba-8bc9-73400fd14fa0',
      downtime: 'The source stays stopped during import.',
      recovery: 'Manager verifies the original files before starting Frameleaf.',
      commonImport: {
        source: 'photoprism', version: 'fixture', requiresBootstrap: false, requiredMediaBytes: 4096,
        summary: { assets: 2, albums: 1, owners: 1, preservationDifferences: 1 },
      },
    };
    await page.goto(origin);
    await mainButton('Review import').click();
    await mainButton('Review library & settings').click();
    await page.getByRole('checkbox', { name: /reviewed the mappings/ }).check();
    await page.getByLabel('Library name', { exact: true }).fill('Captured library');
    await page.getByRole('checkbox', { name: 'Docker or Unraid', exact: false }).check();
    await mainButton('Check this server').click();
    await page.getByRole('heading', { name: 'Review library import', exact: true }).waitFor();
    const capture = { id: commonReview.id, kind: 'import', state: 'awaiting-review', completed: [], canCancel: true };
    dashboard.operations = [{ ...capture, id: 'another-capture' }];
    await refresh();
    await page.getByRole('checkbox', { name: 'I’ve reviewed the transfer and recovery information.' }).check();
    assert.equal(await mainButton('Start import').isDisabled(), true);
    dashboard.operations = [capture];
    await refresh();
    assert.equal(await mainButton('Start import').isEnabled(), true);
    await mainButton('Start import').click();
    await mainButton('Resume safely').waitFor();
    const approval = requests.findLast((r) => r.path === 'install').body;
    assert.equal(approval.reviewId, commonReview.id);
    assert.equal(approval.approvalToken, commonReview.approvalToken);
    commonReview = null;
  });
  await check('another photo app: Beta picker, untested notice, losses and accounts gate the review, prepare reaches Start import', async () => {
    dashboard.installation = null;
    dashboard.operations = [];
    commonReview = null;
    sources = [source];
    refused = [];
    photoAppSources = [
      { container: 'f'.repeat(64), kind: 'lychee', name: 'lychee', version: '5.0.0', database: 'sqlite', importable: true },
      { container: '9'.repeat(64), kind: 'nextcloud', name: 'nextcloud', version: '30.0.1', database: 'mysql', importable: false, reason: 'database_unsupported' },
    ];
    photoAppInspection = {
      format: 'frameleaf-library-import-inspection',
      source: { kind: 'lychee', version: '5.0.0' },
      tested: false,
      testedVersion: '6.6.0',
      summary: { owners: 2, assets: 3, albums: 1, files: 3, bytes: String(3 * 1024 ** 2) },
      owners: [
        { sourceId: '1', name: 'Ann', email: 'ann@example.test', assets: 2, restrictions: [] },
        { sourceId: '2', name: 'Bo', email: null, assets: 1, restrictions: ['second-factor-required'] },
      ],
      losses: [{ code: 'LYCHEE_TITLE_ARCHIVED', count: 2 }, { code: 'SOURCE_VERSION_UNTESTED', count: 1 }],
    };
    await page.goto(origin);
    // Offered beside the Immich-family import, for everyone, marked Beta.
    await mainButton('Review import').waitFor();
    const picker = page.locator('section.photo-apps');
    await picker.getByRole('heading', { name: 'Import from another photo app' }).waitFor();
    assert.equal(await picker.locator('.badge.warning').innerText(), 'Beta');
    assert.match(await picker.innerText(), /Imports from other apps are new/u);
    assert.match(await picker.innerText(), /Version 5\.0\.0 · SQLite/u);
    const nextcloud = picker.locator('.radio-card', { hasText: 'Nextcloud' });
    assert.equal(await nextcloud.getByRole('radio').isDisabled(), true);
    assert.match(await nextcloud.innerText(), /Nextcloud on MySQL isn't supported yet\./u);
    assert.ok(await nextcloud.evaluate((node) => node.classList.contains('unavailable')));
    assert.equal(await picker.getByRole('radio').first().isChecked(), true);
    assert.doesNotMatch(await picker.innerText(), /fence|snapshot|manifest/iu);
    await screenshot('photo-app-picker');
    // Choosing an app explains that it stops, then captures it with an idempotency key.
    await mainButton('Import from Lychee').click();
    await page.getByRole('heading', { name: 'Stop Lychee for the import?' }).waitFor();
    await page.locator('dialog').getByRole('button', { name: 'Stop Lychee and continue', exact: true }).click();
    await page.getByRole('heading', { name: 'Bringing your library to Frameleaf' }).waitFor();
    const capture = requests.findLast((r) => r.path === 'photo-app-capture').body;
    assert.equal(capture.container, 'f'.repeat(64));
    assert.ok(capture.key);
    await page.locator('ol.timeline').getByText('Stop the app and read its library', { exact: true }).waitFor();
    Object.assign(dashboard.operations[0], { state: 'awaiting-review', step: null, completed: ['capture-common-source'], canCancel: true });
    await refresh();
    await mainButton('Review what comes across').click();
    assert.equal(requests.findLast((r) => r.path === 'photo-app-inspect').body.operationId, dashboard.operations[0].id);
    // Untested version: a clear notice, nothing else until the owner chooses to continue.
    await page.getByRole('heading', { name: 'Review your Lychee library' }).waitFor();
    await page.getByText(
      "Lychee 5.0.0 hasn't been tested. Photos and albums should come across; anything that can’t will be listed. For best results, upgrade Lychee to 6.6.0 first.",
      { exact: true },
    ).waitFor();
    assert.equal(await mainButton('Check and review import').count(), 0);
    assert.equal(await mainButton('Cancel import').count(), 2);
    await screenshot('photo-app-untested');
    await mainButton('Continue anyway').click();
    const reviewButton = mainButton('Check and review import');
    await page.getByText('Photo titles won’t come across. Descriptions do.', { exact: true }).waitFor();
    await page.getByText('2 affected', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Email for Ann').inputValue(), 'ann@example.test');
    await page.getByText('This account uses two-step sign-in in Lychee.', { exact: true }).waitFor();
    await page.getByLabel(/^Media location/).selectOption('/fixture/media');
    await page.getByRole('checkbox', { name: 'Docker or Unraid', exact: false }).check();
    assert.equal(await reviewButton.isDisabled(), true);
    await page.getByRole('checkbox', { name: 'I understand these details won’t come across to Frameleaf.' }).check();
    await page.getByText('Enter an email address for this account.', { exact: true }).waitFor();
    assert.equal(await reviewButton.isDisabled(), true);
    await page.getByLabel('Email for Bo').fill('ANN@example.test');
    await page.getByText('Each account needs its own email address.', { exact: true }).first().waitFor();
    assert.equal(await reviewButton.isDisabled(), true);
    await page.getByLabel('Email for Bo').fill('not-an-email');
    await page.getByText('Enter a valid email address, like name@example.com.', { exact: true }).waitFor();
    await page.getByLabel('Email for Bo').fill('bo@example.test');
    assert.equal(await reviewButton.isDisabled(), true);
    await page.getByRole('checkbox', { name: 'Import Bo’s account anyway' }).check();
    assert.equal(await reviewButton.isEnabled(), true);
    assert.doesNotMatch(await page.locator('main').innerText(), /fence|snapshot|manifest|loss code|LYCHEE_/iu);
    await screenshot('photo-app-review');
    // A cancel prompt can be dismissed without losing the review.
    await page.locator('.wizard-footer').getByRole('button', { name: 'Cancel import', exact: true }).click();
    await page.getByRole('heading', { name: 'Cancel this import?' }).waitFor();
    await button('Keep import').click();
    assert.equal(requests.filter((r) => r.path === 'photo-app-cancel').length, 0);
    await reviewButton.click();
    const prepare = requests.findLast((r) => r.path === 'photo-app-prepare').body;
    assert.equal(prepare.operationId, dashboard.operations[0].id);
    assert.deepEqual(prepare.owners, [
      { sourceId: '1', email: 'ann@example.test' },
      { sourceId: '2', email: 'bo@example.test', acknowledgeRestrictions: true },
    ]);
    assert.deepEqual(prepare.approvedLossCodes, ['LYCHEE_TITLE_ARCHIVED', 'SOURCE_VERSION_UNTESTED']);
    assert.equal(prepare.review.mediaPath, '/fixture/media');
    assert.equal(prepare.review.tag, 'frameleaf-v3.2.1-1');
    assert.equal(prepare.review.port, 2283);
    // The prepared review is the same card every common import uses.
    await page.getByRole('heading', { name: 'Review library import', exact: true }).waitFor();
    await page.locator('main .badge', { hasText: 'Lychee 5.0.0' }).waitFor();
    assert.equal(await mainButton('Start import').isDisabled(), true);
    await page.getByRole('checkbox', { name: 'I’ve reviewed the transfer and recovery information.' }).check();
    await screenshot('photo-app-start');
    await mainButton('Start import').click();
    await mainButton('Resume safely').waitFor();
    const approval = requests.findLast((r) => r.path === 'install').body;
    assert.equal(approval.reviewId, prepare.operationId);
    assert.equal(approval.approvalToken, '0d9b8c1e-2f3a-4b5c-8d7e-6f5a4b3c2d1e');
  });
  await check('cancelling a captured photo-app import restarts the app', async () => {
    dashboard.operations = [{
      id: '5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c', kind: 'import', state: 'awaiting-review', step: null,
      completed: ['capture-common-source'], error: null, createdAt: Date.now(), canCancel: true,
      photoApp: { kind: 'lychee', name: 'Lychee' },
    }];
    await page.goto(origin);
    await mainButton('Review what comes across').waitFor();
    await mainButton('Cancel import').click();
    await page.locator('dialog').getByRole('button', { name: 'Cancel import', exact: true }).click();
    await page.getByRole('heading', { name: 'Choose how to begin' }).waitFor();
    assert.equal(requests.findLast((r) => r.path === 'photo-app-cancel').body.operationId, '5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c');
    await page.getByText('is starting again.', { exact: false }).waitFor();
    photoAppSources = [];
  });
  await check('Ente Photos: the export-folder card explains the steps, then reads the folder into the same review', async () => {
    dashboard.installation = null;
    dashboard.operations = [];
    commonReview = null;
    photoAppSources = [];
    photoAppInspection = {
      format: 'frameleaf-library-import-inspection',
      source: { kind: 'ente', version: 'ente-cli' },
      tested: true,
      testedVersion: 'ente-cli-v0.4.2',
      summary: { owners: 1, assets: 5, albums: 3, files: 5, bytes: '6436' },
      owners: [{ sourceId: '1580559962386438', name: 'Ente account 1580559962386438', email: null, assets: 5, restrictions: [] }],
      losses: [{ code: 'ENTE_SHARED_FILE_NOT_IMPORTED', count: 2 }, { code: 'ENTE_SOURCE_METADATA_ARCHIVED', count: 1 }],
    };
    await page.goto(origin);
    const picker = page.locator('section.photo-apps');
    // Always offered, even with no other photo app on this server; nothing is chosen for the owner.
    await picker.getByRole('heading', { name: 'Import from another photo app' }).waitFor();
    const ente = picker.getByRole('radio', { name: /Ente Photos/u });
    assert.equal(await ente.isChecked(), false);
    await ente.check();
    await picker.getByText('ente photos export ente-export', { exact: true }).waitFor();
    await picker.getByText('ente photos file list --all --json > ente-export/ente-files.json', { exact: true }).waitFor();
    assert.match(await picker.innerText(), /never asks for your Ente password/u);
    assert.match(await picker.innerText(), /inside \/fixture\/media or \/fixture\/new-drive/u);
    assert.equal(await picker.getByRole('button', { name: /^Copy: /u }).count(), 2);
    const next = picker.getByRole('button', { name: 'Continue', exact: true });
    assert.equal(await next.isDisabled(), true);
    assert.doesNotMatch(await picker.innerText(), /fence|snapshot|manifest/iu);
    await screenshot('ente-steps');
    // A folder Manager can't reach says what to do, in words.
    await picker.getByRole('textbox', { name: /^Folder path/u }).fill('/elsewhere/ente-export');
    expectedHttpErrors = 1;
    await next.click();
    await page.getByRole('alert').getByText(/Manager can’t reach that folder\./u).waitFor();
    await picker.getByRole('textbox', { name: /^Folder path/u }).fill('/fixture/media/ente-export');
    await next.click();
    const folder = requests.findLast((r) => r.path === 'photo-app-folder').body;
    assert.equal(folder.kind, 'ente');
    assert.equal(folder.path, '/fixture/media/ente-export');
    assert.ok(folder.key);
    assert.equal(requests.filter((r) => r.path === 'photo-app-capture' && r.body.container === undefined).length, 0);
    await page.locator('ol.timeline').getByText('Read the export folder', { exact: true }).waitFor();
    Object.assign(dashboard.operations[0], { state: 'awaiting-review', step: null, completed: ['capture-common-source'], canCancel: true });
    await refresh();
    await page.getByText('Manager has read your export folder. Review what comes across before anything is imported.', { exact: true }).waitFor();
    await mainButton('Review what comes across').click();
    await page.getByRole('heading', { name: 'Review your Ente Photos library' }).waitFor();
    await page.getByText('Manager only reads your export folder and never changes it. Your Ente account isn’t touched.', { exact: true }).waitFor();
    await page.getByText('Photos and videos other people shared with you stay in their library. Only your own come across.', { exact: true }).waitFor();
    await page.locator('main .badge', { hasText: /^Ente Photos$/u }).waitFor();
    assert.equal(await page.getByLabel('Email for Ente account 1580559962386438').inputValue(), '');
    assert.doesNotMatch(await page.locator('main').innerText(), /ENTE_|ente-cli|stays stopped|fence|snapshot|manifest/iu);
    await screenshot('ente-review');
    await page.locator('.wizard-footer').getByRole('button', { name: 'Cancel import', exact: true }).click();
    await page.locator('dialog').getByText('Manager discards what it read. Nothing is imported, and your export folder stays as it is.', { exact: true }).waitFor();
    await page.locator('dialog').getByRole('button', { name: 'Cancel import', exact: true }).click();
    await page.getByText('Import cancelled. Your export folder is unchanged.', { exact: true }).waitFor();
    assert.equal(requests.findLast((r) => r.path === 'photo-app-cancel').body.operationId, '3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d');
  });
  assert.deepEqual(errors, []);
  console.log('All Manager browser checks passed.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
