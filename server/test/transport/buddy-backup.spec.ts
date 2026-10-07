import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, realpath, statfs, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import postgres from 'postgres';
import { BuddyKitSchema, type BuddyRestoreStatusDto, type BuddyStatusDto } from 'src/dtos/buddy-backup.dto.js';
import { type BuddyKeyring } from 'src/utils/buddy-backup-crypto.js';
import { BuddyBackupReader } from 'src/utils/buddy-backup-reader.js';
import { type BuddySignedSnapshot } from 'src/utils/buddy-backup-vault.js';
import { BUDDY_SIDES, type BuddySide, buddyHost, buddyPort, startBuddyCloud } from 'test/fixtures/buddy-cloud.js';
import { buddyForwardingDiagnostic, startBuddyTransport } from 'test/fixtures/buddy-transport.js';
import z from 'zod';

// Fails if app capture/pg_dump/crypto/commit/restore stops working, crosses an owner, or indexes hosted media.
// Direct HTTPS enrollment remains a fixture; actual mode consumes an independently owned Cloud runtime.
// Includes paused restart and durable unpaused recovery through explicit peer backpressure.
// Simultaneous uncontrolled restart on real Cloud/relay/two networks remains unqualified.
const compose = fileURLToPath(new URL('../../../e2e/docker-compose.buddy.yml', import.meta.url));
const docker = promisify(execFile);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const password = 'FL310-owned-synthetic-fixture-24!';
const pin = { pinCode: '123456' };
const adminRoute = '/admin/buddy-backup';
const ownerRoute = '/users/me/buddy-backup';
// Same valid generated PNG as the existing live upload fixture; unique trailing data prevents deduplication.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWMAgv8AAQQBAP8H9UQAAAAASUVORK5CYII=',
  'base64',
);
type Session = { token: string; id: string };
type Item = { id: string; bytes: Buffer; path: string };
type App = { side: BuddySide; url: string; db: ReturnType<typeof postgres>; admin: Session; member: Session };
type Browse = {
  items: Array<{ id: string; name: string; ownerId: string }>;
  albums: Array<{ id: string; name: string }>;
};
type Asset = { id: string; isFavorite: boolean; exifInfo?: { description?: string } };

const response = (app: Pick<App, 'url'>, path: string, method = 'GET', token?: string, body?: unknown) =>
  fetch(`${app.url}/api${path}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
const json = async <T>(
  app: Pick<App, 'url'>,
  path: string,
  method = 'GET',
  token?: string,
  body?: unknown,
  status = 200,
): Promise<T> => {
  const answer = await response(app, path, method, token, body);
  if (answer.status !== status) {
    await answer.body?.cancel();
    throw new Error(`${method} ${path}: expected ${status}, got ${answer.status}`);
  }
  return status === 204 ? (undefined as T) : ((await answer.json()) as T);
};
const until = async <T>(
  label: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms = 120_000,
): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    await delay(1000);
  }
  throw new Error(`${label} did not complete within ${ms}ms`);
};
const unlock = (app: App, session = app.admin) => json(app, '/auth/session/unlock', 'POST', session.token, pin, 204);
const status = (app: App) => json<BuddyStatusDto>(app, adminRoute, 'GET', app.admin.token);
const login = async (app: Pick<App, 'url'>, email: string): Promise<Session> => {
  const signed = await json<{ accessToken: string }>(app, '/auth/login', 'POST', undefined, { email, password }, 201);
  const own = await json<{ id: string }>(app, '/users/me', 'GET', signed.accessToken);
  return { token: signed.accessToken, id: own.id };
};
const upload = async (app: App, name: string, session = app.admin): Promise<Item> => {
  const bytes = Buffer.concat([png, Buffer.from(randomUUID())]);
  const form = new FormData();
  form.set('assetData', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name);
  form.set('fileCreatedAt', '2026-09-01T12:00:00.000Z');
  form.set('fileModifiedAt', '2026-09-01T12:00:00.000Z');
  const answer = await fetch(`${app.url}/api/assets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (answer.status !== 201) {
    await answer.body?.cancel();
    throw new Error(`Synthetic upload failed: ${answer.status}`);
  }
  const { id } = (await answer.json()) as { id: string };
  const rows = await app.db<{ originalPath: string }[]>`select "originalPath" from asset where id=${id}`;
  expect(rows).toHaveLength(1);
  return { id, bytes, path: rows[0].originalPath };
};
const original = async (app: App, item: Item, token = app.admin.token) => {
  const answer = await response(app, `/assets/${item.id}/original`, 'GET', token);
  expect(answer.status).toBe(200);
  expect(digest(Buffer.from(await answer.arrayBuffer()))).toBe(digest(item.bytes));
};
const localMedia = (root: string, side: BuddySide, path: string) => {
  if (!path.startsWith('/data/') || path.split('/').includes('..')) {
    throw new Error('Unexpected synthetic asset path');
  }
  return join(root, side, 'media', path.slice('/data/'.length));
};
const absent = async (path: string) => {
  try {
    await access(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true;
    }
    throw error;
  }
};

