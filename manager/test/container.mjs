// GitHub Actions only. Disposable folders/container, no application or operator library mounts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { chromium } from 'playwright';
import { gotoWithNetworkChangeRetry } from './navigation.mjs';
const directory = await mkdtemp(join(tmpdir(), 'frameleaf-manager-ci-'));
const name = `frameleaf-manager-test-${process.pid}`;
const protocol = process.env.MANAGER_TEST_HTTP === '1' ? 'http' : 'https';
const origin = `${protocol}://127.0.0.1:19443`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const request = (path, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = (protocol === 'http' ? http : https).request(
      `${origin}/manager-api/${path}`,
      {
        rejectUnauthorized: false,
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: response.headers['content-type']?.includes('json') ? JSON.parse(text) : text,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
const evidence = { schemaVersion: 1, commit: process.env.GITHUB_SHA, architecture: process.arch, protocol, checks: {} };
try {
  for (const p of ['state', 'media', 'backup', 'custom-appdata']) await mkdir(join(directory, p));
  await writeFile(join(directory, 'docker.cfg'), `DOCKER_APP_CONFIG_PATH="${directory}/custom-appdata/"\n`);
  docker(
    'run',
    '-d',
    '--name',
    name,
    '-p',
    '127.0.0.1:19443:9443',
    '--label',
    'app.frameleaf.manager.role=controller',
    '--mount',
    `type=bind,source=${directory},target=${directory}`,
    '--mount',
    `type=bind,source=${directory}/docker.cfg,target=/run/frameleaf-host/docker.cfg,readonly`,
    '-e',
    `MANAGER_DATA=${directory}/state`,
    '-e',
    `MANAGER_BACKUP_ROOT=${directory}/backup`,
    '-e',
    `MANAGER_DATABASE_ROOTS=${directory}/custom-appdata`,
    '-e',
    `MANAGER_STORAGE_ROOTS=${directory}/media`,
    '-e',
    `MANAGER_ORIGIN=${origin}`,
    // Published on 127.0.0.1 only: tell Manager so, or a claim arriving via the bridge gateway is refused.
    '-e',
    'MANAGER_BIND_ADDRESS=127.0.0.1',
    'frameleaf-manager:test',
  );
  let status;
  for (let i = 0; i < 60; i++) {
    try {
      status = await request('status');
      if (status.status === 200) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(status?.status, 200);
  assert.equal(status.body.claimed, false);
  assert.equal((await request('dashboard')).status, 401);
  const claim = await request('claim', { name: 'Test administrator', password: 'a long disposable password' });
  assert.equal(claim.status, 201);
  if (protocol === 'https') {
    assert.match(claim.headers['set-cookie'][0], /HttpOnly/);
    assert.match(claim.headers['set-cookie'][0], /Secure/);
  } else {
    assert.equal(claim.headers['set-cookie'], undefined);
    assert.match(claim.headers['x-frameleaf-manager-session'], /^[a-f0-9]{64}$/);
  }
  const credential = protocol === 'http'
    ? { 'X-Frameleaf-Manager-Session': claim.headers['x-frameleaf-manager-session'] }
    : { Cookie: claim.headers['set-cookie'][0].split(';')[0] };
  const csrf = claim.body.csrf;
  const auth = { ...credential, 'X-CSRF-Token': csrf };
  const dashboard = await request('dashboard', undefined, auth);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.importQualificationEnabled, undefined);
  for (const route of ['capture-library-import', 'inspect-library-import', 'prepare-library-import']) {
    const disabled = await request(route, {}, auth);
    assert.equal(disabled.status, 404);
    assert.equal(disabled.body.code, 'import_qualification_unavailable');
  }

  assert.equal(dashboard.body.databaseStorage.detectedPath, `${directory}/custom-appdata`);
  assert.equal(dashboard.body.databaseStorage.suggestedPath, `${directory}/custom-appdata`);
  evidence.checks.customUnraidAppdataDetection = 'passed';
  assert.equal(
    (
      await request(
        'profile',
        { firstName: 'Test', lastName: '', email: 'test@example.test', account: 'local' },
        credential,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        'profile',
        { firstName: 'Test', lastName: '', email: 'test@example.test', account: 'local' },
        { ...auth, Origin: 'https://evil.test' },
      )
    ).status,
    403,
  );
  assert.equal((await request('status', undefined, { Host: 'evil.test' })).status, 403);
  evidence.checks.authenticationCsrfAndRebinding = 'passed';
  docker('restart', name);
  for (let i = 0; i < 30; i++) {
    try {
      if ((await request('status')).status === 200) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal((await request('status')).body.claimed, true);
  assert.equal((await request('dashboard', undefined, auth)).status, 200);
  evidence.checks.managerReplacementAndSessionPersistence = 'passed';
  assert.equal(dashboard.body.administrator.name, 'Test administrator');
  assert.equal(dashboard.body.managerOrigin, origin);
  assert.equal(dashboard.body.backupRoot, `${directory}/backup`);
  const storage = await request('storage', undefined, auth);
  assert.equal(storage.status, 200);
  assert.ok(storage.body.every((item) => item.totalBytes > 0 && item.availableBytes > 0));
  assert.deepEqual((await request('backup-status', undefined, auth)).body, {
    configured: false,
    unlocked: false,
    keyAvailable: false,
    snapshots: [],
  });
  docker(
    'exec',
    name,
    'node',
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(directory + '/state/recovery-key')}, 'synthetic-recovery-fixture', {mode:384})`,
  );
  assert.equal((await request('backup-key', { password: 'wrong' }, auth)).status, 401);
  assert.equal(
    (await request('backup-key', { password: 'a long disposable password' }, credential)).status,
    403,
  );
  const recovery = await request('backup-key', { password: 'a long disposable password' }, auth);
  assert.equal(recovery.status, 201);
  assert.equal(recovery.body, 'synthetic-recovery-fixture');
  assert.equal(recovery.headers['cache-control'], 'no-store');
  assert.match(recovery.headers['content-disposition'], /attachment/);
  assert.equal((await request('administrator', { name: 'Intruder', password: 'wrong' }, auth)).status, 401);
  const changed = await request(
    'administrator',
    { name: 'Changed owner', password: 'a long disposable password', newPassword: 'a new disposable password' },
    auth,
  );
  assert.equal(changed.status, 201);
  assert.equal((await request('dashboard', undefined, auth)).status, 401);
  const replacementAuth = { ...(protocol === 'http'
    ? { 'X-Frameleaf-Manager-Session': changed.headers['x-frameleaf-manager-session'] }
    : { Cookie: changed.headers['set-cookie'][0].split(';')[0] }), 'X-CSRF-Token': changed.body.csrf };
  assert.equal((await request('dashboard', undefined, replacementAuth)).body.administrator.name, 'Changed owner');
  assert.equal((await request('login', { password: 'a long disposable password' })).status, 401);
  evidence.checks.storageRecoveryKeyAndAdministratorRotation = 'passed';
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    await gotoWithNetworkChangeRetry(page, origin);
    if (protocol === 'http') await page.getByText('Unencrypted connection', { exact: true }).waitFor();
    await page.getByLabel(/^Password/).fill('a new disposable password');
    await page.locator('main').getByRole('button', { name: 'Sign in', exact: true }).click();
    // Nothing is installed yet, so sign-in lands in the setup shell; its rail reaches Manager settings.
    await page
      .getByRole('complementary', { name: 'Setup progress' })
      .getByRole('button', { name: 'Manager settings', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Manager settings', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Local administrator menu' }).waitFor();
    await page.getByRole('navigation', { name: 'Manager' }).waitFor();
    assert.ok((await page.locator('main').innerText()).includes('Changed owner'));
    assert.equal(await page.locator('.brand-light').evaluate((image) => image.naturalWidth > 0), true);
    if (protocol === 'http') {
      let received;
      const service = http.createServer((req, res) => { received = req.headers; res.end('synthetic application'); });
      await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
      const other = await page.context().newPage();
      try {
        await gotoWithNetworkChangeRetry(other, `http://127.0.0.1:${service.address().port}/manager-api/status`);
        assert.equal(received.cookie, undefined);
        assert.equal(received['x-frameleaf-manager-session'], undefined);
        assert.deepEqual(await page.context().cookies(), []);
        evidence.checks.httpSessionPortIsolation = 'passed';
      } finally {
        await other.close();
        await new Promise((resolve, reject) => service.close((error) => error ? reject(error) : resolve()));
      }
    }
    await page.getByRole('button', { name: 'Toggle light or dark theme' }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.locator('main').getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.locator('main').getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.deepEqual(failures, []);
    evidence.checks.realBrowserSignInSettingsAndSignOut = 'passed';
  } finally {
    await browser.close();
  }
} finally {
  try {
    docker('rm', '-f', name);
  } catch {}
  await writeFile(protocol === 'http' ? 'manager-evidence-http.json' : 'manager-evidence.json', JSON.stringify(evidence, null, 2));
  // Manager creates private root-owned files. Remove only this disposable fixture through Docker.
  try {
    docker(
      'run',
      '--rm',
      '--mount',
      `type=bind,source=${directory},target=/fixture`,
      '--entrypoint',
      'rm',
      'frameleaf-manager:test',
      '-rf',
      '/fixture/state',
    );
  } catch {}
  await rm(directory, { recursive: true, force: true });
}
