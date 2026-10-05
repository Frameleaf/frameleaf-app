// GitHub Actions only. Disposable folders/container, no application or operator library mounts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
const directory = await mkdtemp(join(tmpdir(), 'frameleaf-manager-ci-'));
const name = `frameleaf-manager-test-${process.pid}`;
const origin = 'https://127.0.0.1:19443';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const request = (path, body, headers = {}) => new Promise((resolve, reject) => {
  const req = https.request(`${origin}/manager-api/${path}`, { rejectUnauthorized: false, method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...headers } }, response => {
    let text = ''; response.on('data', chunk => text += chunk); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }));
  }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
});
const evidence = { schemaVersion: 1, commit: process.env.GITHUB_SHA, architecture: process.arch, checks: {} };
try {
  for (const p of ['state', 'media', 'backup', 'custom-appdata']) await mkdir(join(directory, p));
  await writeFile(join(directory, 'docker.cfg'), `DOCKER_APP_CONFIG_PATH="${directory}/custom-appdata/"\n`);
  docker('run', '-d', '--name', name, '-p', '127.0.0.1:19443:9443',
    '--label', 'app.frameleaf.manager.role=controller',
    '--mount', `type=bind,source=${directory},target=${directory}`,
    '--mount', `type=bind,source=${directory}/docker.cfg,target=/run/frameleaf-host/docker.cfg,readonly`,
    '-e', `MANAGER_DATA=${directory}/state`, '-e', `MANAGER_BACKUP_ROOT=${directory}/backup`,
    '-e', `MANAGER_DATABASE_ROOTS=${directory}/custom-appdata`,
    '-e', `MANAGER_STORAGE_ROOTS=${directory}/media`, '-e', `MANAGER_ORIGIN=${origin}`, 'frameleaf-manager:test');
  let status;
  for (let i = 0; i < 60; i++) {
    try { status = await request('status'); if (status.status === 200) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(status?.status, 200); assert.equal(status.body.claimed, false);
  assert.equal((await request('dashboard')).status, 401);
  assert.equal((await request('claim', { name: 'Test administrator', password: 'a long disposable password', proof: '0'.repeat(64) })).status, 401);
  const proof = docker('exec', name, 'cat', `${directory}/state/claim-key`).trim();
  const claim = await request('claim', { name: 'Test administrator', password: 'a long disposable password', proof });
  assert.equal(claim.status, 201); assert.match(claim.headers['set-cookie'][0], /HttpOnly/); assert.match(claim.headers['set-cookie'][0], /Secure/);
  const cookie = claim.headers['set-cookie'][0].split(';')[0], csrf = claim.body.csrf;
  const auth = { Cookie: cookie, 'X-CSRF-Token': csrf };
  const dashboard = await request('dashboard', undefined, auth);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.databaseStorage.detectedPath, `${directory}/custom-appdata`);
  assert.equal(dashboard.body.databaseStorage.suggestedPath, `${directory}/custom-appdata`);
  evidence.checks.customUnraidAppdataDetection = 'passed';
  assert.equal((await request('profile', { firstName: 'Test', lastName: '', email: 'test@example.test', account: 'local' }, { Cookie: cookie })).status, 403);
  assert.equal((await request('profile', { firstName: 'Test', lastName: '', email: 'test@example.test', account: 'local' }, { ...auth, Origin: 'https://evil.test' })).status, 403);
  assert.equal((await request('status', undefined, { Host: 'evil.test' })).status, 403);
  evidence.checks.httpsAuthenticationCsrfAndRebinding = 'passed';
  docker('restart', name);
  for (let i = 0; i < 30; i++) { try { if ((await request('status')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 1000)); }
  assert.equal((await request('status')).body.claimed, true);
  assert.equal((await request('dashboard', undefined, auth)).status, 200);
  evidence.checks.managerReplacementAndSessionPersistence = 'passed';
} finally {
  try { docker('rm', '-f', name); } catch {}
  await writeFile('manager-evidence.json', JSON.stringify(evidence, null, 2));
  // Manager creates private root-owned files. Remove only this disposable fixture through Docker.
  try { docker('run', '--rm', '--mount', `type=bind,source=${directory},target=/fixture`, '--entrypoint', 'rm', 'frameleaf-manager:test', '-rf', '/fixture/state'); } catch {}
  await rm(directory, { recursive: true, force: true });
}
