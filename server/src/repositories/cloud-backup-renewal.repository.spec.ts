import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CloudBackupConnection,
  CloudBackupStoreRepository,
  signS3Request,
} from 'src/repositories/cloud-backup-store.repository.js';
import { CloudBackupRestorer, emptyRestoreResult, restorePlan } from 'src/services/cloud-backup-restore.js';
import {
  type BackupTransfer,
  type BackupTransferJournal,
  backupTransferSchema,
} from 'src/utils/cloud-backup-transfer.js';
import { type CloudBackupManifest } from 'src/utils/cloud-backup.js';
import { type BackupOperation, backupGrantResponseSchema } from 'src/utils/frameleaf-cloud-backup.js';
import { ManagedBackupAuthorizationError, managedBackupSession } from 'src/utils/managed-backup-session.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const fixture = (operation: BackupOperation) =>
  backupGrantResponseSchema.parse(cloudContractFixture(`backup/capability-${operation}.json`));
const error = (code: string, status = 403) => new Response(`<Error><Code>${code}</Code></Error>`, { status });

/** A synthetic storage authorization boundary, with enforced sessions, SigV4, operation scopes and ranges. */
class CapabilityStorage {
  clock = 0;
  sequence = 0;
  renewals = 0;
  unavailable = false;
  readOnly = false;
  revoked = false;
  failPart = 0;
  loseCreate = false;
  loseComplete = false;
  breakDownload = false;
  expireDownload = false;
  step = 0;
  objects = new Map<string, Buffer>();
  sessions = new Map<string, { grant: ReturnType<typeof fixture>; expires: number }>();
  uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  seen: Array<{ method: string; key: string; part: string | null; range: string | null; id: string }> = [];

  issue(operation: BackupOperation) {
    if (this.unavailable) throw new Error('Cloud unavailable');
    if (this.revoked || (this.readOnly && operation !== 'restore'))
      throw new ManagedBackupAuthorizationError('This operation is no longer permitted.');
    const grant = fixture(operation);
    grant.readOnly = this.readOnly;
    grant.capability.credentials.accessKeyId = `ASIASYNTHETIC${String(++this.sequence).padStart(8, '0')}`;
    grant.capability.credentials.sessionToken = `synthetic-session-token-${this.sequence}`;
    this.sessions.set(grant.capability.credentials.accessKeyId, { grant, expires: this.clock + 900_000 });
    return grant;
  }

