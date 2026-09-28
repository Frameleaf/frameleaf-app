import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const composeFiles = ['-f', join(root, 'e2e/docker-compose.fork-roundtrip.yml'), '-f', join(root, 'e2e/docker-compose.cli-migrate.yml')];
const compose = (...args) => execFileSync('docker', ['compose', ...composeFiles, ...args], { cwd: root, stdio: 'inherit' });
const fork = 'http://127.0.0.1:2287/api';
const official = 'http://127.0.0.1:2288/api';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');

const api = async (base, path, token, method = 'GET', body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body instanceof FormData ? body : body && JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} on ${base} returned ${response.status}: ${await response.text()}`);
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : response.arrayBuffer();
};

const waitReady = async (base) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await api(base, '/server/ping')).res === 'pong') return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${base} did not become ready`);
};

const keyFor = async (base) => {
  const credentials = { email: 'cli-migration@example.test', password: 'Certification123!', name: 'CLI Migration' };
  await api(base, '/auth/admin-sign-up', undefined, 'POST', credentials);
  const { accessToken } = await api(base, '/auth/login', undefined, 'POST', credentials);
  const { secret } = await api(base, '/api-keys', accessToken, 'POST', { name: 'CLI migration fixture', permissions: ['all'] });
  return { accessToken, secret };
};

const run = () => {
  const manifest = JSON.parse(readFileSync(join(root, 'server/src/fork-schema/supported-versions.json')));
  const tag = manifest.certifiedTags[0];
  assert.equal(tag, 'v3.1.0');
  process.env.OFFICIAL_IMMICH_TAG = tag;
  process.env.FORK_ROUNDTRIP_CANDIDATE_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  compose('pull', 'official-server', 'redis');
  const digest = execFileSync('docker', ['image', 'inspect', `ghcr.io/immich-app/immich-server:${tag}`, '--format', '{{index .RepoDigests 0}}'], { encoding: 'utf8' }).trim();
  assert.equal(digest, `ghcr.io/immich-app/immich-server@${manifest.certification.officialDigest}`);
  compose('build', 'database', 'fork-server');
  compose('up', '-d', 'database', 'redis', 'official-database', 'official-redis', 'fork-server', 'official-server');
  return main();
};

const main = async () => {
  await Promise.all([waitReady(fork), waitReady(official)]);
  const from = await keyFor(fork);
  const to = await keyFor(official);
  const body = new FormData();
  const now = new Date().toISOString();
  body.set('assetData', new Blob([png], { type: 'image/png' }), 'fork-to-official.png');
  body.set('fileCreatedAt', now);
  body.set('fileModifiedAt', now);
  const sourceAsset = await api(fork, '/assets', from.accessToken, 'POST', body);
  await api(fork, '/albums', from.accessToken, 'POST', { albumName: 'CLI compatibility', assetIds: [sourceAsset.id] });

  const ledger = join(mkdtempSync(join(tmpdir(), 'immich-cli-migrate-')), 'ledger.sqlite');
  const migrate = (...args) => execFileSync('node', [join(root, 'packages/cli/bin/immich'), 'migrate', ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, IMMICH_FROM_URL: fork, IMMICH_FROM_KEY: from.secret, IMMICH_TO_URL: official, IMMICH_TO_KEY: to.secret },
  });
  migrate('--ledger', ledger, '--no-faces');
  migrate('--verify', '--ledger', ledger);

  const report = JSON.parse(readFileSync(`${ledger}.audit.json`));
  assert.equal(report.ok, true);
  assert.deepEqual(report.assets, { total: 1, transferred: 1, checked: 1, verified: 1, missing: 0, failed: 0 });
  assert.equal(report.totals.albumsLinked, 1);
  assert.equal(report.unresolvedCount, 0);
  const sourceSearch = await api(fork, '/search/metadata', from.accessToken, 'POST', { size: 100, page: 1 });
  const checksum = sourceSearch.assets.items.find((asset) => asset.id === sourceAsset.id)?.checksum;
  assert.equal(checksum, createHash('sha256').update(png).digest('base64'), 'fork source checksum must be SHA-256');
  const search = await api(official, '/search/metadata', to.accessToken, 'POST', { size: 100, page: 1 });
  const migrated = search.assets.items.find((asset) => asset.checksum === createHash('sha1').update(png).digest('base64'));
  assert(migrated, 'official destination lacks the SHA-1 checksum of the source bytes');
  const bytes = Buffer.from(await api(official, `/assets/${migrated.id}/original`, to.accessToken));
  assert.deepEqual(bytes, png, 'official destination changed the original bytes');
  const albums = await api(official, '/albums', to.accessToken);
  const album = albums.find((item) => item.albumName === 'CLI compatibility');
  assert(album, 'official destination lacks the migrated album');
  const detail = await api(official, `/albums/${album.id}`, to.accessToken);
  assert.equal(detail.albumName, 'CLI compatibility');
  assert.equal(detail.assetCount, 1);
  const members = await api(official, '/search/metadata', to.accessToken, 'POST', { albumIds: [album.id], visibility: 'timeline', size: 100, page: 1 });
  assert.deepEqual(members.assets.items.map((asset) => asset.id), [migrated.id], 'official album must contain exactly the migrated asset');
  console.log('Fork to official CLI migration and destination-only verification passed.');
};

try {
  await run();
} finally {
  compose('down', '--volumes', '--remove-orphans');
}
