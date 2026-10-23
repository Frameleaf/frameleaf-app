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
import { clientBackupContext, clientBackupObjectKey } from 'src/utils/cloud-backup-crypto.js';
import {
  type BackupTransfer,
  type BackupTransferJournal,
  backupTransferSchema,
} from 'src/utils/cloud-backup-transfer.js';
import { type CloudBackupManifest } from 'src/utils/cloud-backup.js';
import { type BackupOperation, backupGrantResponseSchema } from 'src/utils/frameleaf-cloud-backup.js';
import {
  ManagedBackupAuthorizationError,
  managedBackupReadSession,
  managedBackupSession,
} from 'src/utils/managed-backup-session.js';
import { OperationClaimLostError } from 'src/utils/operation-execution.js';
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
  versions = new Map<string, Buffer>();
  currentVersions = new Map<string, string>();
  sessions = new Map<string, { grant: ReturnType<typeof fixture>; expires: number }>();
  uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  seen: Array<{
    method: string;
    key: string;
    part: string | null;
    range: string | null;
    version: string | null;
    operation: BackupOperation;
    id: string;
  }> = [];

  private put(key: string, body: Buffer) {
    const version = `version-${this.versions.size + 1}`;
    this.objects.set(key, body);
    this.currentVersions.set(key, version);
    this.versions.set(`${key}/${version}`, body);
    return version;
  }

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
      ...(operation !== 'restore' && {
        managedVersionCredentials: managedBackupReadSession(
          grant,
          () => {
            this.renewals++;
            return Promise.resolve(this.issue('restore'));
          },
          () => this.clock,
        ),
      }),
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
    const client = clientBackupContext(bucket, key);
    if (client) expect(headers.keys().some((name) => name.includes('encryption-customer'))).toBe(false);
    if (url.searchParams.has('versionId') && operation !== 'restore') return error('AccessDenied');
    if (operation === 'restore' && !['GET', 'HEAD'].includes(method)) return error('AccessDenied');
    if (
      method === 'DELETE' &&
      ((!url.searchParams.has('uploadId') && operation !== 'prune') || key === 'frameleaf-backup.json')
    )
      return error('AccessDenied');
    if (operation === 'prune' && ['PUT', 'POST'].includes(method)) return error('AccessDenied');
    this.seen.push({
      method,
      key,
      id,
      operation,
      part: url.searchParams.get('partNumber'),
      range: headers.get('range'),
      version: url.searchParams.get('versionId'),
    });
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
      if (headers.has('if-none-match') && this.objects.has(key)) return error('PreconditionFailed', 412);
      const object = Buffer.concat([...upload.parts].sort(([a], [b]) => a - b).map(([, body]) => body));
      const version = this.put(key, object);
      this.uploads.delete(uploadId);
      if (this.loseComplete) {
        this.loseComplete = false;
        throw new Error('lost complete response');
      }
      return new Response(
        `<CompleteMultipartUploadResult><ETag>"${sha(object)}"</ETag></CompleteMultipartUploadResult>`,
        { headers: { 'x-amz-version-id': version } },
      );
    }
    if (method === 'PUT') {
      if (headers.has('if-none-match') && this.objects.has(key)) return error('PreconditionFailed', 412);
      const version = this.put(key, body!);
      return new Response(null, { headers: { etag: `"${sha(body!)}"`, 'x-amz-version-id': version } });
    }
    if (method === 'DELETE') {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const version = url.searchParams.get('versionId') ?? this.currentVersions.get(key);
    const object = version ? this.versions.get(`${key}/${version}`) : this.objects.get(key);
    if (!object) return error('NoSuchKey', 404);
    const etag = `"${sha(object)}"`;
    if (headers.has('if-match') && headers.get('if-match') !== etag) return error('PreconditionFailed', 412);
    if (method === 'HEAD')
      return new Response(null, {
        headers: { etag, 'content-length': String(object.length), ...(version && { 'x-amz-version-id': version }) },
      });
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
          pull: async (controller) => {
            if (sent) {
              // Deliver the first chunk before simulating an asynchronous network interruption.
              await new Promise<void>((resolve) => setImmediate(resolve));
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
  const vaultId = 'f0000000-0000-4000-8000-000000000001';
  const root = Buffer.alloc(32, 13);
  const encryptedKey = (bytes: Buffer) => clientBackupObjectKey(root, vaultId, 1, sha(bytes));
  const encrypted = (operation: BackupOperation, transfer = journal()): CloudBackupConnection => ({
    ...provider.connection(operation, transfer),
    vaultId,
    recoveryKeys: { 1: root.toString('base64') },
    stagingDirectory: join(folder, 'ciphertext-staging'),
  });
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

  it('starts a new multipart upload when the provider expired the saved one before the run resumed', async () => {
    const bytes = Buffer.alloc(25 * 1024 * 1024, 4);
    const path = join(folder, 'video');
    await writeFile(path, bytes);
    provider.failPart = 3;
    await expect(
      store.uploadFile(provider.connection('upload', journal()), `o/${sha(bytes)}`, path, key, sha(bytes)),
    ).rejects.toBeInstanceOf(ManagedBackupAuthorizationError);
    expect(durable).toMatchObject({ kind: 'upload', completing: false });
    // an abort-incomplete-multipart lifecycle rule removes the upload while the run waits
    provider.uploads.clear();
    provider.failPart = 0;
    provider.unavailable = false;

    await store.uploadFile(provider.connection('upload', journal()), `o/${sha(bytes)}`, path, key, sha(bytes));

    expect(sha(provider.objects.get(`o/${sha(bytes)}`)!)).toBe(sha(bytes));
    expect(durable).toBeNull();
  });

  it('resumes the same encrypted multipart bytes across renewal, outage and a replacement worker', async () => {
    const bytes = Buffer.alloc(25 * 1024 * 1024, 3);
    const objectKey = encryptedKey(bytes);
    const path = join(folder, 'video');
    await writeFile(path, bytes);
    provider.step = 350_000;
    provider.failPart = 3;
    await expect(store.uploadFile(encrypted('upload'), objectKey, path, key, sha(bytes))).rejects.toBeInstanceOf(
      ManagedBackupAuthorizationError,
    );
    expect(durable).toMatchObject({ kind: 'upload', key: objectKey, parts: [{ partNumber: 1 }, { partNumber: 2 }] });
    const receipt = backupTransferSchema.parse(durable);
    if (receipt.kind !== 'upload') throw new Error('Expected upload receipt');
    expect(receipt.source).toMatch(/\.ciphertext$/);
    expect(receipt.expectedSha256).not.toBe(sha(bytes));
    expect(sha(await readFile(receipt.source!))).toBe(receipt.expectedSha256);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(root.toString('base64'));
    expect(serialized).not.toContain(key.toString('base64'));
    for (const session of provider.sessions.values()) {
      expect(serialized).not.toContain(session.grant.capability.credentials.secretAccessKey);
      expect(serialized).not.toContain(session.grant.capability.credentials.sessionToken);
    }
    provider.failPart = 0;
    provider.unavailable = false;
    const restarted = new CloudBackupStoreRepository({ setContext: vi.fn(), warn: vi.fn() } as never);
    restarted.retryDelaysMs = [];
    await restarted.uploadFile(encrypted('upload'), objectKey, path, key, sha(bytes));
    expect(provider.seen.filter((request) => request.method === 'PUT' && request.part === '1')).toHaveLength(1);
    expect(provider.seen.filter((request) => request.method === 'PUT' && request.part === '2')).toHaveLength(1);
    expect(sha(provider.objects.get(objectKey)!)).toBe(receipt.expectedSha256);
    expect((await store.get(encrypted('restore'), objectKey, key, sha(bytes))).equals(bytes)).toBe(true);
    expect(durable).toBeNull();
  });

  it.each(['create', 'complete'])(
    'reconciles an encrypted manifest after a lost multipart %s response using restore authority for exact versions',
    async (which) => {
      const bytes = Buffer.alloc(9 * 1024 * 1024, 1);
      const path = join(folder, 'manifest');
      await writeFile(path, bytes);
      const objectKey = `m/v1/${vaultId}/1/20261011T000001Z.json.gz`;
      provider.loseCreate = which === 'create';
      provider.loseComplete = which === 'complete';
      store.retryDelaysMs = [0];
      const result = await store.uploadFile(encrypted('upload'), objectKey, path, key, sha(bytes));
      expect(result.versionId).toBe('version-1');
      expect(result.ciphertextSha256).toBe(sha(provider.objects.get(objectKey)!));
      expect(provider.versions.size).toBe(1);
      expect(provider.uploads.size).toBe(0);
      if (which === 'complete') {
        expect(
          provider.seen.some((request) => request.version === result.versionId && request.operation === 'restore'),
        ).toBe(true);
      }
      expect(durable).toBeNull();
    },
  );

  it('resumes ciphertext ranges after an outage and authenticates the complete plaintext before publication', async () => {
    const bytes = Buffer.alloc(4096, 5);
    const path = join(folder, 'source');
    const objectKey = encryptedKey(bytes);
    await writeFile(path, bytes);
    await store.uploadFile(encrypted('upload'), objectKey, path, key, sha(bytes));
    provider.breakDownload = true;
    provider.expireDownload = true;
    store.retryDelaysMs = [0];
    const destination = join(folder, 'restored');
    await writeFile(destination, 'existing original');
    await expect(store.download(encrypted('restore'), objectKey, key, destination, sha(bytes))).rejects.toThrow();
    expect(durable).toMatchObject({
      kind: 'download',
      offset: 1024,
      plaintextSha256: sha(bytes),
      size: provider.objects.get(objectKey)!.length,
    });
    expect(await readFile(destination, 'utf8')).toBe('existing original');
    provider.expireDownload = false;
    provider.unavailable = false;
    await expect(store.download(encrypted('restore'), objectKey, key, destination, sha(bytes))).resolves.toEqual({
      size: bytes.length,
      sha256: sha(bytes),
    });
    expect(provider.seen.some((request) => request.range === 'bytes=1024-' && request.version === 'version-1')).toBe(
      true,
    );
    expect(await readFile(destination)).toEqual(bytes);
    expect(durable).toBeNull();
  });

  it.each(['root', 'footer'])(
    'keeps the destination intact when a resumed ciphertext has an invalid %s',
    async (problem) => {
      const bytes = Buffer.alloc(4096, 5);
      const path = join(folder, 'source');
      const destination = join(folder, 'restored');
      const objectKey = encryptedKey(bytes);
      await writeFile(path, bytes);
      await store.uploadFile(encrypted('upload'), objectKey, path, key, sha(bytes));
      await writeFile(destination, 'existing original');
      const connection = encrypted('restore');
      if (problem === 'root') connection.recoveryKeys = { 1: Buffer.alloc(32, 99).toString('base64') };
      else provider.objects.get(objectKey)![provider.objects.get(objectKey)!.length - 1] ^= 1;
      await expect(store.download(connection, objectKey, key, destination, sha(bytes))).rejects.toMatchObject({
        code: 'ChecksumMismatch',
      });
      expect(await readFile(destination, 'utf8')).toBe('existing original');
      expect(durable).toBeNull();
    },
  );

  it('checks the current claim after decrypting and resumes verified ciphertext without publishing on claim loss', async () => {
    const bytes = Buffer.alloc(4096, 5);
    const objectKey = encryptedKey(bytes);
    const source = join(folder, 'source');
    const destination = join(folder, 'restored');
    await writeFile(source, bytes);
    await store.uploadFile(encrypted('upload'), objectKey, source, key, sha(bytes));
    await writeFile(destination, 'existing original');
    const transfer = journal();
    const save = transfer.save;
    let completed = 0;
    transfer.save = (value) =>
      value?.kind === 'download' && value.completed && ++completed === 2
        ? Promise.reject(new OperationClaimLostError())
        : save(value);
    await expect(
      store.download(encrypted('restore', transfer), objectKey, key, destination, sha(bytes)),
    ).rejects.toBeInstanceOf(OperationClaimLostError);
    expect(await readFile(destination, 'utf8')).toBe('existing original');
    expect(durable).toMatchObject({ kind: 'download', offset: provider.objects.get(objectKey)!.length });
    await store.download(encrypted('restore'), objectKey, key, destination, sha(bytes));
    expect(provider.seen.filter((request) => request.method === 'GET' && request.key === objectKey)).toHaveLength(1);
    expect(await readFile(destination)).toEqual(bytes);
    expect(durable).toBeNull();
  });

  it('fences encrypted uploads before the first mutation and after accepted parts', async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024, 3);
    const path = join(folder, 'video');
    const objectKey = encryptedKey(bytes);
    await writeFile(path, bytes);
    const refused = journal();
    refused.save = () => Promise.reject(new OperationClaimLostError());
    await expect(
      store.uploadFile(encrypted('upload', refused), objectKey, path, key, sha(bytes)),
    ).rejects.toBeInstanceOf(OperationClaimLostError);
    expect(provider.seen).toHaveLength(0);
    const stopped = journal();
    const save = stopped.save;
    stopped.save = (value) =>
      value?.kind === 'upload' && value.parts.length > 0 ? Promise.reject(new OperationClaimLostError()) : save(value);
    await expect(
      store.uploadFile(encrypted('upload', stopped), objectKey, path, key, sha(bytes)),
    ).rejects.toBeInstanceOf(OperationClaimLostError);
    expect(provider.seen.filter((request) => request.method === 'PUT')).toHaveLength(1);
    await store.uploadFile(encrypted('upload'), objectKey, path, key, sha(bytes));
    expect(provider.seen.filter((request) => request.method === 'PUT' && request.part === '1')).toHaveLength(1);
    expect((await store.get(encrypted('restore'), objectKey, key, sha(bytes))).equals(bytes)).toBe(true);
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