  connection(operation: BackupOperation, transfer?: BackupTransferJournal): CloudBackupConnection {
    const grant = this.issue(operation);
    return {
      endpoint: grant.endpoint,
      region: grant.region,
      bucket: grant.bucket,
      ...grant.capability.credentials,
      transfer,
      managedCredentials: managedBackupSession(
        grant,
        operation,
        async () => {
          this.renewals++;
          await Promise.resolve();
          return this.issue(operation);
        },
        () => this.clock,
      ),
    };
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    await Promise.resolve();
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const id = /Credential=([^/]+)/.exec(headers.get('authorization') ?? '')?.[1] ?? '';
    const session = this.sessions.get(id);
    if (!session || session.grant.capability.credentials.sessionToken !== headers.get('x-amz-security-token'))
      return error('InvalidToken');
    if (this.clock >= session.expires) return error('ExpiredToken');
    const key = url.pathname
      .split('/')
      .slice(2)
      .map((part) => decodeURIComponent(part))
      .join('/');
    const bucket = decodeURIComponent(url.pathname.split('/', 2)[1]);
    if (
      bucket !== session.grant.bucket ||
      (key && !/^(frameleaf-backup\.json|(?:o|db|m)\/|frameleaf-backup-probe\/)/.test(key))
    )
      return error('AccessDenied');
    const signingHeaders = Object.fromEntries([...headers].filter(([name]) => name !== 'authorization'));
    const time = headers.get('x-amz-date')!.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z');
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : undefined;
    const signed = signS3Request({
      method,
      host: url.host,
      canonicalUri: url.pathname,
      query: url.search.slice(1),
      headers: signingHeaders,
      body,
      region: session.grant.region,
      ...session.grant.capability.credentials,
      now: new Date(time),
    });
    expect(headers.get('authorization')).toBe(signed.authorization);
    const operation = session.grant.capability.operation;
    if (operation === 'restore' && !['GET', 'HEAD'].includes(method)) return error('AccessDenied');
    if (
      method === 'DELETE' &&
      ((!url.searchParams.has('uploadId') && operation !== 'prune') || key === 'frameleaf-backup.json')
    )
      return error('AccessDenied');
    if (operation === 'prune' && ['PUT', 'POST'].includes(method)) return error('AccessDenied');
    this.seen.push({ method, key, id, part: url.searchParams.get('partNumber'), range: headers.get('range') });
    this.clock += this.step;
    if (!key && url.searchParams.has('uploads')) {
      const entries = [...this.uploads].filter(([, upload]) => upload.key === url.searchParams.get('prefix'));
      return new Response(
        `<ListMultipartUploadsResult>${entries.map(([id, upload]) => `<Upload><Key>${upload.key}</Key><UploadId>${id}</UploadId></Upload>`).join('')}<IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`,
      );
    }
    if (method === 'POST' && url.searchParams.has('uploads')) {
      const uploadId = `upload-${this.uploads.size + 1}`;
      this.uploads.set(uploadId, { key, parts: new Map() });
      if (this.loseCreate) {
        this.loseCreate = false;
        throw new Error('lost create response');
      }
      return new Response(
        `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    const uploadId = url.searchParams.get('uploadId');
    if (uploadId) {
      const upload = this.uploads.get(uploadId);
      if (!upload) return error('NoSuchUpload', 404);
      if (method === 'GET')
        return new Response(
          `<ListPartsResult>${[...upload.parts].map(([n, part]) => `<Part><PartNumber>${n}</PartNumber><ETag>"${sha(part)}"</ETag><Size>${part.length}</Size></Part>`).join('')}<IsTruncated>false</IsTruncated></ListPartsResult>`,
        );
      if (method === 'DELETE') {
        this.uploads.delete(uploadId);
        return new Response(null, { status: 204 });
      }
      if (method === 'PUT') {
        const n = Number(url.searchParams.get('partNumber'));
        if (n === this.failPart) {
          this.clock += 900_000;
          this.unavailable = true;
          return error('ExpiredToken');
        }
        upload.parts.set(n, body!);
        return new Response(null, { headers: { etag: `"${sha(body!)}"` } });
      }
      const object = Buffer.concat([...upload.parts].sort(([a], [b]) => a - b).map(([, body]) => body));
      this.objects.set(key, object);
      this.uploads.delete(uploadId);
      if (this.loseComplete) {
        this.loseComplete = false;
        throw new Error('lost complete response');
      }
      return new Response(
        `<CompleteMultipartUploadResult><ETag>"${sha(object)}"</ETag></CompleteMultipartUploadResult>`,
      );
    }
    if (method === 'PUT') {
      this.objects.set(key, body!);
      return new Response(null, { headers: { etag: `"${sha(body!)}"` } });
    }
    if (method === 'DELETE') {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const object = this.objects.get(key);
    if (!object) return error('NoSuchKey', 404);
    const etag = `"${sha(object)}"`;
    if (headers.has('if-match') && headers.get('if-match') !== etag) return error('PreconditionFailed', 412);
    if (method === 'HEAD') return new Response(null, { headers: { etag, 'content-length': String(object.length) } });
    const start = Number(/^bytes=(\d+)-$/.exec(headers.get('range') ?? '')?.[1] ?? 0);
    const responseHeaders = {
      etag,
      'content-length': String(object.length - start),
      ...(start > 0 && { 'content-range': `bytes ${start}-${object.length - 1}/${object.length}` }),
    };
    if (this.breakDownload) {
      this.breakDownload = false;
      let sent = false;
      return new Response(
        new ReadableStream({
          pull: (controller) => {
            if (sent) {
              if (this.expireDownload) {
                this.clock += 900_000;
                this.unavailable = true;
              }
              controller.error(new Error('connection ended'));
            } else {
              sent = true;
              controller.enqueue(object.subarray(start, start + 1024));
            }
          },
        }),
        { headers: responseHeaders },
      );
    }
    return new Response(new Uint8Array(object.subarray(start)), {
      status: start ? 206 : 200,
      headers: responseHeaders,
    });
  };
}

describe('temporary backup capability storage integration', () => {
  let provider: CapabilityStorage;
  let store: CloudBackupStoreRepository;
  let folder: string;
  let durable: BackupTransfer | null;
  const key = Buffer.alloc(32, 7);
  const journal = (): BackupTransferJournal => {
    const state: BackupTransferJournal = {
      current: durable ? backupTransferSchema.parse(durable) : null,
      directory: folder,
      save: (value) => {
        durable = value ? backupTransferSchema.parse(value) : null;
        state.current = durable;
        return Promise.resolve();
      },
    };
    return state;
  };
  beforeEach(async () => {
    provider = new CapabilityStorage();
    store = new CloudBackupStoreRepository({ setContext: vi.fn(), warn: vi.fn() } as never);
    store.retryDelaysMs = [];
    folder = await mkdtemp(join(tmpdir(), 'frameleaf-renewal-'));
    durable = null;
    vi.stubGlobal('fetch', provider.fetch);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(folder, { recursive: true, force: true });
  });

  it('denies a captured session at provider expiry and cannot turn restore into upload or prune authority', async () => {
    const connection = provider.connection('restore');
    const captured = { ...connection, managedCredentials: undefined };
    await expect(store.put(connection, 'o/item', Buffer.from('data'), key)).rejects.toBeInstanceOf(
      ManagedBackupAuthorizationError,
    );
    await expect(store.delete(connection, 'o/item')).rejects.toBeInstanceOf(ManagedBackupAuthorizationError);
    provider.clock = 900_000;
    await expect(store.head(captured, 'o/item', key)).rejects.toMatchObject({ status: 403, code: null });
  });

  it('completes multipart across several lifetimes with bounded single-flight renewal', async () => {
    const bytes = Buffer.alloc(25 * 1024 * 1024, 9);
    const path = join(folder, 'video');
    await writeFile(path, bytes);
    const connection = provider.connection('upload', journal());
    provider.step = 350_000;
    await store.uploadFile(connection, `o/${sha(bytes)}`, path, key, sha(bytes));
    expect(sha(provider.objects.get(`o/${sha(bytes)}`)!)).toBe(sha(bytes));
    expect(provider.renewals).toBeGreaterThanOrEqual(2);
    expect(durable).toBeNull();
    expect(provider.uploads.size).toBe(0);
  });

  it('renews once for parallel requests and expired responses after short lifetime', async () => {
    provider.objects.set('o/item', Buffer.from('data'));
    const connection = provider.connection('restore');
    provider.clock = 600_000;
    await Promise.all(Array.from({ length: 8 }, () => store.head(connection, 'o/item', key)));
    expect(provider.renewals).toBe(1);
    provider.clock = 1_500_000;
    await store.get(connection, 'o/item', key);
    expect(provider.renewals).toBe(2);
  });

  it('resumes multipart after a lost process and Cloud outage without uploading accepted parts again', async () => {
    const bytes = Buffer.alloc(25 * 1024 * 1024, 3);
    const path = join(folder, 'video');
    await writeFile(path, bytes);
    provider.failPart = 3;
    await expect(
      store.uploadFile(provider.connection('upload', journal()), `o/${sha(bytes)}`, path, key, sha(bytes)),
    ).rejects.toBeInstanceOf(ManagedBackupAuthorizationError);
    expect(durable).toMatchObject({ kind: 'upload', parts: [{ partNumber: 1 }, { partNumber: 2 }] });
    const persisted = JSON.stringify(durable);
    for (const session of provider.sessions.values()) {
      expect(persisted).not.toContain(session.grant.capability.credentials.secretAccessKey);
      expect(persisted).not.toContain(session.grant.capability.credentials.sessionToken);
    }
    provider.failPart = 0;
    provider.unavailable = false;
    const restarted = new CloudBackupStoreRepository({ setContext: vi.fn(), warn: vi.fn() } as never);
    restarted.retryDelaysMs = [];
    await restarted.uploadFile(provider.connection('upload', journal()), `o/${sha(bytes)}`, path, key, sha(bytes));
    expect(provider.seen.filter((request) => request.method === 'PUT' && request.part === '1')).toHaveLength(1);
    expect(provider.seen.filter((request) => request.method === 'PUT' && request.part === '2')).toHaveLength(1);
    expect(sha(provider.objects.get(`o/${sha(bytes)}`)!)).toBe(sha(bytes));
  });

  it.each(['create', 'complete'])(
    'reconciles a lost multipart %s response without duplicate completed objects',
    async (which) => {
      const bytes = Buffer.alloc(9 * 1024 * 1024, 1);
      const path = join(folder, 'video');
      await writeFile(path, bytes);
      provider.loseCreate = which === 'create';
      provider.loseComplete = which === 'complete';
      store.retryDelaysMs = [0];
      await store.uploadFile(provider.connection('upload', journal()), `o/${sha(bytes)}`, path, key, sha(bytes));
      expect(provider.objects.size).toBe(1);
      expect(provider.uploads.size).toBe(0);
      expect(sha(provider.objects.get(`o/${sha(bytes)}`)!)).toBe(sha(bytes));
    },
  );

  it('resumes a mid-download interruption after restart with conditional Range and verifies the entire file', async () => {
    const bytes = Buffer.alloc(4096, 5);
    provider.objects.set(`o/${sha(bytes)}`, bytes);
    provider.breakDownload = true;
    provider.expireDownload = true;
    store.retryDelaysMs = [0];
    const destination = join(folder, 'restored');
    await writeFile(destination, 'existing original');
    await expect(
      store.download(provider.connection('restore', journal()), `o/${sha(bytes)}`, key, destination, sha(bytes)),
    ).rejects.toThrow();
    expect(durable).toMatchObject({ kind: 'download', offset: 1024 });
    expect(await readFile(destination, 'utf8')).toBe('existing original');
    provider.expireDownload = false;
    provider.unavailable = false;
    await store.download(provider.connection('restore', journal()), `o/${sha(bytes)}`, key, destination, sha(bytes));
    expect(provider.seen.some((request) => request.range === 'bytes=1024-')).toBe(true);
    expect(await readFile(destination)).toEqual(bytes);
    expect(durable).toBeNull();
  });

  it('reconciles process death after multipart completion before clearing its receipt', async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024, 1);
    const path = join(folder, 'video');
    await writeFile(path, bytes);
    const transfer = journal();
    const save = transfer.save;
    transfer.save = async (value) => {
      if (value === null) throw new Error('process stopped');
      await save(value);
    };
    await expect(
      store.uploadFile(provider.connection('upload', transfer), `o/${sha(bytes)}`, path, key, sha(bytes)),
    ).rejects.toThrow('process stopped');
    expect(durable).toMatchObject({ kind: 'upload', completing: true });
    await store.uploadFile(provider.connection('upload', journal()), `o/${sha(bytes)}`, path, key, sha(bytes));
    expect(provider.seen.filter((request) => request.method === 'PUT')).toHaveLength(2);
    expect(sha(provider.objects.get(`o/${sha(bytes)}`)!)).toBe(sha(bytes));
    expect(durable).toBeNull();
  });

  it('reconciles a renamed verified download after process death without downloading it again', async () => {
    const bytes = Buffer.alloc(4096, 5);
    provider.objects.set(`o/${sha(bytes)}`, bytes);
    const transfer = journal();
    const save = transfer.save;
    transfer.save = async (value) => {
      if (value === null) throw new Error('process stopped');
      await save(value);
    };
    await expect(
      store.download(
        provider.connection('restore', transfer),
        `o/${sha(bytes)}`,
        key,
        join(folder, 'old-stage'),
        sha(bytes),
      ),
    ).rejects.toThrow('process stopped');
    const target = join(folder, 'new-stage');
    await store.download(provider.connection('restore', journal()), `o/${sha(bytes)}`, key, target, sha(bytes));
    expect(provider.seen.filter((request) => request.method === 'GET')).toHaveLength(1);
    expect(await readFile(target)).toEqual(bytes);
    expect(durable).toBeNull();
  });

  it('stops after one renewal when the provider repeatedly returns an expired session with HTTP 400', async () => {
    const connection = provider.connection('upload', journal());
    vi.stubGlobal('fetch', () => Promise.resolve(error('ExpiredToken', 400)));
    await expect(store.put(connection, 'o/item', Buffer.from('data'), key)).rejects.toBeInstanceOf(
      ManagedBackupAuthorizationError,
    );
    expect(provider.renewals).toBe(1);
  });

  it('stops on a bodyless HTTP 400 HEAD refusal without calling intact media damaged', async () => {
    const connection = provider.connection('restore', journal());
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 400 })));
    await expect(store.head(connection, 'o/item', key)).rejects.toBeInstanceOf(ManagedBackupAuthorizationError);
    expect(provider.renewals).toBe(0);
  });

  it('replays a completed download cleaned by the real restore caller after a refused receipt clear', async () => {
    const bytes = Buffer.alloc(4096, 5);
    const hash = sha(bytes);
    provider.objects.set(`o/${hash}`, bytes);
    const manifest: CloudBackupManifest = {
      format: 'frameleaf-backup-manifest',
      version: 1,
      instanceId: 'instance-1',
      createdAt: '2026-10-11T00:00:00.000Z',
      database: null,
      assets: {
        'asset-1': {
          owner: 'owner-1',
          files: [{ role: 'original', path: join(folder, 'photo.jpg'), sha256: hash, size: bytes.length, mtime: null }],
        },
      },
      profiles: {},
      albums: {},
      people: {},
    };
    const plan = restorePlan({
      manifest,
      scope: 'files',
      assetIds: null,
      operationId: 'restore-1',
      mediaLocation: folder,
      currentOriginals: new Map(),
    });
    const restorer = new CloudBackupRestorer(
      store,
      {
        mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
        checkFileExists: (path: string) =>
          access(path)
            .then(() => true)
            .catch(() => false),
        unlink: (path: string) => rm(path),
        rename,
      } as never,
      {
        hashFile: async (path: string) =>
          createHash('sha256')
            .update(await readFile(path))
            .digest(),
      } as never,
      { log: vi.fn() } as never,
    );
    const run = (transfer: BackupTransferJournal) =>
      restorer.restore({
        bucket: { bucketRef: 'managed', connection: provider.connection('restore', transfer), bucketKey: key },
        manifest,
        scope: 'files',
        files: plan.files,
        destination: plan.destination,
        mediaLocation: folder,
        backupsFolder: folder,
        operationId: 'restore-1',
        start: emptyRestoreResult(),
        checkpoint: () => Promise.resolve(true),
      });
    const first = journal();
    const save = first.save;
    first.save = async (value) => {
      if (value === null) throw new Error('receipt clear refused');
      await save(value);
    };
    await expect(run(first)).rejects.toThrow('receipt clear refused');
    expect(durable).toMatchObject({ kind: 'download', offset: bytes.length });
    expect(await run(journal())).toMatchObject({ files: 1, phase: 'done' });
    expect(await readFile(plan.files[0].target)).toEqual(bytes);
    expect(durable).toBeNull();
  });

  it('refuses changed remote data while resuming and preserves the occupied destination', async () => {
    const bytes = Buffer.alloc(4096, 5);
    provider.objects.set('o/item', bytes);
    provider.breakDownload = true;
    const destination = join(folder, 'restored');
    await writeFile(destination, 'original');
    await expect(
      store.download(provider.connection('restore', journal()), 'o/item', key, destination, sha(bytes)),
    ).rejects.toThrow();
    provider.objects.set('o/item', Buffer.alloc(4096, 6));
    await expect(
      store.download(provider.connection('restore', journal()), 'o/item', key, destination, sha(bytes)),
    ).rejects.toThrow('changed');
    expect(await readFile(destination, 'utf8')).toBe('original');
  });

  it('stops renewal for quota/read-only or revocation changes, retaining its in-flight checkpoint', async () => {
    const connection = provider.connection('upload', journal());
    provider.clock = 600_000;
    provider.readOnly = true;
    await expect(store.put(connection, 'o/item', Buffer.from('data'), key)).rejects.toBeInstanceOf(
      ManagedBackupAuthorizationError,
    );
    expect(provider.objects.size).toBe(0);
    const restore = provider.connection('restore');
    provider.revoked = true;
    provider.clock += 600_000;
    await expect(store.get(restore, 'o/item', key)).rejects.toBeInstanceOf(ManagedBackupAuthorizationError);
  });
});
