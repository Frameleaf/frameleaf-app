import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditReport } from 'src/commands/migrate/audit';
import { ServerClient } from 'src/commands/migrate/client';
import { Controller } from 'src/commands/migrate/controller';
import { describePreflight, runPipeline, verifyLedger } from 'src/commands/migrate/index';
import { Ledger } from 'src/commands/migrate/ledger';
import { FOREIGN_PATH, sanitizeDetail, sanitizeUrl } from 'src/commands/migrate/report';
import type { MigrateOptions } from 'src/commands/migrate/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Disposable source/destination fixtures: two in-process HTTP servers speaking the slice of
 * the API the migration uses, with real ledgers on disk. They prove interruption and
 * repeat, partial source failures, dry runs, the report contents and that the source is
 * only ever read.
 */

const SOURCE_KEY = 'SourceKey0123456789abcdefghijKLMNOPqrstuv';
const DEST_KEY = 'DestKey0123456789abcdefghijKLMNOPqrstuvwx';

type Json = Record<string, unknown>;
interface FixtureAsset {
  id: string;
  bytes: Buffer;
  originalFileName: string;
  type: string;
  livePhotoVideoId?: string;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('base64');

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => unknown) {
  const server = createServer((req, res) => {
    void readBody(req).then((body) => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/api` };
}

/** SERVER A: a read-only library. Records every request so tests can prove nothing is written. */
class SourceFixture {
  requests: Array<{ method: string; path: string }> = [];
  failing = new Set<string>();
  assets: FixtureAsset[] = [];
  albums: Json[] = [];
  albumMembers = new Map<string, string[]>();
  tags: Json[] = [];
  tagMembers = new Map<string, string[]>();
  stacks: Json[] = [];
  people: Json[] = [];
  server!: Server;
  url = '';

  async start() {
    const { server, url } = await listen((req, res, body) => this.handle(req, res, body));
    this.server = server;
    this.url = url;
  }

  private assetDto(asset: FixtureAsset) {
    return {
      id: asset.id,
      checksum: sha256(asset.bytes),
      originalFileName: asset.originalFileName,
      type: asset.type,
      fileCreatedAt: '2024-05-01T10:00:00.000Z',
      fileModifiedAt: '2024-05-01T10:00:00.000Z',
      isFavorite: false,
      visibility: 'timeline',
      livePhotoVideoId: asset.livePhotoVideoId ?? null,
      exifInfo: {},
    };
  }

  private handle(req: IncomingMessage, res: ServerResponse, body: Buffer) {
    const path = (req.url ?? '').replace(/^\/api/, '');
    this.requests.push({ method: req.method ?? '', path });
    const route = `${req.method} ${path.split('?', 1)[0]}`;
    if (route === 'GET /users/me') {
      return send(res, 200, { id: 'user-a', email: 'owner@source.test' });
    }
    if (route === 'GET /api-keys/me') {
      return send(res, 200, { permissions: ['all'] });
    }
    if (route === 'POST /search/metadata') {
      const dto = JSON.parse(body.toString()) as {
        visibility: string;
        albumIds?: string[];
        tagIds?: string[];
        personIds?: string[];
      };
      let items = dto.visibility === 'timeline' ? this.assets : [];
      if (dto.albumIds) {
        const members = new Set(this.albumMembers.get(dto.albumIds[0]));
        items = items.filter((asset) => members.has(asset.id));
      }
      if (dto.tagIds) {
        const members = new Set(this.tagMembers.get(dto.tagIds[0]));
        items = items.filter((asset) => members.has(asset.id));
      }
      if (dto.personIds) {
        items = [];
      }
      return send(res, 200, { assets: { items: items.map((asset) => this.assetDto(asset)), nextPage: null } });
    }
    if (route === 'GET /albums') {
      return send(res, 200, this.albums);
    }
    if (route === 'GET /tags') {
      return send(res, 200, this.tags);
    }
    if (route === 'GET /stacks') {
      return send(res, 200, this.stacks);
    }
    if (route === 'GET /people') {
      return send(res, 200, { people: this.people, hasNextPage: false });
    }
    const original = /^GET \/assets\/([^/]+)\/original$/.exec(route);
    if (original) {
      const asset = this.assets.find((item) => item.id === original[1]);
      if (!asset || this.failing.has(asset.id)) {
        // Echo a server path in the body, like a real storage error would.
        return send(res, 404, { message: `ENOENT: /mnt/photos/library/${asset?.originalFileName}` });
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(asset.bytes);
    }
    if (/^GET \/assets\/[^/]+\/metadata$/.test(route)) {
      return send(res, 200, []);
    }
    return send(res, 404, { message: `no route ${route}` });
  }

  writes() {
    return this.requests.filter((r) => !(r.method === 'GET' || (r.method === 'POST' && r.path === '/search/metadata')));
  }
}

/** SERVER B: stores uploads by checksum, like a real destination's per-user dedup. */
class DestinationFixture {
  uploads = 0;
  assets = new Map<string, { id: string; checksum: string }>();
  albums: Array<{ id: string; albumName: string; parentId?: string; assetIds: Set<string> }> = [];
  tags = new Map<string, string>();
  stacks: string[][] = [];
  people: Json[] = [];
  onUpload?: (count: number) => void;
  server!: Server;
  url = '';

  async start() {
    const { server, url } = await listen((req, res, body) => this.handle(req, res, body));
    this.server = server;
    this.url = url;
  }

  private handle(req: IncomingMessage, res: ServerResponse, body: Buffer) {
    const path = (req.url ?? '').replace(/^\/api/, '');
    const route = `${req.method} ${path.split('?', 1)[0]}`;
    const json = () => JSON.parse(body.toString() || '{}') as Json;
    if (route === 'GET /users/me') {
      return send(res, 200, { id: 'user-b', email: 'owner@destination.test' });
    }
    if (route === 'GET /api-keys/me') {
      return send(res, 200, { permissions: ['all'] });
    }
    if (route === 'POST /assets/bulk-upload-check') {
      const { assets } = json() as { assets: Array<{ id: string; checksum: string }> };
      return send(res, 200, {
        results: assets.map(({ id, checksum }) => {
          const existing = this.assets.get(checksum);
          return existing
            ? { id, action: 'reject', reason: 'duplicate', assetId: existing.id }
            : { id, action: 'accept' };
        }),
      });
    }
    if (route === 'POST /assets') {
      const checksum = String(req.headers['x-immich-checksum']);
      const existing = this.assets.get(checksum);
      if (existing) {
        return send(res, 200, { id: existing.id, status: 'duplicate' });
      }
      const id = randomUUID();
      this.assets.set(checksum, { id, checksum });
      this.uploads++;
      this.onUpload?.(this.uploads);
      return send(res, 201, { id, status: 'created' });
    }
    if (/^PUT \/assets\/[^/]+(\/metadata)?$/.test(route)) {
      return send(res, 200, route.endsWith('/metadata') ? [] : {});
    }
    if (route === 'GET /albums') {
      return send(
        res,
        200,
        this.albums.map((album) => ({ id: album.id, albumName: album.albumName, parentId: album.parentId })),
      );
    }
    if (route === 'POST /albums') {
      const dto = json() as { albumName: string; parentId?: string };
      const album = { id: randomUUID(), albumName: dto.albumName, parentId: dto.parentId, assetIds: new Set<string>() };
      this.albums.push(album);
      return send(res, 201, { id: album.id });
    }
    const albumAssets = /^PUT \/albums\/([^/]+)\/assets$/.exec(route);
    if (albumAssets) {
      const album = this.albums.find((item) => item.id === albumAssets[1]);
      for (const id of (json().ids as string[]) ?? []) {
        album?.assetIds.add(id);
      }
      return send(res, 200, []);
    }
    if (/^PATCH \/albums\/[^/]+$/.test(route)) {
      return send(res, 200, {});
    }
    if (route === 'PUT /tags') {
      const values = json().tags as string[];
      return send(
        res,
        200,
        values.map((value) => {
          if (!this.tags.has(value)) {
            this.tags.set(value, randomUUID());
          }
          return { id: this.tags.get(value), value };
        }),
      );
    }
    if (route === 'PUT /tags/assets') {
      return send(res, 200, { count: 0 });
    }
    if (route === 'POST /stacks') {
      this.stacks.push(json().assetIds as string[]);
      return send(res, 201, { id: randomUUID() });
    }
    if (route === 'GET /search/person') {
      return send(res, 200, this.people);
    }
    if (route === 'POST /people') {
      const person = { id: randomUUID(), name: json().name };
      this.people.push(person);
      return send(res, 201, person);
    }
    if (route === 'GET /faces') {
      return send(res, 200, []);
    }
    return send(res, 404, { message: `no route ${route}` });
  }
}

const asset = (id: string, name: string, over: Partial<FixtureAsset> = {}): FixtureAsset => ({
  id,
  bytes: Buffer.from(`bytes of ${id}`),
  originalFileName: name,
  type: 'IMAGE',
  ...over,
});

async function run(opts: MigrateOptions, controller = new Controller()) {
  const [{ client: from, user: fromUser }, { client: to, user: toUser }] = await Promise.all([
    ServerClient.connect(opts.from.url, opts.from.key),
    ServerClient.connect(opts.to.url, opts.to.key),
  ]);
  const ledger = new Ledger(opts.ledger);
  ledger.initRun({
    fromUrl: from.baseUrl,
    toUrl: to.baseUrl,
    userEmail: toUser.email,
    sourceEmail: fromUser.email,
    startedAt: new Date().toISOString(),
    dryRun: opts.dryRun,
  });
  if (opts.retryFailed) {
    ledger.clearErrors();
  }
  const tmpDir = `${opts.ledger}.tmp`;
  mkdirSync(tmpDir, { recursive: true });
  const auditPath = `${opts.ledger}.audit.json`;
  try {
    const report = await runPipeline(from, to, ledger, opts, controller, tmpDir, auditPath, {
      from: from.baseUrl,
      to: to.baseUrl,
      user: toUser.email,
      sourceUser: fromUser.email,
      dryRun: opts.dryRun,
      secrets: [opts.from.key, opts.to.key],
    });
    return { report, auditPath };
  } finally {
    ledger.close();
  }
}

describe('migrate against disposable source/destination fixtures', () => {
  let dir: string;
  let source: SourceFixture;
  let destination: DestinationFixture;

  const options = (over: Partial<MigrateOptions> = {}): MigrateOptions => ({
    from: { url: source.url, key: SOURCE_KEY },
    to: { url: destination.url, key: DEST_KEY },
    ledger: join(dir, 'ledger.sqlite'),
    concurrency: 2,
    dryRun: false,
    includeTrashed: false,
    retryFailed: false,
    faces: true,
    serve: false,
    port: 0,
    preflight: false,
    verify: false,
    ...over,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'frameleaf-migrate-fixture-'));
    source = new SourceFixture();
    destination = new DestinationFixture();
    source.assets = [
      asset('a1', 'IMG_0001.jpg'),
      asset('a2', 'IMG_0002.jpg'),
      asset('a3', 'Lake morning.jpg'),
      asset('a4', 'IMG_0004.HEIC', { livePhotoVideoId: 'a5' }),
      asset('a5', 'IMG_0004.MOV', { type: 'VIDEO' }),
    ];
    source.albums = [
      { id: 'al-trips', albumName: 'Trips', description: '', parentId: null, order: 'desc', sortOrder: null },
      { id: 'al-banff', albumName: 'Banff', description: '', parentId: 'al-trips', order: 'desc', sortOrder: 1 },
    ];
    source.albumMembers.set('al-banff', ['a1', 'a2', 'a3']);
    source.tags = [{ id: 't-canada', value: 'Travel/Canada' }];
    source.tagMembers.set('t-canada', ['a1']);
    source.stacks = [{ id: 's1', primaryAssetId: 'a1', assets: [{ id: 'a1' }, { id: 'a2' }] }];
    source.people = [{ id: 'p1', name: 'Alice', birthDate: null, isHidden: false, isFavorite: false }];
    await Promise.all([source.start(), destination.start()]);
  });

  afterEach(async () => {
    await Promise.all([source, destination].map((f) => new Promise((resolve) => f.server.close(resolve))));
    rmSync(dir, { recursive: true, force: true });
  });

  it('dry run writes nothing to the destination and never clears the source', async () => {
    const { report, auditPath } = await run(options({ dryRun: true }));

    expect(destination.uploads).toBe(0);
    expect(destination.albums).toHaveLength(0);
    expect(report?.dryRun).toBe(true);
    expect(report?.ok).toBe(false);
    expect(report?.assets).toMatchObject({ total: 5, transferred: 0, verified: 0, missing: 5 });
    expect(existsSync(auditPath)).toBe(true);
    expect(source.writes()).toEqual([]);
  });

  it('partial source failure: the run finishes, reports the failure, and a retry completes it', async () => {
    source.failing.add('a3');

    const { report: first } = await run(options());
    expect(first!.ok).toBe(false);
    expect(first!.complete).toBe(true);
    expect(first!.assets).toEqual({ total: 5, transferred: 4, checked: 4, verified: 4, missing: 1, failed: 1 });
    const failed = first!.unresolved.find((item) => item.id === 'a3');
    expect(failed).toMatchObject({ kind: 'asset', name: 'Lake morning.jpg', reason: 'transfer-failed' });
    // The source's 404 body names a server path; only the status may reach the report.
    expect(failed?.detail).toBe('HTTP 404 Not Found');
    // Everything else still moved: the album hierarchy, the tag, the stack, the Live Photo pair.
    expect(destination.albums.map((album) => album.albumName).toSorted()).toEqual(['Banff', 'Trips']);
    const banff = destination.albums.find((album) => album.albumName === 'Banff')!;
    expect(banff.parentId).toBe(destination.albums.find((album) => album.albumName === 'Trips')!.id);
    expect(banff.assetIds.size).toBe(2);
    expect(destination.stacks).toHaveLength(1);
    // The album is still missing a3, so it stays pending and the report names it.
    expect(first!.albums).toMatchObject({ created: 2, linked: 1 });
    expect(first!.unresolved).toContainEqual({
      kind: 'album',
      id: 'al-banff',
      name: 'Trips / Banff',
      reason: 'not-linked',
    });

    source.failing.clear();
    const uploadsBefore = destination.uploads;
    const { report: second } = await run(options({ retryFailed: true }));
    expect(destination.uploads - uploadsBefore).toBe(1); // only the failed asset moves again
    expect(second!.assets).toEqual({ total: 5, transferred: 5, checked: 5, verified: 5, missing: 0, failed: 0 });
    expect(banff.assetIds.size).toBe(3); // the late asset joined its album on the retry
    expect(second!.albums).toMatchObject({ created: 2, linked: 2 });
    expect(second!.unresolvedCount).toBe(0);
    expect(second!.ok).toBe(true);
    expect(source.writes()).toEqual([]);
  });

  it('interruption then repeat: resumes without re-uploading and ends with a verified pass', async () => {
    const controller = new Controller();
    destination.onUpload = (count) => {
      if (count === 2) {
        controller.stop();
      }
    };
    const interrupted = await run(options({ concurrency: 1 }), controller);
    expect(interrupted.report).toBeUndefined(); // stopped runs never produce a report
    const afterStop = destination.uploads;
    expect(afterStop).toBeGreaterThanOrEqual(2);
    expect(afterStop).toBeLessThan(5);

    destination.onUpload = undefined;
    const { report: resumed } = await run(options());
    expect(destination.uploads).toBe(5); // each original uploaded exactly once overall
    expect(resumed!.ok).toBe(true);
    expect(resumed!.assets).toEqual({ total: 5, transferred: 5, checked: 5, verified: 5, missing: 0, failed: 0 });

    // A third, repeated run transfers nothing and still passes.
    const { report: repeated } = await run(options());
    expect(destination.uploads).toBe(5);
    expect(repeated!.ok).toBe(true);
    expect(destination.albums).toHaveLength(2); // no duplicate albums on repeat
    expect(source.writes()).toEqual([]);
  });

  it('writes a report with owners, hierarchy, physical references and no secrets or local paths', async () => {
    source.failing.add('a3');
    const { report, auditPath } = await run(options());
    const text = readFileSync(auditPath, 'utf8');
    const written = JSON.parse(text) as AuditReport;

    expect(written).toMatchObject({
      format: 'frameleaf-migration-audit',
      formatVersion: 1,
      sourceDeletion: 'never-automatic',
      owners: [{ source: 'owner@source.test', destination: 'owner@destination.test' }],
      albums: { total: 2, topLevel: 1, nested: 1, maxDepth: 1, created: 2, linked: 1 },
      tags: { total: 1, assigned: 1 },
      stacks: { total: 1, created: 1 },
      people: { total: 1, attached: 1 },
      physicalReferences: { newUploads: 4, matchedExisting: 0, livePhotoPairs: 1, livePhotoPairsLinked: 1 },
    });
    expect(written.unresolvedCount).toBe(report!.unresolved.length);
    expect(text).not.toContain(SOURCE_KEY);
    expect(text).not.toContain(DEST_KEY);
    expect(text).not.toContain('/mnt/photos');
    expect(text).not.toContain(dir);

    const strings: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === 'string') {
        strings.push(value);
      } else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) {
          walk(item);
        }
      }
    };
    walk({ ...written, from: undefined, to: undefined });
    expect(strings.filter((value) => FOREIGN_PATH.test(value))).toEqual([]);
  });

  it('a pre-existing destination copy is a matched physical reference, not a new upload', async () => {
    destination.assets.set(sha256(source.assets[0].bytes), { id: 'b-existing', checksum: 'x' });
    const { report } = await run(options());
    expect(report?.physicalReferences).toMatchObject({ newUploads: 4, matchedExisting: 1 });
    expect(report?.ok).toBe(true);
  });

  it('verify re-audits only the destination and separates transferred from verified', async () => {
    await run(options());
    const requestsBefore = source.requests.length;
    // Something removes one original from the destination after the migration finished.
    const [lost] = destination.assets.keys();
    destination.assets.delete(lost);

    const { client: to } = await ServerClient.connect(destination.url, DEST_KEY);
    const { report } = await verifyLedger(to, 'owner@destination.test', options().ledger, new Controller(), [DEST_KEY]);

    expect(source.requests.length).toBe(requestsBefore); // the source is never contacted
    expect(report.ok).toBe(false);
    expect(report.assets).toEqual({ total: 5, transferred: 5, checked: 5, verified: 4, missing: 1, failed: 0 });
    expect(report.unresolved.filter((item) => item.reason === 'absent-on-destination')).toHaveLength(1);
    expect(report.owners).toEqual([{ source: 'owner@source.test', destination: 'owner@destination.test' }]);
  });

  it('a dry-run-only ledger never verifies as a pass, even when the destination has everything', async () => {
    for (const item of source.assets) {
      destination.assets.set(sha256(item.bytes), { id: `b-${item.id}`, checksum: sha256(item.bytes) });
    }
    await run(options({ dryRun: true }));

    const { client: to } = await ServerClient.connect(destination.url, DEST_KEY);
    const { report } = await verifyLedger(to, 'owner@destination.test', options().ledger, new Controller(), [DEST_KEY]);
    expect(report.dryRun).toBe(true);
    expect(report.ok).toBe(false);
    expect(destination.albums).toHaveLength(0);

    // A real run afterwards clears the dry-run mark for good.
    await run(options());
    await run(options({ dryRun: true }));
    const after = await verifyLedger(to, 'owner@destination.test', options().ledger, new Controller(), [DEST_KEY]);
    expect(after.report.dryRun).toBe(false);
    expect(after.report.ok).toBe(true);
  });

  it('writes user names that look like paths verbatim, and the web parser accepts the file', async () => {
    source.albums.push({
      id: 'al-backup',
      albumName: '/Backup',
      description: '',
      parentId: null,
      order: 'desc',
      sortOrder: null,
    });
    source.albumMembers.set('al-backup', ['a3']);
    source.people = [{ id: 'p1', name: String.raw`C:\Old`, birthDate: null, isHidden: false, isFavorite: false }];
    source.failing.add('a3');
    const { auditPath } = await run(options());
    const text = readFileSync(auditPath, 'utf8');
    const written = JSON.parse(text) as AuditReport;
    expect(written.unresolved).toContainEqual({
      kind: 'album',
      id: 'al-backup',
      name: '/Backup',
      reason: 'not-linked',
    });

    // Load the standalone web consumer without requiring SvelteKit-generated files in CLI CI.
    const parserSource = readFileSync(
      join(import.meta.dirname, '../../../../../web/src/lib/frameleaf/migration-report.ts'),
      'utf8',
    );
    const parser = (await import(
      `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(parserSource, { mode: 'transform' })).toString('base64')}`
    )) as { parseMigrationReport: (raw: string) => { ok: boolean; error?: string } };
    expect(parser.parseMigrationReport(text)).toMatchObject({ ok: true });
  });

  it('verify refuses a destination the ledger was not written for, and a missing ledger', async () => {
    await run(options());
    const other = new DestinationFixture();
    await other.start();
    try {
      const { client } = await ServerClient.connect(other.url, DEST_KEY);
      await expect(verifyLedger(client, 'x@y.test', options().ledger, new Controller(), [])).rejects.toThrow(
        /recorded for destination/,
      );
      await expect(verifyLedger(client, 'x@y.test', join(dir, 'none.sqlite'), new Controller(), [])).rejects.toThrow(
        /No ledger/,
      );
      expect(existsSync(join(dir, 'none.sqlite'))).toBe(false);
    } finally {
      await new Promise((resolve) => other.server.close(resolve));
    }
  });

  it('preflight creates no ledger and flags a ledger recorded for other servers', async () => {
    const ledgerPath = options().ledger;
    const fresh = describePreflight(ledgerPath, source.url, destination.url, 'a@x.test', 'b@x.test');
    expect(fresh.lines.at(-1)).toContain('new');
    expect(fresh.warnings).toEqual([]);
    expect(existsSync(ledgerPath)).toBe(false);

    await run(options());
    const resumed = describePreflight(ledgerPath, source.url, destination.url, 'a@x.test', 'b@x.test');
    expect(resumed.lines.at(-1)).toContain('resumes: 5/5');
    expect(resumed.warnings).toEqual([]);
    const mismatch = describePreflight(ledgerPath, source.url, 'https://elsewhere.test/api', 'a@x.test', 'b@x.test');
    expect(mismatch.warnings[0]).toContain('recorded for');
  });
});

describe('migrate report sanitization', () => {
  it('keeps only the status of HTTP failures', () => {
    expect(sanitizeDetail('MigrateHttpError: GET /assets/a1/original -> 500 Internal Server Error: /data/x')).toBe(
      'HTTP 500 Internal Server Error',
    );
  });

  it('removes keys, local paths and URL credentials from other failures', () => {
    const detail = sanitizeDetail(
      String.raw`Error: ENOENT: open '/home/op/immich-migrate.sqlite.tmp/a1.part' with ${SOURCE_KEY} via https://u:p@old.example.com/api?apiKey=zzz and C:\Users\op\x`,
      [SOURCE_KEY],
    );
    expect(detail).not.toContain(SOURCE_KEY);
    expect(detail).not.toContain('/home/op');
    expect(detail).not.toContain('u:p@');
    expect(detail).not.toContain('apiKey');
    expect(detail).not.toContain(String.raw`C:\Users`);
    expect(FOREIGN_PATH.test(detail)).toBe(false);
  });

  it('keeps origin and path of server URLs only', () => {
    expect(sanitizeUrl('https://user:pw@photos.example.com/api/?key=secret#x')).toBe('https://photos.example.com/api');
    expect(sanitizeUrl('file:///etc/passwd')).toBe('[url]');
  });

  it('treats album paths and tag hierarchies as names, not filesystem paths', () => {
    expect(FOREIGN_PATH.test('Trips / Banff')).toBe(false);
    expect(FOREIGN_PATH.test('Travel/Canada')).toBe(false);
    expect(FOREIGN_PATH.test('/mnt/photos/a.jpg')).toBe(true);
    expect(FOREIGN_PATH.test('see ../../etc')).toBe(true);
  });

  it('a read-only ledger never creates a file for preflight', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frameleaf-migrate-ro-'));
    const path = join(dir, 'missing.sqlite');
    expect(() => new Ledger(path, { readonly: true })).toThrow();
    expect(existsSync(path)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