it('retains causal forwarding state without leaking request identities or error text', () => {
  const secret = 'private-fixture-sentinel';
  const state = { reusedSocket: true, requestAborted: false, responseDestroyed: false, responseFinished: false };
  for (const [path, category] of [
    ['handshake', 'handshake'],
    ['reservations', 'reservations'],
    [`objects/${'a'.repeat(64)}`, 'object'],
    ['snapshots', 'snapshots'],
    [`snapshots/${secret}`, 'snapshot'],
    [`unknown/${secret}`, 'other'],
  ]) {
    const diagnostic = buddyForwardingDiagnostic(
      'GET',
      `/api/buddy/v1/vaults/${secret}/${path}?token=${secret}`,
      'ECONNRESET',
      'delete-restart-and-restore',
      'backup',
      state,
    );
    expect(diagnostic).toMatchObject({
      method: 'GET',
      category,
      code: 'ECONNRESET',
      phase: 'delete-restart-and-restore',
      admittedPhase: 'backup',
      ...state,
    });
    expect(diagnostic.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
  }
  for (const phase of [
    'delete-before-restart',
    'owned-compose-restart',
    'awaiting-both-peer-apis',
    'restore-after-peer-readiness',
  ]) {
    const diagnostic = buddyForwardingDiagnostic(
      'GET',
      `/api/buddy/v1/vaults/${secret}/handshake?token=${secret}`,
      'ECONNRESET',
      phase,
      phase,
      state,
    );
    expect(diagnostic).toMatchObject({ phase, admittedPhase: phase });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
  }
  const unknown = buddyForwardingDiagnostic(secret, `/api/${secret}`, new Error(secret), secret, secret, state);
  expect(unknown).toMatchObject({
    method: 'OTHER',
    category: 'other',
    code: 'UNKNOWN',
    phase: 'unknown',
    admittedPhase: 'unknown',
  });
  expect(JSON.stringify(unknown)).not.toContain(secret);
});

it('backs up and restores two real apps bidirectionally without exposing hosted Buddy photos', async () => {
  const started = Date.now();
  const mode = process.env.BUDDY_CLOUD_MODE ?? 'fake';
  expect(['fake', 'actual']).toContain(mode);
  const actual = mode === 'actual';
  const root = await realpath(process.env.BUDDY_ROOT ?? '');
  expect(process.env.CI).toBeTruthy();
  expect(process.env.FRAMELEAF_BUDDY_BACKUP).toBe('true');
  expect(basename(root)).toMatch(/^fl310-buddy\.[\w]+$/);
  await access(join(root, '.fl310-buddy-fixture'));
  const report: Record<string, unknown> = {
    source: process.env.GITHUB_SHA,
    scope: actual
      ? 'two-real-apps/actual-cloud-fixture-enrollment'
      : 'two-real-apps/direct-fixture-coordinator-and-enrollment',
    restartMode: 'controlled-paused-restart',
    unpausedRecoveryMode: 'durable-pending-verification/explicit-peer-unavailability',
    phase: 'setup',
    passed: false,
  };
  const lifecycle: Array<{
    timestamp: string;
    event: string;
    side?: BuddySide;
    backupComplete?: boolean;
    verificationComplete?: boolean;
    runState?: string | null;
    sendingPaused?: boolean;
  }> = [];
  report.lifecycle = lifecycle;
  const apps: App[] = [];
  const transports: Array<Awaited<ReturnType<typeof startBuddyTransport>>> = [];
  let coordinator: Awaited<ReturnType<typeof startBuddyCloud>> | undefined;
  try {
    const manifest = actual
      ? z
          .object({
            sourceHead: z.string().regex(/^[a-f\d]{40}$/),
            executingSource: z.object({
              builtFromCleanHead: z.string().regex(/^[a-f\d]{40}$/),
              sourceTrees: z.object({
                api: z.string().regex(/^[a-f\d]{64}$/),
                contracts: z.string().regex(/^[a-f\d]{64}$/),
              }),
              compiledTrees: z.object({
                api: z.string().regex(/^[a-f\d]{64}$/),
                contracts: z.string().regex(/^[a-f\d]{64}$/),
              }),
            }),
            origin: z.url(),
            accounts: z.object({ a: z.uuid(), b: z.uuid() }),
            ownedFixtureOnly: z.literal(true),
            isolatedPostgres: z.literal(true),
            isolatedValkey: z.literal(true),
            providerOverrides: z.literal(0),
            bearerCompatibility: z.literal(false),
          })
          .parse(JSON.parse(await readFile(process.env.BUDDY_CLOUD_MANIFEST ?? '', 'utf8')))
      : undefined;
    const control = async (command: Record<string, unknown>) => {
      // All command input stays on stdin; discard child errors/output to keep codes and keys private.
      try {
        if (!process.env.BUDDY_CLOUD_CONTROL_NODE || !process.env.BUDDY_CLOUD_CONTROL_CLIENT) {
          throw new Error('Missing owned Cloud control client');
        }
        const input = JSON.stringify(command);
        if (Buffer.byteLength(input) > 4096) {
          throw new Error('Owned Cloud control input too large');
        }
        const stdout = await new Promise<string>((resolve, reject) => {
          const child = execFile(
            process.env.BUDDY_CLOUD_CONTROL_NODE!,
            [process.env.BUDDY_CLOUD_CONTROL_CLIENT!, '-'],
            { timeout: 20_000, maxBuffer: 64 * 1024 },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          );
          child.stdin!.on('error', reject);
          child.stdin!.end(input);
        });
        const reply = JSON.parse(stdout) as { ok: boolean; result: unknown };
        if (reply.ok !== true) {
          throw new Error('Owned Cloud control refused');
        }
        return reply.result;
      } catch {
        throw new Error('Owned Cloud control unavailable or refused; private command input omitted');
      }
    };
    if (manifest) {
      expect(process.env.FRAMELEAF_CLOUD_URL).toBe(manifest.origin);
      expect(process.env.BUDDY_CLOUD_SOURCE_SHA).toBe(manifest.sourceHead);
      const live = z
        .object({
          origin: z.url(),
          accounts: z.object({ a: z.uuid(), b: z.uuid() }),
          instances: z.array(z.unknown()),
          pairings: z.array(z.unknown()),
          executingSource: z.object({
            builtFromCleanHead: z.string().regex(/^[a-f\d]{40}$/),
            sourceTrees: z.object({
              api: z.string().regex(/^[a-f\d]{64}$/),
              contracts: z.string().regex(/^[a-f\d]{64}$/),
            }),
            compiledTrees: z.object({
              api: z.string().regex(/^[a-f\d]{64}$/),
              contracts: z.string().regex(/^[a-f\d]{64}$/),
            }),
          }),
        })
        .parse(await control({ command: 'status' }));
      expect(live.origin).toBe(manifest.origin);
      expect(live.accounts).toEqual(manifest.accounts);
      expect(live.instances).toHaveLength(0);
      expect(live.pairings).toHaveLength(0);
      report.manifestCloudSource = manifest.sourceHead;
      expect(live.executingSource.builtFromCleanHead).toBe(process.env.BUDDY_CLOUD_SOURCE_SHA);
      expect(live.executingSource).toEqual(manifest.executingSource);
      report.executingCloudSource = live.executingSource;
      // Arm exactly once before any Library Cloud/device request; fresh app DBs must have no link token.
      const armed = z.object({ armed: z.literal(true) }).parse(await control({ command: 'privacy-start' }));
      report.cloudPrivacy = armed;
    } else {
      coordinator = await startBuddyCloud();
    }
    const accounts = manifest?.accounts ?? coordinator!.accounts;
    const kits: BuddyKeyring[] = [];
    const items: Array<{ missing: Item; current: Item; member: Item; emptyAlbum: string; album: string }> = [];
    const snapshotIds: string[] = [];
    const sentinels: string[] = [];
    for (const side of BUDDY_SIDES) {
      const url = `http://127.0.0.1:${side === 'a' ? 3285 : 3286}`;
      const db = postgres(`postgres://postgres:postgres@127.0.0.1:${side === 'a' ? 5535 : 5536}/frameleaf`, {
        max: 2,
        connection: { search_path: 'public' },
      });
      const app = { side, url, db, admin: { token: '', id: '' }, member: { token: '', id: '' } };
      apps.push(app);
      expect((await db`show fsync`)[0].fsync).toBe('on');
      await json(
        app,
        '/auth/admin-sign-up',
        'POST',
        undefined,
        { email: `fl310-${side}@example.test`, name: `Buddy ${side}`, password, setupCode: 'E2ESETUP' },
        201,
      );
      app.admin = await login(app, `fl310-${side}@example.test`);
      await json(app, '/auth/pin-code', 'POST', app.admin.token, pin, 204);
      await unlock(app);
      await json(
        app,
        '/admin/users',
        'POST',
        app.admin.token,
        { email: `fl310-member-${side}@example.test`, name: 'Member', password, shouldChangePassword: false },
        201,
      );
      app.member = await login(app, `fl310-member-${side}@example.test`);
      await json(app, '/auth/pin-code', 'POST', app.member.token, pin, 204);
      await unlock(app, app.member);
      const config = await json<{ frameleafCloud: { remoteAccess: { enabled: boolean } } }>(
        app,
        '/admin/config',
        'GET',
        app.admin.token,
      );
      expect(config.frameleafCloud.remoteAccess.enabled).toBe(false);
      const link = await json<{ state: string; pending: { userCode: string } | null }>(
        app,
        '/admin/cloud/link',
        'POST',
        app.admin.token,
        undefined,
        201,
      );
      expect(link.state).toBe('pending');
      if (actual) {
        if (!link.pending?.userCode) {
          throw new Error('Actual device link did not emit an approval code');
        }
        await control({ command: 'approve', account: side, userCode: link.pending.userCode });
      }
      await until(
        'Normal device linking',
        () => json<{ state: string }>(app, '/admin/cloud/link', 'GET', app.admin.token),
        (value) => value.state === 'linked',
      );

      const prefix = `fl310-private-${side}-${randomUUID()}`;
      sentinels.push(prefix);
      const missing = await upload(app, `${prefix}-missing.png`);
      const current = await upload(app, `${prefix}-keep.png`);
      const member = await upload(app, `${prefix}-member.png`, app.member);
      await until(
        'Real upload metadata',
        () =>
          db<{ count: number }[]>`
            select count(*)::int as count from asset_exif
            where "assetId" in (${missing.id},${current.id},${member.id}) and "fileSizeInByte" > 0
          `,
        (rows) => rows[0].count === 3,
      );
      await json(app, `/assets/${current.id}`, 'PUT', app.admin.token, {
        description: 'Captured description',
        isFavorite: true,
      });
      const album = await json<{ id: string }>(
        app,
        '/albums',
        'POST',
        app.admin.token,
        { albumName: `${prefix}-album`, assetIds: [missing.id, current.id] },
        201,
      );
      const empty = await json<{ id: string }>(
        app,
        '/albums',
        'POST',
        app.admin.token,
        { albumName: `${prefix}-empty` },
        201,
      );
      items.push({ missing, current, member, emptyAlbum: empty.id, album: album.id });
      const preflight = await json<{
        stagingAvailableBytes: number;
        hostingAvailableBytes: number | null;
        databaseBytes: number;
      }>(
        app,
        `${adminRoute}/preflight`,
        'POST',
        app.admin.token,
        { directory: '/buddy-host', configurationFiles: [] },
        201,
      );
      const fs = await statfs(join(root, side, 'incoming'));
      const reserve = Math.max(10 * 1024 ** 3, fs.blocks * fs.bsize * 0.1);
      if (
        fs.bavail * fs.bsize - reserve < 512 * 1024 ** 2 ||
        preflight.stagingAvailableBytes < 3 * preflight.databaseBytes
      ) {
        throw new Error('Hosted runner lacks real Buddy reserve plus staging space; capacity was not mocked');
      }
      expect(preflight.hostingAvailableBytes).toBeGreaterThan(512 * 1024 ** 2);
      await json(app, `${adminRoute}/settings`, 'PUT', app.admin.token, {
        directory: '/buddy-host',
        quotaBytes: 10 * 1024 ** 3,
        timezone: 'UTC',
        schedule: '0 0 1 1 *',
        uploadMbps: 20,
        downloadMbps: 20,
        windowStart: '00:00',
        windowEnd: '00:00',
      });
    }
    const [a, b] = apps;
    const invite = await json<{ token: string }>(
      a,
      `${adminRoute}/invitations`,
      'POST',
      a.admin.token,
      {
        version: 1,
        instanceId: (await status(a)).instanceId,
        targetAccountId: accounts.b,
        quotaBytes: 10 * 1024 ** 3,
        retention: { days: 30, monthly: 12 },
      },
      201,
    );
    await json(
      b,
      `${adminRoute}/invitations/accept`,
      'POST',
      b.admin.token,
      {
        version: 1,
        token: invite.token,
        instanceId: (await status(b)).instanceId,
        quotaBytes: 10 * 1024 ** 3,
        retention: { days: 30, monthly: 12 },
      },
      201,
    );
    for (const app of apps) {
      await json(app, `${adminRoute}/relationship`, 'POST', app.admin.token, { action: 'confirm' }, 201);
    }
    for (const app of apps) {
      await json(app, `${adminRoute}/refresh`, 'POST', app.admin.token, undefined, 201);
    }
    const pair = (await status(a)).pairing;
    if (!pair) {
      throw new Error('Actual Library status did not return a pairing');
    }
    expect(pair.state).toBe('active');
    if (coordinator) {
      expect(pair).toEqual(coordinator.pairing());
    }
    expect(pair.vaults[0].vaultId === pair.vaults[1].vaultId).toBe(false);
    expect(pair.vaults[0].sourceKey.x === pair.vaults[1].sourceKey.x).toBe(false);
    for (const app of apps) {
      const saved = await status(app);
      expect(saved.pairing).toEqual(pair);
      const kit = BuddyKitSchema.parse(await json(app, `${adminRoute}/key`, 'POST', app.admin.token, undefined, 201));
      kits.push(kit);
      sentinels.push(...Object.values(kit.keys));
      await json(app, `${adminRoute}/key/verify`, 'POST', app.admin.token, kit, 201);
      transports.push(await startBuddyTransport(root, app.side, saved.instanceId, () => report.phase));
    }
    if (actual) {
      report.phase = 'actual-peer-publication';
      // Never invent Cloud connections or write EdgeState: the app must publish its own real endpoint.
      for (const app of apps) {
        const published = await json<{ connections: Array<{ uri: string }> }>(app, '/server/connections');
        const expected = `https://${buddyHost(app.side)}:${buddyPort(app.side)}`;
        if (!published.connections.some(({ uri }) => uri === expected)) {
          report.peerPublication = 'missing-gate: genuine heartbeat publication matching fixture TLS/SNI required';
          throw new Error('Actual peer discovery missing: genuine published HTTPS endpoint must match fixture TLS/SNI');
        }
        await json(app, '/admin/cloud/heartbeat', 'POST', app.admin.token, undefined, 201);
      }
    }
    expect(kits[0].keys['1'] === kits[1].keys['1']).toBe(false);
    for (const app of apps) {
      await unlock(app);
      await json(app, `${adminRoute}/probe`, 'POST', app.admin.token, undefined, 201);
    }
    report.phase = 'backup';
    const sourceRuns: string[] = [];
    for (const app of apps) {
      const begun = await json<BuddyStatusDto>(
        app,
        `${adminRoute}/control`,
        'POST',
        app.admin.token,
        { action: 'start' },
        201,
      );
      expect(begun.run?.id).toBeTruthy();
      sourceRuns.push(begun.run!.id);
    }
    for (const [index, app] of apps.entries()) {
      await until(
        'Real Buddy backup worker',
        async () => {
          const state = await status(app);
          report[`backup-${app.side}`] = {
            state: state.run?.state,
            uploadedObjects: state.run?.uploadedObjects,
            lastCompleteAt: state.lastCompleteAt,
          };
          if (state.run?.state === 'incomplete') {
            throw new Error(`Server ${app.side}: real capture failed; inspect hosted diagnostics`);
          }
          const [operation] = await app.db<{ status: string }[]>`
            select status from public.media_operation where id=${sourceRuns[index]}
          `;
          return operation?.status === 'completed' && state.lastCompleteAt !== null;
        },
        Boolean,
        180_000,
      );
      const [completed] = await app.db`select status from public.media_operation where id=${sourceRuns[index]}`;
      expect(completed.status).toBe('completed');
      await unlock(app);
      const snapshots = await json<{ snapshots: Array<{ id: string }> }>(
        app,
        `${adminRoute}/snapshots`,
        'GET',
        app.admin.token,
      );
      expect(snapshots.snapshots).toHaveLength(1);
      snapshotIds.push(snapshots.snapshots[0].id);
      await until(
        'Capture staging released',
        () => absent(join(root, app.side, 'identity', 'buddy', 'runs', sourceRuns[index])),
        Boolean,
      );
    }

    report.phase = 'committed-ciphertext-and-real-dump';
    for (const [index, app] of apps.entries()) {
      const peerIndex = 1 - index;
      const peer = apps[peerIndex];
      const kit = kits[index];
      const vault = join(root, peer.side, 'incoming', kit.vaultId);
      const envelope = JSON.parse(
        await readFile(join(vault, 'snapshots', snapshotIds[index]), 'utf8'),
      ) as BuddySignedSnapshot;
      // The source owner deliberately holds its saved kit. Hosting apps never receive either plaintext key.
      const reader = new BuddyBackupReader(kit, envelope, (id) => readFile(join(vault, 'objects', id.slice(0, 2), id)));
      const manifest = await reader.manifest();
      expect(Object.keys(manifest.library.assets).sort()).toEqual(
        [items[index].missing.id, items[index].current.id, items[index].member.id].sort(),
      );
      expect(manifest.metadata?.albums[items[index].emptyAlbum]).toBeTruthy();
      const paths = [
        ...Object.values(manifest.library.assets).flatMap((asset) => asset.files),
        ...manifest.dependencies,
        ...manifest.configurationFiles,
      ];
      const includesPrivatePath = paths.some(
        (file) => file.path.startsWith('/buddy-host/') || file.path.startsWith('/buddy-identity/'),
      );
      expect(includesPrivatePath).toBe(false);
      const database = manifest.library.database!;
      expect(database).toBeTruthy();
      const content = manifest.contents[database.sha256];
      const compressed = Buffer.concat(
        await Promise.all(content.blocks.map((id) => reader.block(id, content.keyVersion))),
      );
      expect(digest(compressed)).toBe(database.sha256);
      const dump = gunzipSync(compressed, { maxOutputLength: 64 * 1024 ** 2 }).toString();
      expect(dump.includes('-- PostgreSQL database dump')).toBe(true);
      expect(dump.includes('-- PostgreSQL database dump complete')).toBe(true);
      for (const item of [items[index].missing, items[index].current, items[index].member]) {
        expect(dump.includes(item.id)).toBe(true);
      }
      for (const item of [items[peerIndex].missing, items[peerIndex].current, items[peerIndex].member]) {
        expect(dump.includes(item.id)).toBe(false);
      }
      for (const receipt of envelope.snapshot.objects) {
        const bytes = await readFile(join(vault, 'objects', receipt.id.slice(0, 2), receipt.id));
        expect(bytes.includes(items[index].missing.bytes)).toBe(false);
        for (const sentinel of sentinels) {
          expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
        }
      }
      const hosted = await status(peer);
      expect(hosted.hosting.committedBytes).toBeGreaterThan(0);
      expect(transports[peerIndex].metrics.commits).toBe(1);
      expect(transports[peerIndex].metrics.objectWrites).toBeGreaterThan(0);
      // Positive probe and local API controls distinguish a refusal from a dead application.
      expect(
        await transports[peerIndex].request(`/api/assets/${items[index].missing.id}`, {
          Authorization: `Bearer ${peer.admin.token}`,
        }),
      ).toBe(403);
      expect(
        await transports[peerIndex].request(`/api/buddy/v1/vaults/${kit.vaultId}/handshake`, {
          host: 'wrong.buddy.test',
        }),
      ).toBe(403);
      expect(await transports[peerIndex].request(`/api/buddy/v1/vaults/${randomUUID()}/handshake`)).toBe(403);
      expect(transports[peerIndex].metrics.changedProofUrlStatus).not.toBeNull();
      expect(transports[peerIndex].metrics.changedProofUrlStatus).toBeGreaterThanOrEqual(400);
      await json(app, `${adminRoute}/probe`, 'POST', app.admin.token, undefined, 201);
    }

    const verificationStartedAt = Date.now();
    lifecycle.push({ timestamp: new Date().toISOString(), event: 'verification-before-pause-started' });
    const verificationRuns: string[] = [];
    for (const app of apps) {
      await unlock(app);
      const verification = await json<BuddyStatusDto>(
        app,
        `${adminRoute}/control`,
        'POST',
        app.admin.token,
        { action: 'verify' },
        201,
      );
      expect(verification.run?.id).toBeTruthy();
      verificationRuns.push(verification.run!.id);
    }
    for (const [index, app] of apps.entries()) {
      await until(
        'Real Buddy verification settled',
        async () => {
          const state = await status(app);
          const [operation] = await app.db<{ status: string; task: string; claimToken: string | null }[]>`
            select status, snapshot->>'task' as task, "claimToken" from public.media_operation
            where id=${verificationRuns[index]}
          `;
          expect(operation.task).toBe('verify');
          if (['failed', 'cancelled'].includes(operation.status)) {
            throw new Error(`Server ${app.side}: real verification failed; inspect hosted diagnostics`);
          }
          return (
            operation.status === 'completed' &&
            operation.claimToken === null &&
            state.lastVerifiedAt !== null &&
            Date.parse(state.lastVerifiedAt) >= verificationStartedAt &&
            (await absent(join(root, app.side, 'identity', 'buddy', 'verification', verificationRuns[index])))
          );
        },
        Boolean,
      );
      lifecycle.push({ timestamp: new Date().toISOString(), event: 'verification-settled', side: app.side });
    }
    // A pause acknowledgement does not settle in-flight work. Verification completed above;
    // the durable sending pause now prevents bootstrap from starting another peer request.
    for (const app of apps) {
      const paused = await json<BuddyStatusDto>(
        app,
        `${adminRoute}/control`,
        'POST',
        app.admin.token,
        { action: 'pause-sending' },
        201,
      );
      expect(paused.settings?.pausedSending).toBe(true);
      const [claims] = await app.db<{ count: number }[]>`
        select count(*)::int as count from public.media_operation
        where kind='buddy_backup' and "claimToken" is not null
      `;
      expect(claims.count).toBe(0);
      lifecycle.push({
        timestamp: new Date().toISOString(),
        event: 'sending-paused-and-settled',
        side: app.side,
      });
    }

    report.phase = 'delete-before-restart';
    lifecycle.push({ timestamp: new Date().toISOString(), event: 'delete-started' });
    for (const [index, app] of apps.entries()) {
      await unlock(app);
      const [currentPath] = await app.db<{ originalPath: string }[]>`
        select "originalPath" from asset where id=${items[index].missing.id}
      `;
      items[index].missing.path = currentPath.originalPath;
      await json(app, '/assets', 'DELETE', app.admin.token, { ids: [items[index].missing.id], force: true }, 204);
      await until(
        'Original physically deleted',
        async () => {
          const rows = await app.db`select id from asset where id=${items[index].missing.id}`;
          return rows.length === 0 && (await absent(localMedia(root, app.side, items[index].missing.path)));
        },
        Boolean,
      );
      await json(app, `/assets/${items[index].current.id}`, 'PUT', app.admin.token, {
        description: 'Later local change',
        isFavorite: false,
      });
    }
    // Verify the controlled restart preconditions remain true after local deletion/editing.
    const beforeRestartStates = new Map<BuddySide, BuddyStatusDto>();
    for (const app of apps) {
      const beforeRestart = await status(app);
      beforeRestartStates.set(app.side, beforeRestart);
      expect(beforeRestart.lastCompleteAt).not.toBeNull();
      expect(beforeRestart.lastVerifiedAt).not.toBeNull();
      expect(beforeRestart.settings?.pausedSending).toBe(true);
      lifecycle.push({
        timestamp: new Date().toISOString(),
        event: 'before-restart-state',
        side: app.side,
        backupComplete: beforeRestart.lastCompleteAt !== null,
        verificationComplete: beforeRestart.lastVerifiedAt !== null,
        runState: beforeRestart.run?.state ?? null,
        sendingPaused: beforeRestart.settings?.pausedSending,
      });
    }
    report.phase = 'owned-compose-restart';
    lifecycle.push({ timestamp: new Date().toISOString(), event: 'compose-restart-started' });
    // Restart only the services in the owned compose file; no external stack/container names are accepted.
    await docker('docker', ['compose', '-f', compose, 'restart', 'buddy-a', 'buddy-b'], { timeout: 60_000 });
    lifecycle.push({ timestamp: new Date().toISOString(), event: 'compose-restart-returned' });
    report.phase = 'awaiting-both-peer-apis';
    for (const app of apps) {
      await until(
        'Restarted API',
        async () => {
          try {
            const ping = await response(app, '/server/ping');
            await ping.body?.cancel();
            return ping.status === 200;
          } catch {
            return false;
          }
        },
        Boolean,
      );
      await unlock(app);
      const restarted = await status(app);
      expect(restarted.pairing).toEqual(pair);
      expect(restarted.lastCompleteAt).toBe(beforeRestartStates.get(app.side)!.lastCompleteAt);
      expect(restarted.lastVerifiedAt).toBe(beforeRestartStates.get(app.side)!.lastVerifiedAt);
      expect(restarted.settings?.pausedSending).toBe(true);
      lifecycle.push({
        timestamp: new Date().toISOString(),
        event: 'peer-api-ready',
        side: app.side,
        backupComplete: restarted.lastCompleteAt !== null,
        verificationComplete: restarted.lastVerifiedAt !== null,
        runState: restarted.run?.state ?? null,
        sendingPaused: restarted.settings?.pausedSending,
      });
    }
    lifecycle.push({ timestamp: new Date().toISOString(), event: 'both-peer-apis-ready' });
    for (const app of apps) {
      const resumed = await json<BuddyStatusDto>(
        app,
        `${adminRoute}/control`,
        'POST',
        app.admin.token,
        { action: 'resume-sending' },
        201,
      );
      expect(resumed.settings?.pausedSending).toBe(false);
      lifecycle.push({
        timestamp: new Date().toISOString(),
        event: 'sending-resumed-after-peer-readiness',
        side: app.side,
      });
    }
    report.phase = 'restore-after-peer-readiness';
    const restore = async (app: App, snapshotId: string, ids: string[], mode: 'keep' | 'replace') => {
      await unlock(app);
      const input = { snapshotId, scope: 'asset', assetIds: ids, mode };
      const preview = await json<{ items: number; operationId: null; state: string }>(
        app,
        `${ownerRoute}/restore`,
        'POST',
        app.admin.token,
        input,
        201,
      );
      expect(preview.items).toBe(ids.length);
      expect(preview.state).toBe('preview');
      expect(preview.operationId).toBeNull();
      const begun = await json<{ operationId: string }>(
        app,
        `${ownerRoute}/restore`,
        'POST',
        app.admin.token,
        { ...input, confirm: true },
        201,
      );
      const completed = await until(
        'Real restore publication',
        async () => {
          const state = await json<BuddyRestoreStatusDto>(
            app,
            `${ownerRoute}/restores/${begun.operationId}`,
            'GET',
            app.admin.token,
          );
          report[`restore-${app.side}`] = { state: state.state, phase: state.phase };
          if (['failed', 'cancelled'].includes(state.state)) {
            throw new Error(`Server ${app.side}: restore ${state.state}`);
          }
          return state;
        },
        (value) => value.state === 'completed',
        120_000,
      );
      expect(completed.progress).toBe(100);
      const adminProgress = await json<BuddyRestoreStatusDto>(
        app,
        `${adminRoute}/restores/${begun.operationId}`,
        'GET',
        app.admin.token,
      );
      expect(adminProgress.state).toBe('completed');
      expect(adminProgress.progress).toBe(100);
    };
    for (const [index, app] of apps.entries()) {
      const { missing, current } = items[index];
      const reads = transports[1 - index].metrics.objectReads;
      await restore(app, snapshotIds[index], [missing.id, current.id], 'keep');
      await original(app, missing);
      await original(app, current);
      expect(transports[1 - index].metrics.objectReads).toBeGreaterThan(reads);
      const kept = await json<Asset>(app, `/assets/${current.id}`, 'GET', app.admin.token);
      expect(kept.isFavorite).toBe(false);
      expect(kept.exifInfo?.description).toBe('Later local change');
      await restore(app, snapshotIds[index], [current.id], 'replace');
      const replaced = await json<Asset>(app, `/assets/${current.id}`, 'GET', app.admin.token);
      expect(replaced.isFavorite).toBe(true);
      expect(replaced.exifInfo?.description).toBe('Captured description');
      await original(app, current);
    }

    report.phase = 'no-hosted-buddy-photo-access';
    for (const [index, app] of apps.entries()) {
      await unlock(app);
      await unlock(app, app.member);
      const owned = [items[index].missing.id, items[index].current.id].sort();
      for (const [session, expected] of [
        [app.admin, owned],
        [app.member, [items[index].member.id]],
      ] as const) {
        const stats = await json<{ total: number }>(app, '/assets/statistics', 'GET', session.token);
        expect(stats.total).toBe(expected.length);
        const search = await json<{ assets: { items: Array<{ id: string }> } }>(
          app,
          '/search/metadata',
          'POST',
          session.token,
          {},
        );
        expect(search.assets.items.map((item) => item.id).sort()).toEqual(expected);
        const timeline = await json<{ id: string[] }>(app, '/timeline/ordered?sort=filename', 'GET', session.token);
        expect(timeline.id.toSorted()).toEqual(expected);
        const browse = await json<Browse>(app, `${ownerRoute}/snapshots/${snapshotIds[index]}`, 'GET', session.token);
        expect(browse.items.map((item) => item.id).sort()).toEqual(expected);
        const refusedSnapshot = await response(
          app,
          `${ownerRoute}/snapshots/${snapshotIds[1 - index]}`,
          'GET',
          session.token,
        );
        expect(refusedSnapshot.status).toBe(404);
        await refusedSnapshot.body?.cancel();
        for (const path of ['', '/original', '/thumbnail']) {
          const hidden = await response(app, `/assets/${items[1 - index].missing.id}${path}`, 'GET', session.token);
          expect([400, 403, 404]).toContain(hidden.status);
          await hidden.body?.cancel();
        }
      }
      const adminHosted = await response(
        app,
        `${adminRoute}/snapshots/${snapshotIds[1 - index]}`,
        'GET',
        app.admin.token,
      );
      expect(adminHosted.status).toBe(404);
      await adminHosted.body?.cancel();
      const albums = await json<Array<{ id: string }>>(app, '/albums', 'GET', app.admin.token);
      expect(albums.map((album) => album.id).sort()).toEqual([items[index].album, items[index].emptyAlbum].sort());
      const foreignSelection = await response(app, `${ownerRoute}/restore`, 'POST', app.member.token, {
        snapshotId: snapshotIds[index],
        scope: 'asset',
        assetIds: [items[index].current.id],
        confirm: true,
      });
      expect(foreignSelection.status).toBe(404);
      await foreignSelection.body?.cancel();
      await json(app, `/assets/${items[index].current.id}`, 'PUT', app.admin.token, { visibility: 'locked' });
      await json(app, '/auth/session/lock', 'POST', app.admin.token, undefined, 204);
      const lockedOriginal = await response(app, `/assets/${items[index].current.id}/original`, 'GET', app.admin.token);
      // sendFile maps denied originals to the same generic 404 as a missing file, without media metadata.
      expect(lockedOriginal.status).toBe(404);
      expect(lockedOriginal.headers.get('content-type')).toMatch(/^application\/json\b/);
      expect(lockedOriginal.headers.get('content-disposition')).toBeNull();
      expect(await lockedOriginal.json()).toEqual({ message: 'Not Found' });
      for (const path of [`${ownerRoute}/snapshots/${snapshotIds[index]}`, `${adminRoute}/preflight`]) {
        const locked = await response(
          app,
          path,
          path.endsWith('preflight') ? 'POST' : 'GET',
          app.admin.token,
          path.endsWith('preflight') ? {} : undefined,
        );
        expect(locked.status).toBe(403);
        await locked.body?.cancel();
      }
      await unlock(app);
      await original(app, items[index].current);
      await original(app, items[index].missing);
    }
    // Unlike the earlier paused restart, pending verification must survive without a
    // sending pause or a new start/resume command. Explicit peer backpressure (429) is
    // a prerequisite wait until both owned APIs are ready. Transport errors and 503s
    // consume the bounded execution retry, covered by the Buddy worker regression tests;
    // every accidental forwarding failure here still fails this conformance run.
    report.phase = 'awaiting-both-peer-apis';
    for (const transport of transports) transport.setUnavailable(true, 429);
    const pending = new Map<BuddySide, { id: string; verifiedAt: string | null; completedAt: string | null }>();
    for (const app of apps) {
      await unlock(app);
      const before = await status(app);
      expect(before.settings?.pausedSending).toBe(false);
      const verification = await json<BuddyStatusDto>(
        app,
        `${adminRoute}/control`,
        'POST',
        app.admin.token,
        { action: 'verify' },
        201,
      );
      expect(verification.run?.id).toBeTruthy();
      pending.set(app.side, {
        id: verification.run!.id,
        verifiedAt: before.lastVerifiedAt,
        completedAt: before.lastCompleteAt,
      });
    }
    for (const [index, app] of apps.entries()) {
      const prior = pending.get(app.side)!;
      await until(
        'Unavailable peer settled under its durable claim',
        async () => {
          const state = await status(app);
          const [operation] = await app.db<
            { status: string; claimToken: string | null; retryAt: Date | null; task: string }[]
          >`
          select status, "claimToken", "retryAt", snapshot->>'task' as task
          from public.media_operation where id=${prior.id}
        `;
          expect(operation.task).toBe('verify');
          expect(state.settings?.pausedSending).toBe(false);
          expect(state.lastVerifiedAt).toBe(prior.verifiedAt);
          expect(state.lastCompleteAt).toBe(prior.completedAt);
          if (['failed', 'cancelled', 'completed'].includes(operation.status)) {
            throw new Error(`Server ${app.side}: pending verification did not preserve the peer outage`);
          }
          return (
            operation.status === 'queued' &&
            operation.claimToken === null &&
            operation.retryAt !== null &&
            state.run?.id === prior.id &&
            state.run.state === 'waiting-peer' &&
            transports[1 - index].outages.some((outage) => outage.category === 'handshake' && outage.status === 429)
          );
        },
        Boolean,
      );
      lifecycle.push({
        timestamp: new Date().toISOString(),
        event: 'unpaused-verification-waiting-peer',
        side: app.side,
      });
    }
    await docker('docker', ['compose', '-f', compose, 'restart', 'buddy-a', 'buddy-b'], { timeout: 60_000 });
    for (const app of apps) {
      await until(
        'Unpaused restarted API',
        async () => {
          try {
            const ping = await response(app, '/server/ping');
            await ping.body?.cancel();
            return ping.status === 200;
          } catch {
            return false;
          }
        },
        Boolean,
      );
      await unlock(app);
      const state = await status(app);
      const prior = pending.get(app.side)!;
      expect(state.settings?.pausedSending).toBe(false);
      expect(state.run?.id).toBe(prior.id);
      expect(state.lastVerifiedAt).toBe(prior.verifiedAt);
      expect(state.lastCompleteAt).toBe(prior.completedAt);
    }
    const peerAvailableAt = Date.now();
    for (const transport of transports) transport.setUnavailable(false);
    for (const app of apps) {
      const prior = pending.get(app.side)!;
      await until(
        'Same pending verification recovered automatically',
        async () => {
          const state = await status(app);
          const [operation] = await app.db<{ status: string; claimToken: string | null; task: string }[]>`
          select status, "claimToken", snapshot->>'task' as task
          from public.media_operation where id=${prior.id}
        `;
          expect(operation.task).toBe('verify');
          expect(state.settings?.pausedSending).toBe(false);
          expect(state.lastCompleteAt).toBe(prior.completedAt);
          if (['failed', 'cancelled'].includes(operation.status)) {
            throw new Error(`Server ${app.side}: durable unpaused verification failed`);
          }
          return (
            operation.status === 'completed' &&
            operation.claimToken === null &&
            state.run?.id === prior.id &&
            state.run.state === 'complete' &&
            state.lastVerifiedAt !== null &&
            Date.parse(state.lastVerifiedAt) >= peerAvailableAt &&
            (await absent(join(root, app.side, 'identity', 'buddy', 'verification', prior.id)))
          );
        },
        Boolean,
        180_000,
      );
      const index = apps.indexOf(app);
      await original(app, items[index].current);
      await original(app, items[index].missing);
      lifecycle.push({
        timestamp: new Date().toISOString(),
        event: 'unpaused-verification-recovered-and-settled',
        side: app.side,
      });
    }
    if (coordinator) {
      expect(coordinator.errors).toEqual([]);
      const paths = new Set([...coordinator.cloud.routes.keys(), 'GET /.well-known/frameleaf-services']);
      for (const request of coordinator.cloud.requests) {
        expect(paths.has(`${request.method} ${request.path}`)).toBe(true);
        for (const sentinel of sentinels) {
          expect(request.body.includes(sentinel)).toBe(false);
        }
        if (request.path.startsWith('/v1/buddy/')) {
          expect(request.dpop).not.toBeNull();
        }
      }
    }
    for (const transport of transports) {
      expect(transport.failures).toEqual([]);
    }
    if (actual) {
      report.mediaJourneyPassed = true;
      report.phase = 'cloud-privacy';
      const privacy = z
        .object({
          armed: z.boolean(),
          complete: z.boolean(),
          leaked: z.boolean(),
          requests: z.number().int().nonnegative(),
          buddyRequests: z.number().int().nonnegative(),
          acceptedBuddyRequests: z.number().int().nonnegative(),
          unknownBuddyRoutes: z.number().int().nonnegative(),
          missingBuddyProof: z.number().int().nonnegative(),
        })
        .parse(await control({ command: 'privacy-check', sentinels }));
      report.cloudPrivacy = privacy;
      expect(privacy).toMatchObject({
        armed: true,
        complete: true,
        leaked: false,
        unknownBuddyRoutes: 0,
        missingBuddyProof: 0,
      });
      expect(privacy.requests).toBeGreaterThan(0);
      expect(privacy.buddyRequests).toBeGreaterThan(0);
      expect(privacy.acceptedBuddyRequests).toBeGreaterThan(0);
    }
    report.passed = true;
    report.phase = 'complete';
    report.privacy = 'both-hosted-snapshots-and-normal-photo-routes-refused; own-content-positive';
  } finally {
    // Persist the observations that failed acceptance too; success-only evidence hid the causal error.
    report.transport = transports.map((transport, index) => ({
      destination: BUDDY_SIDES[index],
      ...transport.metrics,
      failures: [...transport.failures],
      diagnostics: [...transport.diagnostics],
      deliberateOutages: [...transport.outages],
    }));
    report.durationMs = Date.now() - started;
    try {
      await writeFile(join(root, 'evidence', 'buddy.json'), JSON.stringify(report, null, 2));
    } finally {
      await Promise.allSettled([
        ...transports.map((transport) => transport.close()),
        coordinator?.cloud.close(),
        ...apps.map((app) => app.db.end({ timeout: 5 })),
      ]);
    }
  }
});
