// End-to-end import from a real upstream Immich on an Unraid-shaped Docker host.
// Run before each Manager release:  node manager/test/unraid-import.mjs
//   MANAGER_IMAGE  Manager image on the outer engine to test (default frameleaf-manager:unraid-qa;
//                  build it with `docker build -f manager/Dockerfile -t frameleaf-manager:unraid-qa .`)
//   IMMICH_TAG     Immich release whose compose file is used (default: latest GitHub release)
//   FRAMELEAF_TAG  Frameleaf release Manager installs (default: newest one Manager offers)
//   KEEP=1         leave the simulated host running for inspection (and its image cache for the next run)
//   FRESH=1        start without the cached images of a previous KEEP=1 run
// Everything runs inside one privileged docker:dind container ("the NAS") with its own volumes, so
// the shared Docker engine's containers are never seen, fenced or touched by Manager.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';

const HOST = 'fl-unraid-qa';
const VOLUMES = [`${HOST}-docker`, `${HOST}-mnt`, `${HOST}-boot`];
const MANAGER_PORT = 22282, APP_PORT = 22283; // outer loopback ports → NAS 2282 (Manager) and 2283 (Immich, then Frameleaf)
const MANAGER_IMAGE = process.env.MANAGER_IMAGE ?? 'frameleaf-manager:unraid-qa';
const APPDATA = '/mnt/user/appdata';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const report = { startedAt: new Date().toISOString(), refusals: [], steps: [] };
const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const docker = (args, input) =>
  execFileSync('docker', args, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
/** Shell on the simulated NAS. */
const nas = (script, input) => docker(['exec', '-i', HOST, 'sh', '-euc', script], input);
const sh = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

async function step(name, work) {
  log(`▶ ${name}`);
  const started = Date.now();
  try {
    const result = await work();
    report.steps.push({ name, seconds: Math.round((Date.now() - started) / 1000), ok: true });
    return result;
  } catch (error) {
    report.steps.push({ name, seconds: Math.round((Date.now() - started) / 1000), ok: false, error: String(error?.message ?? error) });
    throw error;
  }
}
async function until(what, check, seconds = 300) {
  for (let i = 0; i < seconds; i += 2) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (error.fatal) throw error;
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------- tiny distinct PNGs (stdlib only) ----------
function png(r, g, b) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const size = 64, row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set([r, (g + x) & 255, b], 1 + x * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- HTTP ----------
async function immich(path, { token, method, body, form } = {}) {
  const response = await fetch(`http://127.0.0.1:${APP_PORT}/api/${path}`, {
    method: method ?? (body || form ? 'POST' : 'GET'),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method ?? 'POST/GET'} /api/${path} → ${response.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
let session = {};
/** Manager API through the NAS's published port, with the Host header a browser on the LAN would send. */
function manager(path, body) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      `https://127.0.0.1:${MANAGER_PORT}/manager-api/${path}`,
      {
        rejectUnauthorized: false,
        method: body ? 'POST' : 'GET',
        headers: {
          Host: 'tower.local:2282',
          Origin: 'https://tower.local:2282',
          'Content-Type': 'application/json',
          ...(session.cookie ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
        },
      },
      (response) => {
        let text = '';
        response.on('data', (c) => (text += c));
        response.on('end', () => {
          const parsed = response.headers['content-type']?.includes('json') ? JSON.parse(text) : text;
          resolve({ status: response.statusCode, headers: response.headers, body: parsed });
        });
      },
    );
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
}
/** Every Manager refusal is recorded: each one is a bug or a missing piece of documentation. */
async function call(path, body, { expect = [200, 201] } = {}) {
  const response = await manager(path, body);
  if (!expect.includes(response.status)) {
    report.refusals.push({ path, status: response.status, code: response.body?.code, detail: response.body?.detail });
    throw new Error(`${path} refused: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

// ---------- Unraid template → docker run, the way dockerMan renders it ----------
function renderTemplate(xml, values) {
  const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
  const text = (name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? '';
  const args = ['run', '-d', `--name=${text('Name')}`, `--net=${text('Network')}`, '--pids-limit', '2048'];
  args.push('-e', 'TZ=America/Edmonton', '-e', 'HOST_OS=Unraid', '-e', 'HOST_HOSTNAME=Tower', '-e', `HOST_CONTAINERNAME=${text('Name')}`);
  args.push('-l', 'net.unraid.docker.managed=dockerman', '-l', `net.unraid.docker.webui=${text('WebUI')}`, '-l', `net.unraid.docker.icon=${text('Icon')}`);
  for (const [, tag, body] of xml.matchAll(/<Config ([^>]*)>([^<]*)<\/Config>/g)) {
    const name = attr(tag, 'Name'), type = attr(tag, 'Type'), target = attr(tag, 'Target'), mode = attr(tag, 'Mode');
    const value = values[name] ?? body;
    if (type === 'Port') args.push('-p', `${value}:${target}/${mode}`);
    else if (type === 'Variable') args.push('-e', `${target}=${value}`);
    else if (type === 'Path' && value) args.push('-v', `${value}:${target}:${mode}`); // dockerMan skips empty paths
  }
  args.push(...text('ExtraParams').split(/\s+/).filter(Boolean), text('Repository'));
  return args;
}

async function main() {
  // ---------- 1. The NAS ----------
  await step('start simulated Unraid host (docker:dind)', async () => {
    // A previous KEEP=1 run's host and volumes are this harness's own; nothing else is touched.
    try {
      docker(['rm', '-f', '-v', HOST]);
    } catch {}
    // The engine volume keeps pulled images between local runs (FRESH=1 drops it); everything else starts empty.
    for (const v of VOLUMES) {
      if (v !== `${HOST}-docker` || process.env.FRESH)
        try {
          docker(['volume', 'rm', v]);
        } catch {}
      docker(['volume', 'create', v]);
    }
    docker([
      'run', '-d', '--privileged', '--name', HOST, '--hostname', 'Tower',
      '-e', 'DOCKER_TLS_CERTDIR=',
      '-v', `${HOST}-docker:/var/lib/docker`, // docker.img's loop mount on real Unraid
      '-v', `${HOST}-mnt:/mnt/user`, // the array/pool share tree; a separate disk from Docker's root
      '-v', `${HOST}-boot:/boot`, // the flash drive
      '-p', `127.0.0.1:${MANAGER_PORT}:2282`, '-p', `127.0.0.1:${APP_PORT}:2283`,
      'docker:dind',
      '--registry-mirror=https://mirror.gcr.io', // Docker Hub's anonymous limit on shared CI runners; falls back to Hub
    ]);
    await until('inner Docker engine', () => nas('docker info >/dev/null && echo ok').includes('ok'), 120);
    nas(`docker ps -aq | xargs -r docker rm -f >/dev/null; docker volume prune -af >/dev/null; docker network prune -f >/dev/null
      rm -f "$(docker info --format '{{.DockerRootDir}}')/unraid-autostart"
      # A cached engine restarts the last run's containers at boot; they may already have written here.
      rm -rf /mnt/user/* /boot/*`);
  });
  const dockerRoot = nas(`docker info --format '{{.DockerRootDir}}'`).trim();
  const autostart = `${dockerRoot}/unraid-autostart`;

  await step('Unraid layout: docker.cfg, appdata, shares', () =>
    nas(`
      mkdir -p /boot/config/plugins/compose.manager/projects/immich ${APPDATA}/immich/library ${APPDATA}/immich/postgres \
        ${APPDATA}/frameleaf-manager ${APPDATA}/frameleaf-media ${APPDATA}/frameleaf-databases ${APPDATA}/frameleaf-backups \
        ${APPDATA}/filebrowser /mnt/user/photos /mnt/user/system/docker
      cat > /boot/config/docker.cfg <<'EOF'
DOCKER_ENABLED="yes"
DOCKER_IMAGE_FILE="/mnt/user/system/docker/docker.img"
DOCKER_IMAGE_SIZE="40"
DOCKER_APP_CONFIG_PATH="${APPDATA}/"
DOCKER_APP_UNRAID_PATH=""
DOCKER_READMORE="yes"
EOF
      # Immich mounts /etc/localtime; a cached engine's restarted containers may have created it as a directory.
      [ -d /etc/localtime ] && rmdir /etc/localtime
      [ -e /etc/localtime ] || cp /usr/share/zoneinfo/UTC /etc/localtime 2>/dev/null || touch /etc/localtime
    `),
  );

  // ---------- 2. Upstream Immich via its official compose ----------
  const immichTag =
    process.env.IMMICH_TAG ?? JSON.parse(execFileSync('gh', ['api', 'repos/immich-app/immich/releases/latest'], { encoding: 'utf8' })).tag_name;
  report.immich = immichTag;
  const project = '/boot/config/plugins/compose.manager/projects/immich';
  const dbPassword = randomBytes(12).toString('hex');
  await step(`Immich ${immichTag}: official compose up (server, database, redis)`, async () => {
    nas(`
      cd ${project}
      wget -qO docker-compose.yml https://github.com/immich-app/immich/releases/download/${immichTag}/docker-compose.yml
      wget -qO .env https://github.com/immich-app/immich/releases/download/${immichTag}/example.env
      sed -i -e 's#^UPLOAD_LOCATION=.*#UPLOAD_LOCATION=${APPDATA}/immich/library#' \
             -e 's#^DB_DATA_LOCATION=.*#DB_DATA_LOCATION=${APPDATA}/immich/postgres#' \
             -e 's#^DB_PASSWORD=.*#DB_PASSWORD=${dbPassword}#' -e 's#^IMMICH_VERSION=.*#IMMICH_VERSION=${immichTag}#' .env
      # Unraid's compose plugin labels its containers so the Docker page manages them.
      cat > docker-compose.override.yml <<'EOF'
services:
  immich-server: { labels: { net.unraid.docker.managed: dockerman } }
  database: { labels: { net.unraid.docker.managed: dockerman } }
  redis: { labels: { net.unraid.docker.managed: dockerman } }
EOF
      docker compose up -d --quiet-pull immich-server database redis
    `);
    await until('Immich API', async () => (await immich('server/ping')).res === 'pong', 600);
  });

  const admin = { email: 'admin@tower.local', password: 'Unraid-QA-admin-1', name: 'Tower Admin' };
  const expected = await step('Immich: admin, second user, assets, albums, settings', async () => {
    await immich('auth/admin-sign-up', { body: admin });
    const { accessToken: token } = await immich('auth/login', { body: { email: admin.email, password: admin.password } });
    await immich('admin/users', { token, body: { email: 'family@tower.local', password: 'Unraid-QA-family-1', name: 'Family' } });
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const form = new FormData();
      form.set('assetData', new Blob([png(40 * i, 90, 255 - 30 * i)], { type: 'image/png' }), `IMG_${1000 + i}.png`);
      form.set('deviceAssetId', `unraid-qa-${i}`);
      form.set('deviceId', 'unraid-qa');
      form.set('fileCreatedAt', new Date(Date.UTC(2024, i, 1)).toISOString());
      form.set('fileModifiedAt', new Date(Date.UTC(2024, i, 1)).toISOString());
      ids.push((await immich('assets', { token, form })).id);
    }
    await immich('albums', { token, body: { albumName: 'Summer', assetIds: ids.slice(0, 3) } });
    await immich('albums', { token, body: { albumName: 'Winter', assetIds: ids.slice(3) } });
    // Save settings Immich 2.x/3.x store in system_metadata (only non-default values are persisted).
    const config = await immich('system-config', { token });
    config.oauth.buttonText = 'Sign in with Tower SSO';
    config.nightlyTasks.startTime = '03:30';
    config.theme.customCss = '.qa { color: rebeccapurple; }';
    config.templates.email.welcomeTemplate = 'Welcome to the tower';
    if (config.integrityChecks) {
      const key = Object.keys(config.integrityChecks)[0];
      const value = config.integrityChecks[key];
      if (value && typeof value === 'object' && 'enabled' in value) value.enabled = !value.enabled;
      else if (typeof value === 'boolean') config.integrityChecks[key] = !value;
    }
    await immich('system-config', { token, method: 'PUT', body: config });
    // A fork-only key upstream's API would reject: written straight into system_metadata as a fork would.
    nas(`docker exec immich_postgres psql -U postgres -d immich -v ON_ERROR_STOP=1 -c ${sh(
      `UPDATE system_metadata SET value = value || '{"forkExperiments":{"enabled":true}}'::jsonb WHERE key='system-config'`,
    )}`);
    const saved = JSON.parse(
      nas(`docker exec immich_postgres psql -U postgres -d immich -At -c "SELECT value FROM system_metadata WHERE key='system-config'"`),
    );
    for (const key of ['oauth', 'nightlyTasks', 'theme', 'templates', 'forkExperiments']) assert.ok(saved[key], `system_metadata lacks ${key}`);
    report.immichSettingsKeys = Object.keys(saved);
    const stats = await immich('server/statistics', { token });
    return { users: (await immich('admin/users', { token })).length, assets: stats.photos + stats.videos, albums: (await immich('albums', { token })).length };
  });
  report.expected = expected;
  log('Immich holds', expected);

  // ---------- 3. Neighbours every real Unraid box has ----------
  await step('neighbours: share-root file manager, stopped duplicate Manager, autostart file', () => {
    nas(`docker run -d --name filebrowser --restart unless-stopped -u 0:0 -l net.unraid.docker.managed=dockerman \
      -v /mnt/user:/srv -v ${APPDATA}/filebrowser:/database filebrowser/filebrowser:latest >/dev/null`);
    // Unraid writes one container name per line (optional delay) in the order the Docker page shows.
    nas(`printf '%s\\n' immich_redis 'immich_postgres 10' immich_server filebrowser frameleaf-manager > ${autostart}`);
  });

  // ---------- 4. Manager, exactly as the Unraid template renders ----------
  await step(`load Manager image ${MANAGER_IMAGE}`, () => {
    execFileSync('sh', ['-c', `docker save ${sh(MANAGER_IMAGE)} | docker exec -i ${HOST} docker load`], { stdio: ['ignore', 'ignore', 'inherit'] });
    nas(`docker tag ${sh(MANAGER_IMAGE)} ghcr.io/frameleaf/frameleaf-manager:latest`);
  });
  const xml = readFileSync(join(ROOT, 'packaging/nas/unraid/frameleaf-manager.xml.in'), 'utf8');
  // The README: select the existing unraid-autostart under DockerRootDir, then set the controller path.
  const values = { 'Unraid autostart file': autostart, 'Autostart controller path': '/run/frameleaf-host/unraid-autostart' };
  await step('Manager: stopped older copy + template-rendered container', async () => {
    const run = renderTemplate(xml, values);
    report.managerRun = run;
    const create = [...run];
    create[0] = 'create';
    create.splice(create.indexOf('-d'), 1);
    create[create.findIndex((a) => a.startsWith('--name='))] = '--name=frameleaf-manager-old';
    create.splice(create.indexOf('-p'), 2);
    nas(`docker ${create.map(sh).join(' ')} >/dev/null`);
    nas(`docker ${run.map(sh).join(' ')} >/dev/null`);
    await until('Manager status', async () => (await manager('status')).status === 200, 120);
  });

  // ---------- 5. The import, through Manager's HTTP API ----------
  await step('claim administrator', async () => {
    const response = await manager('claim', { name: 'Tower Admin', password: 'unraid qa manager password' });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    session = { cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.body.csrf };
  });
  const dashboard = await call('dashboard');
  report.databaseStorage = dashboard.databaseStorage;
  const source = await step('sources', async () => {
    const { sources, refused } = await call('sources');
    for (const r of refused) report.refusals.push({ path: 'sources', code: r.code });
    assert.equal(sources.length, 1, `expected the Immich source, refused: ${JSON.stringify(refused)}`);
    return sources[0];
  });
  report.source = { version: source.version, platform: source.platform, summary: source.summary, unsupportedSettings: source.unsupportedSettings };
  await step('source-review', () => call('source-review', { sourceId: source.id }));
  await step('source-settings: remove the fork-only key', async () => {
    const current = await call('source-settings', { sourceId: source.id });
    assert.deepEqual(current.source.unsupportedSettings, ['forkExperiments']);
    const { forkExperiments, ...settings } = current.settings;
    const saved = await call('source-settings', { sourceId: source.id, settings });
    assert.deepEqual(saved.source.unsupportedSettings, []);
  });
  const tag = process.env.FRAMELEAF_TAG ?? (await call('releases'))[0].tag;
  report.frameleaf = tag;
  const review = await step(`review import of ${tag}`, () =>
    call('review', {
      kind: 'import',
      name: 'Tower library',
      tag,
      sourceId: source.id,
      databaseRoot: dashboard.databaseStorage.suggestedPath,
      port: 2283,
      ml: false,
      lifecycle: 'docker-only',
    }),
  );
  const operation = await step('install', async () => {
    const { id } = await call('install', { reviewId: review.id, key: randomUUID() });
    let last = '';
    return until(
      'import to finish',
      async () => {
        const op = (await call('dashboard')).operations.find((o) => o.id === id);
        if (op.step !== last) log(`  step: ${(last = op.step)}`);
        if (['failed', 'interrupted'].includes(op.state)) {
          report.refusals.push({ path: `install:${op.step}`, code: op.error, detail: op.detail });
          throw Object.assign(new Error(`import failed at ${op.step}: ${op.error} ${op.detail ?? ''}`), { fatal: true });
        }
        return op.state === 'complete' && op;
      },
      3600,
    );
  });
  report.operation = { id: operation.id, completed: operation.completed };

  // ---------- 6. Frameleaf serves the same library; Immich is fenced ----------
  await step('assert Frameleaf counts, Immich stopped, autostart fenced', async () => {
    const summary = (await call('dashboard')).summary;
    report.managerSummary = summary;
    await until('Frameleaf API', async () => (await immich('server/ping')).res === 'pong', 600);
    const { accessToken: token } = await immich('auth/login', { body: { email: admin.email, password: admin.password } });
    const stats = await immich('server/statistics', { token });
    const actual = {
      users: (await immich('admin/users', { token })).length,
      assets: stats.photos + stats.videos,
      albums: (await immich('albums', { token })).length,
    };
    report.actual = actual;
    assert.deepEqual(actual, expected);
    assert.deepEqual({ users: summary.users, assets: summary.assets, albums: summary.albums }, expected);
    // Settings arrive as edited at review: Immich's saved keys kept, the fork-only key gone.
    const config = await immich('system-config', { token });
    assert.equal(config.oauth.buttonText, 'Sign in with Tower SSO');
    assert.equal(config.nightlyTasks.startTime, '03:30');
    assert.equal(config.theme.customCss, '.qa { color: rebeccapurple; }');
    assert.equal(config.templates.email.welcomeTemplate, 'Welcome to the tower');
    const stored = JSON.parse(
      nas(`docker exec $(docker ps -qf label=com.docker.compose.service=database -f name=frameleaf-) sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT value FROM system_metadata WHERE key='"'"'system-config'"'"'"'`),
    );
    assert.equal(stored.forkExperiments, undefined);
    // Manager fences Immich's application containers; its database and Redis are left as they were.
    const state = (name) => nas(`docker inspect -f '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}' ${name}`).trim();
    report.immichAfter = Object.fromEntries(['immich_server', 'immich_postgres', 'immich_redis'].map((n) => [n, state(n)]));
    assert.equal(report.immichAfter.immich_server, 'false no');
    const lines = nas(`cat ${autostart}`).split('\n').map((l) => l.split(/\s+/)[0]).filter(Boolean);
    report.autostartAfter = lines;
    assert.deepEqual(lines, ['immich_redis', 'immich_postgres', 'filebrowser', 'frameleaf-manager']);
    assert.equal(nas(`docker inspect -f '{{.State.Running}}' filebrowser`).trim(), 'true');
  });
}

let failed = false;
try {
  await main();
  log('PASS: full Unraid import');
} catch (error) {
  failed = true;
  report.error = String(error?.stack ?? error);
  console.error(error);
  try {
    report.managerLog = nas('docker logs --tail 80 frameleaf-manager 2>&1');
  } catch {}
} finally {
  report.finishedAt = new Date().toISOString();
  const out = process.env.REPORT ?? join(process.env.RUNNER_TEMP ?? '/tmp', 'unraid-import-report.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  log(`report: ${out}`);
  if (report.refusals.length) log('refusals:', JSON.stringify(report.refusals, null, 2));
  if (!process.env.KEEP) {
    try {
      docker(['rm', '-f', '-v', HOST]);
      docker(['volume', 'rm', ...VOLUMES]);
    } catch {}
  } else log(`KEEP=1: inspect with  docker exec -it ${HOST} sh`);
  process.exitCode = failed ? 1 : 0;
}
