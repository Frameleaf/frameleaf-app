import {
  encryptFile as encryptLockedFile,
  generateKeyPair as generateLockedKeyPair,
  isLockedFile,
} from '@frameleaf/locked-crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import AsyncLock from 'async-lock';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { lookup } from 'node:dns';
import { EventEmitter } from 'node:events';
import { copyFile as copyFileOf, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { LookupAddress } from 'node:dns';
import type { RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { CloudBackupEntry } from 'src/repositories/cloud-backup-index.repository.js';
import type { CloudBackupRestoreSnapshot } from 'src/services/cloud-backup-restore.js';
import type { FrameleafCloudBackup } from 'src/types.js';
import type { CloudBackupManifest } from 'src/utils/cloud-backup.js';
import type { ConfigHistory } from 'src/utils/config-history.js';
import type { PushNotice } from 'src/utils/frameleaf-push.js';
import type { Mock } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  DatabaseLock,
  JobStatus,
  MediaOperationKind,
  MediaOperationStatus,
  MlAdmissionRefusal,
  PushEventType,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import {
  CloudBackupClaimError,
  CloudBackupFileChangedError,
  CloudBackupStoreError,
} from 'src/repositories/cloud-backup-store.repository.js';
import { FrameleafCloudBackupRepository } from 'src/repositories/frameleaf-cloud-backup.repository.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { emptyRestoreResult } from 'src/services/cloud-backup-restore.js';
import { CLOUD_BACKUP_VERIFY_CRON, CloudBackupService } from 'src/services/cloud-backup.service.js';
import { selectBackupLocation } from 'src/utils/backup-location-selection.js';
import {
  addClientBackupKeys,
  clientBackupContext,
  clientBackupObjectKey,
  decryptClientBackup,
  encryptClientBackup,
  rotateClientBackupKeys,
} from 'src/utils/cloud-backup-crypto.js';
import { EMPTY_DETAILS } from 'src/utils/cloud-backup-details.js';
import { unwrapBucketKey } from 'src/utils/cloud-backup-escrow.js';
import {
  type BackupKeyRequest,
  CloudBackupKeyChannel,
  loadBackupWorkerIdentity,
} from 'src/utils/cloud-backup-key-channel.js';
import {
  type BackupRecoveryHistory,
  appendBackupSnapshot,
  readBackupHistory,
  selectBackupSnapshot,
  signBackupSnapshot,
  unwrapBackupRecoveryKit,
  writeBackupHistory,
} from 'src/utils/cloud-backup-recovery.js';
import { backupUserFingerprint } from 'src/utils/cloud-backup-selection.js';
import { backupKeyFile, bucketRef, emptyRunResult, keyFingerprint } from 'src/utils/cloud-backup.js';
import { readConfig } from 'src/utils/config.js';
import { executionSignal, operationExecution } from 'src/utils/execution-signal.js';
import { keyEscrowBlobSchema, managedStorageRef } from 'src/utils/frameleaf-cloud-backup.js';
import { FrameleafCloudError, ed25519Thumbprint, errorEnvelopeSchema } from 'src/utils/frameleaf-cloud.js';
import { ManagedBackupAuthorizationError } from 'src/utils/managed-backup-session.js';
import {
  OperationClaimLostError,
  OperationDeadlineError,
  withOperationExecution,
} from 'src/utils/operation-execution.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { expectLocalisedSystemNotices, getMocks } from 'test/utils.js';

vi.mock('src/utils/backup-location-selection.js', () => ({ selectBackupLocation: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, link: vi.fn(original.link) };
});
vi.mock('src/utils/cloud-backup-key-channel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/cloud-backup-key-channel.js')>()),
  loadBackupWorkerIdentity: vi.fn(),
}));
vi.mock('node:dns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns')>()),
  lookup: vi.fn(),
}));
vi.mock('node:https', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:https')>()),
  request: vi.fn(),
}));

/** Each escrow open or wrap runs the real scrypt (N = 2^17, 128 MiB); a busy runner needs more than 5 s. */
const SCRYPT_TEST_TIMEOUT_MS = 30_000;

// Client roots are bound to a UUID vault (the instance id); every manifest row names a UUID snapshot.
const INSTANCE_ID = 'f0000000-0000-4000-8000-000000000001';
const MANIFEST_ID = 'f0000000-0000-4000-8000-00000000a001';

const hex = (text: string) => createHash('sha256').update(text).digest('hex');
const SHA_A = hex('a');
const SHA_B = hex('b');
const SHA_C = hex('c');
const SHA_SIDECAR = hex('sidecar');
const SHA_DUMP = hex('dump');

const key = Buffer.alloc(32, 7);
const workerIdentity = generateKeyPairSync('ed25519').privateKey;
const fingerprint = keyFingerprint(key);
const s3 = {
  endpoint: 'https://s3.eu-central-2.storage.example',
  region: '',
  bucket: 'family-backup',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 's3-secret',
};
const ref = bucketRef(s3.endpoint, s3.bucket);
const instance = {
  instanceId: INSTANCE_ID,
  kid: 'kid-1',
  publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' },
  keyFile: '/identity/instance-key.pem',
  createdAt: '2026-09-01T00:00:00.000Z',
};
type CloudBackupClaimOverrides = Record<string, unknown> & { target?: FrameleafCloudBackup['target'] };

const claim = (overrides: CloudBackupClaimOverrides = {}): FrameleafCloudBackup =>
  ({
    target: 'byo-s3',
    bucketRef: ref,
    endpoint: s3.endpoint,
    region: 'eu-central-2',
    bucket: s3.bucket,
    instanceId: INSTANCE_ID,
    claimedAt: '2026-09-25T00:00:00.000Z',
    keyMode: 'server',
    keyFingerprint: fingerprint,
    reconciledAt: '2026-09-25T00:00:00.000Z',
    ...overrides,
  }) as FrameleafCloudBackup;
const enabledConfig = (keyMode = 'server', include?: { thumbs: boolean; encodedVideo: boolean }) => ({
  frameleafCloud: {
    cloudBackup: {
      enabled: true,
      target: 'byo-s3',
      s3,
      keyMode,
      include: include ?? { thumbs: false, encodedVideo: false },
    },
  },
});
/** A recovery key file from before client roots: setup and new runs refuse it; legacy reads still accept it. */
const legacyKeyFileOf = (mode: 'server' | 'own-stored' | 'own-memory' = 'server') =>
  JSON.stringify(backupKeyFile({ key, instanceId: INSTANCE_ID, bucket: s3.bucket, mode, createdAt: new Date() }));
/** The same client root every time, so a key file read again matches the ring this server already loaded. */
const clientRing = { vaultId: INSTANCE_ID, current: 1, keys: { 1: Buffer.alloc(32, 42).toString('base64') } };
const clientRoot = Buffer.from(clientRing.keys[1], 'base64');
const keyFileOf = (mode: 'server' | 'own-stored' | 'own-memory' = 'server') =>
  JSON.stringify({ ...JSON.parse(legacyKeyFileOf(mode)), client: clientRing });

const running = { status: MediaOperationStatus.Rendering, cancelRequestedAt: null, pauseRequestedAt: null };

const operationOf = (overrides: Partial<MediaOperation> = {}): MediaOperation =>
  ({
    id: 'run-1',
    ownerId: authStub.admin.user.id,
    kind: MediaOperationKind.CloudBackup,
    status: MediaOperationStatus.Preparing,
    snapshot: { version: 1, bucketRef: ref, keyFingerprint: fingerprint },
    result: null,
    processedUnits: '0',
    totalUnits: null,
    progress: 0,
    pauseRequestedAt: null,
    createdAt: new Date('2026-09-26T03:00:00.000Z'),
    ...overrides,
  }) as unknown as MediaOperation;

const asset = (id: string, sha256: string | null, files: Array<{ type: string; path: string }> = []) => ({
  id,
  ownerId: 'owner-1',
  originalPath: `/data/library/${id}.jpg`,
  sha256,
  checksumSize: 100,
  verifiedAt: new Date('2026-09-10T00:00:00.000Z'),
  checksumPathVerified: true,
  files,
});

const entry = (fileKey: string, overrides: Partial<CloudBackupEntry> = {}): CloudBackupEntry => ({
  fileKey,
  assetId: fileKey.split(':', 1)[0],
  ownerId: 'owner-1',
  role: 'original',
  path: `/data/library/${fileKey}`,
  sha256: SHA_A,
  size: 100,
  mtime: new Date('2026-09-01T00:00:00.000Z'),
  ...overrides,
});

const dumpName = 'cloud-backup-frameleaf-db-backup-dump.sql.gz';
const dumpKey = `db/${dumpName}`;
/** Where this server writes a file and its database dump: opaque client keys under its vault. */
const objectKeyOf = (sha256: string) => clientBackupObjectKey(clientRoot, INSTANCE_ID, 1, sha256);
const clientDumpKey = clientBackupObjectKey(clientRoot, INSTANCE_ID, 1, SHA_DUMP, dumpName);
const MANIFEST_KEY = `m/v1/${INSTANCE_ID}/1/20260926T030000Z.json.gz`;
const ALBUM_ID = '5b0c4e8a-1d2f-4a3b-9c8d-7e6f5a4b3c2d';

const recoveryFixture = () => {
  const vaultId = 'f0000000-0000-4000-8000-000000000001';
  const file = addClientBackupKeys({ ...JSON.parse(keyFileOf()), instanceId: vaultId });
  const pair = generateKeyPairSync('ed25519');
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const publicJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: jwk.x! };
  const signer = {
    kid: ed25519Thumbprint(publicJwk),
    publicJwk,
    sign: () => '',
    signBytes: (bytes: Buffer) => sign(null, bytes, pair.privateKey),
  };
  const snapshot = (sequence: number, previousDigest: string | null, versionId = `version-${sequence}`) =>
    signBackupSnapshot(
      {
        version: 2,
        instanceId: vaultId,
        vaultId,
        snapshotId: `f0000000-0000-4000-8000-${String(sequence + 10).padStart(12, '0')}`,
        sequence,
        previousDigest,
        createdAt: '2026-10-11T00:00:00.000Z',
        manifest: {
          format: 'frameleaf-client-backup',
          formatVersion: 1,
          keyVersion: 1,
          objectKey: `m/v1/${vaultId}/1/20261011T0000${String(sequence).padStart(2, '0')}Z.json.gz`,
          versionId,
          ciphertextSha256: 'a'.repeat(64),
        },
        signerKid: signer.kid,
      },
      signer,
    );
  const first = snapshot(1, null);
  const older = appendBackupSnapshot(null, first);
  const second = snapshot(2, first.digest);
  return { vaultId, file, signer, snapshot, older, history: appendBackupSnapshot(older, second), first, second };
};

const snapshotSignerPair = generateKeyPairSync('ed25519');
const snapshotSignerJwk = {
  kty: 'OKP' as const,
  crv: 'Ed25519' as const,
  x: snapshotSignerPair.publicKey.export({ format: 'jwk' }).x!,
};
/** The instance identity signs each completed client snapshot. */
const snapshotSigner = {
  kid: ed25519Thumbprint(snapshotSignerJwk),
  publicJwk: snapshotSignerJwk,
  sign: () => '',
  signBytes: (bytes: Buffer) => sign(null, bytes, snapshotSignerPair.privateKey),
};

const managedGrantFixture = (name: string) => {
  const legacy = cloudContractFixture(name);
  const {
    accessKeyId: _id,
    expiresAt: _expires,
    rotateAfterSec: _after,
    previousKeyExpiresAt: _previous,
    credentials,
    ...metadata
  } = legacy;
  const current = cloudContractFixture('backup/capability-upload.json');
  return {
    ...metadata,
    version: 4,
    coverage: current.coverage,
    objectFormats: current.objectFormats,
    ...(credentials && {
      capability: {
        ...current.capability,
        credentials: { ...credentials, sessionToken: 'synthetic-session-token-example' },
      },
    }),
  };
};

describe(CloudBackupService.name, () => {
  let sut: CloudBackupService;
  let mocks: ReturnType<typeof getMocks>;
  let metadata: Record<string, unknown>;
  let operations: Record<string, Mock>;
  let store: Record<string, Mock>;
  let index: Record<string, Mock>;
  let keys: Record<string, Mock>;
  let databaseBackup: Record<string, Mock>;
  let cloudBackup: Record<string, Mock>;
  let details: Record<string, Mock>;
  let selection: Record<string, Mock>;
  /** What each streamed upload sent (the gzipped manifests). */
  let streamed: Buffer[];
  /** A real folder: a completed client manifest appends its signed snapshot to the history kept there. */
  let identityDir: string;

  const build = () =>
    new CloudBackupService(
      mocks.logger as never,
      mocks.config as never,
      mocks.systemMetadata as never,
      mocks.forkSchema as never,
      mocks.database as never,
      mocks.instanceIdentity as never,
      mocks.frameleafCloud as never,
      mocks.event as never,
      mocks.websocket as never,
      operations as never,
      mocks.storage as never,
      mocks.crypto as never,
      store as never,
      index as never,
      keys as never,
      databaseBackup as never,
      cloudBackup as never,
      mocks.user as never,
      mocks.cron as never,
      mocks.job as never,
      details as never,
      selection as never,
      mocks.lockedEncryption as never,
    );

  const configWrites = () =>
    mocks.systemMetadata.set.mock.calls
      .filter(([key]) => key === SystemMetadataKey.SystemConfig)
      .map(([, value]) => value);
  const savedConfig = () =>
    readConfig({
      configRepo: mocks.config,
      metadataRepo: mocks.systemMetadata as never,
      logger: mocks.logger as never,
    });

  const uploadedKeys = () => store.uploadFile.mock.calls.map(([, objectKey]) => objectKey as string);
  const manifestOf = (at = 0) => JSON.parse(gunzipSync(streamed[at]).toString());
  type Recorded = { mock: { calls: unknown[][]; invocationCallOrder: number[] } };
  const orderOf = (recorded: Recorded, predicate: (args: unknown[]) => boolean) =>
    recorded.mock.invocationCallOrder[recorded.mock.calls.findIndex((args) => predicate(args))];
  const keyRequest = () =>
    mocks.websocket.serverSend.mock.calls.findLast(
      ([name]) => name === 'CloudBackupKeyRequest',
    )?.[1] as BackupKeyRequest;

  beforeEach(async () => {
    identityDir = await mkdtemp(join(tmpdir(), 'cloud-backup-identity-'));
    vi.mocked(loadBackupWorkerIdentity).mockReset().mockResolvedValue(workerIdentity);
    vi.mocked(selectBackupLocation).mockReset();
    mocks = getMocks();
    metadata = {};
    mocks.systemMetadata.get.mockImplementation((name) => Promise.resolve(metadata[name] as never));
    mocks.systemMetadata.set.mockImplementation((name: string, value: unknown) => {
      metadata[name] = value;
      return Promise.resolve();
    });
    mocks.config.getEnv.mockReturnValue(
      mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir } }),
    );
    mocks.instanceIdentity.loadOrCreate.mockResolvedValue(instance as never);
    mocks.instanceIdentity.currentSigner.mockReturnValue(snapshotSigner);
    mocks.event.emit.mockResolvedValue();
    mocks.storage.stat.mockResolvedValue({ size: 100, mtime: new Date('2026-09-01T00:00:00.000Z') } as never);
    mocks.storage.readdir.mockResolvedValue([]);
    streamed = [];
    mocks.crypto.hashFile.mockImplementation((path: string | Buffer) =>
      Promise.resolve(Buffer.from(hex(String(path).includes('dump') ? 'dump' : String(path)), 'hex')),
    );

    details = {
      putBack: vi.fn().mockResolvedValue(true),
      recreate: vi.fn().mockImplementation(({ assetId }) => Promise.resolve({ status: 'created', assetId })),
      restoreAlbum: vi.fn().mockResolvedValue('created'),
      restoreStacks: vi.fn().mockResolvedValue(undefined),
    };
    operations = {
      getActiveOfKind: vi.fn().mockResolvedValue(undefined),
      getOfKind: vi.fn().mockResolvedValue(undefined),
      createExclusive: vi.fn().mockResolvedValue({ created: operationOf() }),
      requestPause: vi.fn().mockResolvedValue(operationOf()),
      resume: vi.fn().mockResolvedValue(operationOf()),
      requestCancel: vi.fn().mockResolvedValue(operationOf()),
      claimNext: vi.fn().mockResolvedValue(undefined),
      heartbeat: vi.fn().mockResolvedValue(true),
      reportProgress: vi.fn().mockResolvedValue(true),
      setBulkResult: vi.fn().mockResolvedValue(running),
      setBackupTransfer: vi.fn().mockResolvedValue(true),
      beginValidation: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('failed'),
      requeue: vi.fn().mockResolvedValue(true),
      acknowledgeCancel: vi.fn().mockResolvedValue(true),
      settlePause: vi.fn().mockResolvedValue(true),
    };
    store = {
      probe: vi.fn().mockResolvedValue({ state: 'empty' }),
      claim: vi.fn().mockResolvedValue({ existing: false, claimedAt: '2026-09-26T03:00:00.000Z' }),
      uploadFile: vi
        .fn()
        .mockImplementation((_connection, _key, path: string) =>
          Promise.resolve({ etag: '"etag"', size: path.includes('dump') ? 50 : 100 }),
        ),
      put: vi.fn().mockResolvedValue({ etag: '"manifest"', encrypted: true }),
      uploadStream: vi.fn().mockImplementation(async (_connection, _key, source: AsyncIterable<Buffer>) => {
        const chunks: Buffer[] = [];
        for await (const chunk of source) {
          chunks.push(Buffer.from(chunk));
        }
        streamed.push(Buffer.concat(chunks));
        return {
          etag: '"manifest"',
          size: streamed.at(-1)!.length,
          versionId: `manifest-version-${streamed.length}`,
          ciphertextSha256: 'a'.repeat(64),
        };
      }),
      // nothing is in the bucket under a client object key until this server writes it
      head: vi.fn().mockResolvedValue(null),
      hashObject: vi.fn().mockRejectedValue(new CloudBackupStoreError('missing', 404, 'NoSuchKey')),
      finishClientUpload: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      listAll: vi.fn().mockResolvedValue(0),
      readMarker: vi.fn().mockResolvedValue({
        format: 'frameleaf-backup',
        version: 1,
        instanceId: INSTANCE_ID,
        keyFingerprint: fingerprint,
        claimedAt: '2026-09-25T00:00:00.000Z',
      }),
    };
    index = {
      getRecorded: vi.fn().mockResolvedValue(new Map()),
      record: vi.fn().mockResolvedValue(undefined),
      getUsage: vi.fn().mockResolvedValue({ objects: 2, bytes: 200 }),
      createManifest: vi.fn().mockResolvedValue({ id: MANIFEST_ID, key: MANIFEST_KEY }),
      getManifest: vi.fn().mockResolvedValue(undefined),
      finishManifest: vi.fn().mockResolvedValue(undefined),
      upsertEntries: vi.fn().mockResolvedValue(undefined),
      getEntriesPage: vi.fn().mockResolvedValue([]),
      deleteEntries: vi.fn().mockResolvedValue(undefined),
      deleteBucket: vi.fn().mockResolvedValue(undefined),
      currentTime: vi.fn().mockResolvedValue('2026-09-26T02:59:00.123456+00:00'),
      pruneUnseen: vi.fn().mockResolvedValue(0),
      setManifestDatabase: vi.fn().mockResolvedValue(undefined),
      getKeptDatabaseKeys: vi.fn().mockResolvedValue(new Set()),
      getManifestKeys: vi.fn().mockResolvedValue(new Set()),
      adoptManifests: vi.fn().mockResolvedValue(0),
      listKeptManifests: vi.fn().mockResolvedValue([]),
      getOwnerBackupCandidates: vi
        .fn()
        .mockImplementation(
          async (bucket: string) =>
            new Set((await index.listKeptManifests(bucket)).map(({ key }: { key: string }) => key)),
        ),
      markManifests: vi.fn().mockResolvedValue(0),
      forget: vi.fn().mockResolvedValue(undefined),
      getOwnerRestoreIdentities: vi.fn().mockResolvedValue({}),
      getOwnerHistoryState: vi.fn().mockResolvedValue(new Map()),
      getLibraryState: vi.fn().mockResolvedValue(new Map()),
      getTakenPaths: vi.fn().mockResolvedValue(new Set()),
      getEndedTransfers: vi.fn().mockResolvedValue([]),
      clearEndedTransfer: vi.fn().mockResolvedValue(undefined),
      getUnfinishedOperationIds: vi.fn().mockResolvedValue(new Set()),
      getOwnerNames: vi.fn().mockResolvedValue(new Map()),
      endAbandonedManifests: vi.fn().mockResolvedValue(0),
      countAssets: vi.fn().mockResolvedValue(3),
      listAssets: vi.fn().mockResolvedValue([]),
      listProfileImages: vi.fn().mockResolvedValue([]),
      getAssetDetails: vi.fn().mockResolvedValue(new Map()),
      getAlbumRecords: vi.fn().mockResolvedValue(new Map()),
      getPersonRecords: vi.fn().mockResolvedValue(new Map()),
      getAlbumMembers: vi.fn().mockResolvedValue(new Map()),
    };
    selection = {
      getDecisionRun: vi.fn().mockResolvedValue(undefined),
      captureInventory: vi.fn().mockResolvedValue({ inventoryAt: new Date(), created: true }),
      getEligibleOwners: vi.fn().mockResolvedValue(new Set()),
      recordIncluded: vi.fn().mockResolvedValue(undefined),
      getDecisionAccounts: vi.fn().mockResolvedValue([]),
      getCoverageReport: vi.fn().mockResolvedValue(undefined),
      createCoverageReport: vi.fn(),
      updateCoverageReport: vi.fn().mockResolvedValue(undefined),
      listDueCoverageReports: vi.fn().mockResolvedValue([]),
      getLatestCoverageReport: vi.fn().mockResolvedValue(undefined),
      findDecisionRunByManifest: vi.fn().mockResolvedValue(undefined),
      getInventoryPage: vi.fn().mockResolvedValue([]),
      listAccounts: vi.fn().mockResolvedValue([]),
    };
    keys = {
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue({ path: '/identity/cloud-backup.key', created: true }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    databaseBackup = {
      createDatabaseBackup: vi.fn().mockResolvedValue(join(StorageCore.getBaseFolder(StorageFolder.Backups), dumpName)),
    };
    cloudBackup = {
      metadata: vi.fn().mockResolvedValue(null),
      locations: vi.fn().mockResolvedValue({ version: 2, locations: [] }),
      grant: vi.fn(),
      rotate: vi.fn(),
      usage: vi.fn(),
      reportRun: vi.fn().mockResolvedValue(undefined),
      putSettings: vi.fn().mockResolvedValue(undefined),
      putEscrow: vi.fn().mockResolvedValue(undefined),
      getEscrow: vi.fn(),
      deleteEscrow: vi.fn().mockResolvedValue(undefined),
      reportSnapshot: vi.fn().mockResolvedValue(undefined),
      listSnapshots: vi.fn().mockResolvedValue([]),
      putRecoveryPackage: vi.fn().mockResolvedValue(undefined),
      deleteRecoveryPackages: vi.fn().mockResolvedValue(undefined),
    };
    sut = build();
    // an own-memory key is asked for without waiting; a spec that needs the wait sets it
    sut.keyAskMs = 0;
  });
  afterEach(() => sut.onShutdown());
  afterEach(() => rm(identityDir, { recursive: true, force: true }));
  // FL-406: every cloud backup notice carries a system template whose English matches the supplied text
  afterEach(() => expectLocalisedSystemNotices(mocks.event.emit));

  // FL-697: managed restores advance the saved history with Cloud's signed records, never trusting them blindly
  describe('managed snapshot history from Frameleaf Cloud', () => {
    const internal = () =>
      sut as unknown as {
        withCloudHistory: (history: BackupRecoveryHistory | null) => Promise<BackupRecoveryHistory | null>;
        managedApi: () => Promise<{ api: string; token: string }>;
      };

    beforeEach(() => {
      vi.spyOn(internal(), 'managedApi').mockResolvedValue({ api: 'https://cloud.test', token: 'synthetic' });
    });

    it('selects the newest Cloud record that chains from the saved anchor', async () => {
      const fixture = recoveryFixture();
      const third = fixture.snapshot(3, fixture.second.digest);
      cloudBackup.listSnapshots.mockResolvedValue([third]);
      const history = await internal().withCloudHistory(fixture.history);
      expect(cloudBackup.listSnapshots).toHaveBeenCalledWith(expect.anything(), fixture.vaultId, 2);
      expect(selectBackupSnapshot(history!).record.digest).toBe(third.digest);
    });

    it('keeps the saved history when Cloud is unreachable', async () => {
      const fixture = recoveryFixture();
      cloudBackup.listSnapshots.mockRejectedValue(new Error('offline'));
      await expect(internal().withCloudHistory(fixture.history)).resolves.toBe(fixture.history);
    });

    it('keeps the saved history when Cloud returns a record the pinned keys did not sign', async () => {
      const fixture = recoveryFixture();
      const forged = recoveryFixture().snapshot(3, fixture.second.digest);
      cloudBackup.listSnapshots.mockResolvedValue([forged]);
      const history = await internal().withCloudHistory(fixture.history);
      expect(selectBackupSnapshot(history!).record.digest).toBe(fixture.second.digest);
    });
  });

  describe('metadata update races', () => {
    const internal = () =>
      sut as unknown as {
        updateMetadata: (change: (current: FrameleafCloudBackup) => FrameleafCloudBackup) => Promise<void>;
        refreshManagedUsage: (current: FrameleafCloudBackup, linked: boolean) => Promise<FrameleafCloudBackup>;
        managedApi: () => Promise<{ api: string; token: string }>;
      };

    it('checks active operations under the bucket lock before turning backup off', async () => {
      const held = new Set<DatabaseLock>();
      const lock = new AsyncLock();
      mocks.database.withLock.mockImplementation((key, callback) =>
        lock.acquire(String(key), async () => {
          held.add(key);
          try {
            return await callback();
          } finally {
            held.delete(key);
          }
        }),
      );
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      const set = mocks.systemMetadata.set.getMockImplementation()!;
      mocks.systemMetadata.set.mockImplementation((name, value, overwrite) => {
        if (name === SystemMetadataKey.SystemConfig) expect(held.has(DatabaseLock.FrameleafCloudBackup)).toBe(true);
        return set(name, value, overwrite);
      });
      mocks.event.emit.mockImplementation(() => {
        expect(held.has(DatabaseLock.FrameleafCloudBackup)).toBe(false);
        return Promise.resolve();
      });
      operations.getActiveOfKind.mockImplementationOnce(() => {
        expect(held.has(DatabaseLock.FrameleafCloudBackup)).toBe(true);
        return Promise.resolve(undefined);
      });
      await sut.turnOff(authStub.admin);
      expect((await savedConfig()).frameleafCloud.cloudBackup.enabled).toBe(false);
    });

    it('preserves fields from simultaneous metadata updates under the existing bucket lock', async () => {
      const lock = new AsyncLock();
      mocks.database.withLock.mockImplementation((key, callback) => lock.acquire(String(key), callback));
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      await Promise.all([
        internal().updateMetadata((current) => ({ ...current, lastCheckAt: 'check' })),
        internal().updateMetadata((current) => ({ ...current, lastFullVerifyAt: 'verify' })),
      ]);
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        lastCheckAt: 'check',
        lastFullVerifyAt: 'verify',
      });
    });

    it.each([
      ['bucket', { bucketRef: 'replacement' }],
      ['key', { keyFingerprint: 'replacement' }],
      ['target', { target: 'byo-s3' as const }],
      ['instance', { instanceId: 'replacement' }],
      ['bucket name', { bucket: 'replacement' }],
      ['region', { region: 'replacement' }],
      ['storage ID', { managed: { storageId: 'replacement' } }],
      ['location', { managed: { location: { locationId: 'replacement' } } }],
    ] as const)('ignores a delayed usage response after setup changes the %s', async (_changed, patch) => {
      const before = claim({ target: 'managed' });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = before;
      vi.spyOn(internal(), 'managedApi').mockResolvedValue({ api: 'https://cloud.test', token: 'synthetic' });
      const { promise, resolve } = Promise.withResolvers<unknown>();
      cloudBackup.usage.mockReturnValue(promise);
      const refresh = internal().refreshManagedUsage(before, true);
      await vi.waitFor(() => expect(cloudBackup.usage).toHaveBeenCalledOnce());
      const replacement = { ...before, ...patch };
      metadata[SystemMetadataKey.FrameleafCloudBackup] = replacement;
      resolve({
        includedBytes: 10,
        readOnly: false,
        readOnlyReason: null,
        measuredAt: 'now',
        bytesCurrent: 2,
        objects: 1,
        allowanceBytes: 10,
        extraBlocks: 0,
      });
      await refresh;
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toEqual(replacement);
    });

    it('merges usage into the latest managed state without losing a newer refusal', async () => {
      const before = claim({
        target: 'managed',
        managed: { checkedAt: '2000-01-01', readOnly: false, readOnlyReason: null, quotaBytes: 1 },
      });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = before;
      vi.spyOn(internal(), 'managedApi').mockResolvedValue({ api: 'https://cloud.test', token: 'synthetic' });
      cloudBackup.usage.mockImplementation(() => {
        metadata[SystemMetadataKey.FrameleafCloudBackup] = {
          ...before,
          managed: { ...before.managed, refusal: 'new refusal' },
        };
        return Promise.resolve({
          includedBytes: 10,
          readOnly: false,
          readOnlyReason: null,
          measuredAt: 'now',
          bytesCurrent: 2,
          objects: 1,
          allowanceBytes: 10,
          extraBlocks: 0,
        });
      });
      await internal().refreshManagedUsage(before, true);
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        managed: { refusal: 'new refusal', quotaBytes: 10, usage: { bytesCurrent: 2 } },
      });
    });
  });

  describe('ordinary checkpoint claim authority', () => {
    it.each(
      ['run', 'task'].flatMap((mode) => ['cancelled', 'claim-lost', 'resumed'].map((state) => ({ mode, state }))),
    )('rechecks authority after a failed pause: $mode / $state', async ({ mode, state }) => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      const operation = operationOf(mode === 'task' ? { snapshot: { task: 'verify' } } : {});
      const result = { ...emptyRunResult(), manifestId: MANIFEST_ID };
      const written = { ...running, pauseRequestedAt: new Date() };
      operations.setBulkResult.mockResolvedValue(written);
      operations.settlePause.mockResolvedValue(false);
      operations.heartbeat.mockResolvedValue(state === 'resumed');
      operations.acknowledgeCancel.mockResolvedValue(state === 'cancelled');

      const answer =
        mode === 'run'
          ? await sut['proceed'](operation.id, 'claim-1', written, operation, result)
          : await sut['checkpointTask'](operation, 'claim-1', result, { processed: 1, total: 2, progress: 50 });

      expect(operations.heartbeat).toHaveBeenCalledWith(operation.id, 'claim-1', expect.any(Number), {
        requireActiveClaim: true,
      });
      if (state === 'resumed') {
        expect(answer).toBe(mode === 'run' ? true : 'continue');
        expect(operations.acknowledgeCancel).not.toHaveBeenCalled();
      } else {
        expect(answer).toBe(mode === 'run' ? false : state === 'cancelled' ? 'cancelled' : 'stopped');
        expect(operations.acknowledgeCancel).toHaveBeenCalledWith(operation.id, 'claim-1', { released: false });
      }
      if (mode === 'run' && state === 'cancelled') {
        expect(index.finishManifest).toHaveBeenCalledWith(MANIFEST_ID, { status: 'cancelled' });
        expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ lastRun: { status: 'cancelled' } });
      } else {
        expect(index.finishManifest).not.toHaveBeenCalled();
        expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      }
    });

    it.each(['run', 'task'].flatMap((mode) => [false, true].map((acknowledged) => ({ mode, acknowledged }))))(
      'only records cancellation after acknowledgement: $mode / $acknowledged',
      async ({ mode, acknowledged }) => {
        metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
        const operation = operationOf(mode === 'task' ? { snapshot: { task: 'verify' } } : {});
        const result = { ...emptyRunResult(), manifestId: MANIFEST_ID };
        const written = { ...running, cancelRequestedAt: new Date() };
        operations.setBulkResult.mockResolvedValue(written);
        operations.acknowledgeCancel.mockResolvedValue(acknowledged);

        const answer =
          mode === 'run'
            ? await sut['proceed'](operation.id, 'claim-1', written, operation, result)
            : await sut['checkpointTask'](operation, 'claim-1', result, { processed: 1, total: 2, progress: 50 });

        expect(answer).toBe(mode === 'run' ? false : acknowledged ? 'cancelled' : 'stopped');
        if (mode === 'run' && acknowledged) {
          expect(index.finishManifest).toHaveBeenCalledWith(MANIFEST_ID, { status: 'cancelled' });
          expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ lastRun: { status: 'cancelled' } });
        } else {
          expect(index.finishManifest).not.toHaveBeenCalled();
          expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
        }
      },
    );
  });

  describe('task checkpoint progress', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('only advancing persisted item counts extend the idle deadline', async () => {
      const operation = operationOf({ snapshot: { task: 'verify' } });
      const checkpoint = (processed: number) =>
        (
          sut as unknown as {
            checkpointTask: (
              operation: MediaOperation,
              token: string,
              result: object,
              units: { processed: number; total: number; progress: number },
            ) => Promise<string>;
          }
        ).checkpointTask(operation, 'claim-1', { checked: processed }, { processed, total: 10, progress: 10 });
      let advance!: (processed: number) => Promise<string>;
      const task = withOperationExecution(
        { renew: () => Promise.resolve(true), pollMs: 10, deadlineMs: 100, idleMs: 100 },
        async () => {
          const signal = executionSignal()!;
          const context = operationExecution.getStore()!;
          await new Promise<never>((_resolve, reject) => {
            advance = (processed) => operationExecution.run(context, () => checkpoint(processed));
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      );
      const rejection = expect(task).rejects.toBeInstanceOf(OperationDeadlineError);
      await vi.advanceTimersByTimeAsync(80);
      await advance(1);
      await vi.advanceTimersByTimeAsync(80);
      await advance(1);
      await vi.advanceTimersByTimeAsync(21);
      await rejection;
      expect(operations.setBulkResult).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('setup', () => {
    const setup = (overrides: Record<string, unknown> = {}) =>
      sut.setup(authStub.admin, {
        target: 'byo-s3',
        s3,
        keyMode: 'server',
        key: keyFileOf((overrides.keyMode as 'server' | 'own-stored' | 'own-memory' | undefined) ?? 'server'),
        ...overrides,
      } as never);

    it('does not install a memory key if a lock overtakes setup', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ keyMode: 'own-memory' });
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig('own-memory');
      const oldConfig = await savedConfig();
      const newConfig = structuredClone(oldConfig);
      newConfig.frameleafCloud.cloudBackup.enabled = false;
      let release!: () => void;
      const barrier = new Promise<void>((done) => (release = done));
      store.claim.mockReturnValueOnce(barrier.then(() => ({ existing: true, claimedAt: '2026-09-25T00:00:00.000Z' })));
      const pending = setup({ keyMode: 'own-memory', acknowledgement: 'I understand' });
      await vi.waitFor(() => expect(store.claim).toHaveBeenCalledOnce());
      sut.onConfigUpdate({ oldConfig, newConfig });
      const rejected = expect(pending).rejects.toThrow('changed or locked');
      release();
      await rejected;
      await expect(sut.getStatus()).resolves.toMatchObject({ keyLoaded: false });
    });

    it('claims the bucket with the generated key and keeps the key only in its 0600 key file (server mode)', async () => {
      mocks.crypto.randomBytes.mockReturnValue(key);
      const generated = sut.generateKey();
      expect(generated).toMatchObject({ key: key.toString('base64'), fingerprint });
      expect(generated.recoveryCode).toMatch(/^FLRK-/);
      keys.read.mockResolvedValue(keyFileOf());

      // the recovery key file built around the generated key, with its client roots
      const status = await setup({ key: keyFileOf() });

      expect(store.claim).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: s3.endpoint, bucket: s3.bucket, region: 'eu-central-2' }),
        key,
        expect.objectContaining({ instanceId: INSTANCE_ID, keyFingerprint: fingerprint }),
      );
      expect(keys.write).toHaveBeenCalledWith(
        identityDir,
        fingerprint,
        expect.stringContaining(key.toString('base64')),
      );
      expect(JSON.parse(keys.write.mock.calls[0][2] as string)).toMatchObject({ mode: 'server', fingerprint });
      // the key file is written and read back before the bucket is claimed with it
      expect(keys.write.mock.invocationCallOrder[0]).toBeLessThan(store.claim.mock.invocationCallOrder[0]);

      // the key is never configuration: only the secret access key is, as a write-only credential
      const persisted = configWrites().at(-1)!;
      const saved = await savedConfig();
      expect(saved).toMatchObject({
        frameleafCloud: {
          cloudBackup: { enabled: true, target: 'byo-s3', keyMode: 'server', s3: { secretAccessKey: 's3-secret' } },
        },
      });
      expect(JSON.stringify([persisted, saved])).not.toContain(key.toString('base64'));
      expect(JSON.stringify(metadata[SystemMetadataKey.FrameleafCloudBackup])).not.toContain(key.toString('base64'));
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        bucketRef: ref,
        instanceId: INSTANCE_ID,
        keyMode: 'server',
        keyFingerprint: fingerprint,
      });
      expect(mocks.event.emit).toHaveBeenCalledWith('ConfigUpdate', expect.anything());
      expect(JSON.stringify(status)).not.toContain(key.toString('base64'));
      expect(status).toMatchObject({ keyLoaded: true, keyFingerprint: fingerprint });
    });

    it('keeps a copy of your own key on this server in own-stored mode, never escrowed', async () => {
      await setup({ keyMode: 'own-stored' });

      expect(keys.write).toHaveBeenCalledOnce();
      expect(JSON.parse(keys.write.mock.calls[0][2] as string)).toMatchObject({ mode: 'own-stored' });
    });

    it('never saves the key in own-memory mode, and asks for the typed acknowledgement first', async () => {
      await expect(setup({ keyMode: 'own-memory' })).rejects.toBeInstanceOf(BadRequestException);
      expect(store.claim).not.toHaveBeenCalled();

      const status = await setup({ keyMode: 'own-memory', acknowledgement: ' I understand ' });

      expect(keys.write).not.toHaveBeenCalled();
      expect(mocks.websocket.serverSend).not.toHaveBeenCalledWith('CloudBackupKeyShare', expect.anything());
      expect(JSON.stringify(mocks.websocket.serverSend.mock.calls)).not.toContain(key.toString('base64'));
      expect(status.keyLoaded).toBe(true);
    });

    it('refuses Frameleaf-managed storage while this server is not linked to Frameleaf Cloud', async () => {
      const vaultId = 'f0000000-0000-4000-8000-000000000001';
      mocks.instanceIdentity.loadOrCreate.mockResolvedValue({ ...instance, instanceId: vaultId } as never);
      const file = addClientBackupKeys({ ...JSON.parse(keyFileOf()), instanceId: vaultId });
      await expect(setup({ target: 'managed', key: JSON.stringify(file) })).rejects.toThrow(
        'not linked to Frameleaf Cloud',
      );
      expect(store.claim).not.toHaveBeenCalled();
    });

    it('refuses a bucket the claim refuses, retaining the stored key without activating backup', async () => {
      store.claim.mockRejectedValue(
        new CloudBackupClaimError(
          'claimed-by-another-server',
          'This bucket already holds frameleaf-backup.json for another Frameleaf server.',
        ),
      );

      await expect(setup()).rejects.toThrow(ConflictException);
      expect(keys.write).toHaveBeenCalledOnce();
      expect(keys.remove).not.toHaveBeenCalled();
      expect(configWrites()).toHaveLength(0);
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toBeUndefined();
    });

    it.each(['server', 'own-stored'])(
      'retains the %s key when the provider accepts the claim but its response is lost',
      async (keyMode) => {
        let claimed = false;
        store.claim.mockImplementation(() => {
          claimed = true;
          return Promise.reject(new Error('claim response lost'));
        });

        await expect(setup({ keyMode })).rejects.toThrow();
        expect(claimed).toBe(true);
        expect(keys.write).toHaveBeenCalledOnce();
        expect(keys.remove).not.toHaveBeenCalled();
        expect(configWrites()).toHaveLength(0);
        expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toBeUndefined();
      },
    );

    it('keeps a key file that was already there when the claim fails', async () => {
      keys.write.mockResolvedValue({ path: '/identity/cloud-backup.key', created: false });
      store.claim.mockRejectedValue(
        new CloudBackupClaimError('not-empty', 'This bucket already contains other files.'),
      );

      await expect(setup()).rejects.toThrow(ConflictException);
      expect(keys.remove).not.toHaveBeenCalled();
    });

    it('never claims a bucket with a key it could not keep', async () => {
      keys.write.mockRejectedValue(new Error('EACCES: permission denied'));

      await expect(setup()).rejects.toThrow('could not be stored on this server');
      expect(store.claim).not.toHaveBeenCalled();
    });

    it('does not activate roots from a failed key-file write', async () => {
      const vaultId = 'f0000000-0000-4000-8000-000000000001';
      mocks.instanceIdentity.loadOrCreate.mockResolvedValue({ ...instance, instanceId: vaultId } as never);
      const file = JSON.stringify(addClientBackupKeys({ ...JSON.parse(keyFileOf()), instanceId: vaultId }));
      keys.write.mockRejectedValue(new Error('EACCES'));
      await expect(setup({ key: file })).rejects.toThrow('could not be stored');
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ keyMode: 'own-memory', instanceId: vaultId });
      await sut.unlock({ key: key.toString('base64') });
      const recipient = new CloudBackupKeyChannel('recipient', () => Promise.resolve(workerIdentity));
      try {
        const binding = metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup;
        await sut.onKeyRequest((await recipient.request(binding))!);
        const share = mocks.websocket.serverSend.mock.calls.findLast(([name]) => name === 'CloudBackupKeyShare')?.[1];
        expect(await recipient.accept(share, binding)).toBe(true);
        expect(recipient.getRecovery(binding)).toBeNull();
        expect(sut['clientKeys'].size).toBe(0);
      } finally {
        recipient.close();
      }
    });

    it('forgets what it knew of a bucket it claims afresh (emptied or recreated), and keeps it for its own claim', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();

      await setup();

      expect(index.deleteBucket).toHaveBeenCalledWith(ref);
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).not.toHaveProperty('reconciledAt');

      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      index.deleteBucket.mockClear();
      store.claim.mockResolvedValue({ existing: true, claimedAt: '2026-09-25T00:00:00.000Z' });
      await setup();

      expect(index.deleteBucket).not.toHaveBeenCalled();
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        reconciledAt: '2026-09-25T00:00:00.000Z',
      });
    });

    it('refuses an HTTP storage address and a key that is not 256 bits', async () => {
      // an HTTP storage address is what is being refused
      await expect(setup({ s3: { ...s3, endpoint: 'http://s3.example.test' } })).rejects.toThrow('HTTPS');
      await expect(setup({ key: 'not-a-key' })).rejects.toBeInstanceOf(BadRequestException);
      expect(store.claim).not.toHaveBeenCalled();
    });

    it('is refused while a run is active', async () => {
      operations.getActiveOfKind.mockResolvedValue({ id: 'run-1', fingerprint: null });

      await expect(setup()).rejects.toBeInstanceOf(ConflictException);
    });

    it('checks a bucket without claiming or saving anything', async () => {
      await expect(sut.check({ s3 })).resolves.toMatchObject({ ok: true, state: 'empty' });
      store.probe.mockResolvedValue({ state: 'not-empty' });
      await expect(sut.check({ s3 })).resolves.toMatchObject({ ok: false, state: 'not-empty' });
      store.probe.mockRejectedValue(new CloudBackupStoreError('refused', 403, 'AccessDenied'));
      await expect(sut.check({ s3 })).rejects.toThrow('refused these credentials');
      expect(store.claim).not.toHaveBeenCalled();
      expect(configWrites()).toHaveLength(0);
    });
  });

  describe('own-memory key', () => {
    it.each([
      ['endpoint', 'https://different-s3.test'],
      ['bucket', 'different-bucket'],
    ])('refuses stale safety proof after changed BYO %s with the same target', async (field, value) => {
      await sut.unlock({ key: key.toString('base64') });
      const settings = enabledConfig('own-memory');
      settings.frameleafCloud.cloudBackup.s3 = { ...s3, [field]: value };
      metadata[SystemMetadataKey.SystemConfig] = settings;
      await expect(sut.getSafetyAvailability()).resolves.toEqual({
        state: 'not-configured',
        bucket: null,
        readOnly: false,
        readOnlyReason: null,
      });
      expect(cloudBackup.grant).not.toHaveBeenCalled();
      expect(store.probe).not.toHaveBeenCalled();
    });

    it('reports unavailable safety states without issuing a remote storage grant', async () => {
      metadata[SystemMetadataKey.SystemConfig] = { frameleafCloud: { cloudBackup: { enabled: false, target: 'off' } } };
      await expect(sut.getSafetyAvailability()).resolves.toEqual({
        state: 'off',
        bucket: null,
        readOnly: false,
        readOnlyReason: null,
      });
      metadata[SystemMetadataKey.SystemConfig] = {
        frameleafCloud: { cloudBackup: { enabled: true, target: 'managed' } },
      };
      delete metadata[SystemMetadataKey.FrameleafCloudLink];
      await expect(sut.getSafetyAvailability()).resolves.toEqual({
        state: 'not-linked',
        bucket: null,
        readOnly: false,
        readOnlyReason: null,
      });
      expect(cloudBackup.grant).not.toHaveBeenCalled();
      expect(store.probe).not.toHaveBeenCalled();
    });

    it('reports an unloaded key and recognizes another worker loading it', async () => {
      await expect(sut.getSafetyAvailability()).resolves.toEqual({
        state: 'paused-key-unloaded',
        bucket: ref,
        readOnly: false,
        readOnlyReason: null,
      });
      const holder = new CloudBackupKeyChannel('holder', () => Promise.resolve(workerIdentity));
      holder.setKey(claim(), key);
      await sut.onKeyShare((await holder.share(keyRequest(), claim()))!);
      holder.close();
      await expect(sut.getSafetyAvailability()).resolves.toEqual({
        state: 'ready',
        bucket: ref,
        readOnly: false,
        readOnlyReason: null,
      });
      expect(cloudBackup.grant).not.toHaveBeenCalled();
    });

    beforeEach(() => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ keyMode: 'own-memory' });
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig('own-memory');
    });

    it('is not loaded after a restart, and backups wait until it is unlocked', async () => {
      await expect(sut.getStatus()).resolves.toMatchObject({ keyLoaded: false });
      await expect(sut.startRun(authStub.admin)).rejects.toBeInstanceOf(ConflictException);
      expect(operations.createExclusive).not.toHaveBeenCalled();

      await expect(sut.unlock({ key: Buffer.alloc(32, 9).toString('base64') })).rejects.toThrow('different bucket');
      const status = await sut.unlock({ key: key.toString('base64') });

      expect(status.keyLoaded).toBe(true);
      expect(mocks.websocket.serverSend).not.toHaveBeenCalledWith('CloudBackupKeyShare', expect.anything());
      await sut.startRun(authStub.admin);
      expect(operations.createExclusive).toHaveBeenCalledWith(
        expect.objectContaining({ kind: MediaOperationKind.CloudBackup }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );
    });

    it('rejects plaintext key events and answers only authenticated recipients for this bucket', async () => {
      await sut.onKeyShare({ key: key.toString('base64') } as never);
      await expect(sut.getStatus()).resolves.toMatchObject({ keyLoaded: false });
      await sut.unlock({ key: key.toString('base64') });
      const recipient = new CloudBackupKeyChannel('recipient', () => Promise.resolve(workerIdentity));
      try {
        const request = (await recipient.request(claim()))!;
        await sut.onKeyRequest({ ...request, workerId: 'forged' });
        expect(mocks.websocket.serverSend).not.toHaveBeenCalledWith('CloudBackupKeyShare', expect.anything());
        await sut.onKeyRequest(request);
        const share = mocks.websocket.serverSend.mock.calls.findLast(([name]) => name === 'CloudBackupKeyShare')?.[1];
        expect(await recipient.accept(share, claim())).toBe(true);
        const publications = mocks.websocket.serverSend.mock.calls.length;
        await sut.onKeyRequest(request);
        expect(mocks.websocket.serverSend.mock.calls).toHaveLength(publications);
        expect(
          JSON.stringify([
            mocks.websocket.serverSend.mock.calls,
            mocks.logger.log.mock.calls,
            mocks.logger.warn.mock.calls,
          ]),
        ).not.toContain(key.toString('base64'));
      } finally {
        recipient.close();
      }
    });

    it('retains the full client keyring when the same legacy bucket key is unlocked again', async () => {
      const vaultId = 'f0000000-0000-4000-8000-000000000001';
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ keyMode: 'own-memory', instanceId: vaultId });
      const file = addClientBackupKeys({ ...JSON.parse(keyFileOf('own-memory')), instanceId: vaultId });
      await sut.unlock({ key: JSON.stringify(file) });
      await sut.unlock({ key: key.toString('base64') });
      const recipient = new CloudBackupKeyChannel('recipient', () => Promise.resolve(workerIdentity));
      try {
        const binding = metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup;
        await sut.onKeyRequest((await recipient.request(binding))!);
        const share = mocks.websocket.serverSend.mock.calls.findLast(([name]) => name === 'CloudBackupKeyShare')?.[1];
        expect(await recipient.accept(share, binding)).toBe(true);
        expect(JSON.parse(recipient.getRecovery(binding)!.toString()).client).toEqual(file.client);
      } finally {
        recipient.close();
      }
      expect(keys.write).not.toHaveBeenCalled();
    });

    it('unlocks a restarted worker with rotated independent roots and pinned history without exposing them', async () => {
      const fixture = recoveryFixture();
      const file = {
        ...fixture.file,
        client: rotateClientBackupKeys(fixture.file.client, key),
        recovery: fixture.history,
      };
      const binding = claim({ keyMode: 'own-memory', instanceId: fixture.vaultId });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = binding;
      const status = await sut.unlock({ key: JSON.stringify(file) });
      const peer = build();
      peer.keyAskMs = 0;
      try {
        await peer.onBootstrapAskForKey();
        await sut.onKeyRequest(keyRequest());
        const share = mocks.websocket.serverSend.mock.calls.findLast(([name]) => name === 'CloudBackupKeyShare')?.[1];
        await peer.onKeyShare(share as never);
        expect(await peer.getStatus()).toMatchObject({ keyLoaded: true });
        expect(peer['clientKeys'].get(fingerprint)).toEqual(file.client);
        expect(peer['importedHistory'].get(fingerprint)?.anchor).toEqual(fixture.history.anchor);
        expect(keys.write).not.toHaveBeenCalled();
        const publicState = JSON.stringify([
          status,
          metadata,
          configWrites(),
          mocks.websocket.serverSend.mock.calls,
          mocks.logger.log.mock.calls,
          mocks.logger.warn.mock.calls,
          mocks.logger.error.mock.calls,
          mocks.systemMetadata.set.mock.calls,
        ]);
        for (const value of [key.toString('base64'), ...Object.values(file.client.keys)])
          expect(publicState).not.toContain(value);
      } finally {
        await peer.onShutdown();
      }
    });

    it('refreshes unlocked peers after root rotation even when a restarted worker first hears an older holder', async () => {
      const fixture = recoveryFixture();
      const directory = await mkdtemp(join(tmpdir(), 'worker-root-rotation-'));
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir: directory } }),
      );
      store.readMarker.mockResolvedValue({ instanceId: fixture.vaultId });
      const binding = claim({ keyMode: 'own-memory', instanceId: fixture.vaultId });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = binding;
      const oldFile = { ...fixture.file, recovery: fixture.history };
      const file = { ...oldFile, client: rotateClientBackupKeys(oldFile.client, key) };
      const peer = build();
      const stale = build();
      const restarted = build();
      try {
        await sut.unlock({ key: JSON.stringify(oldFile) });
        await peer.unlock({ key: JSON.stringify(oldFile) });
        await stale.unlock({ key: JSON.stringify(oldFile) });
        const active = (await peer['openBucket'](operationOf(), 'claim-1', () => Promise.resolve()))!;
        await sut.unlock({ key: JSON.stringify(file) });
        const update = mocks.websocket.serverSend.mock.calls.findLast(([name]) => name === 'CloudBackupKeyUpdate')?.[1];
        expect(update).toBeTruthy();
        await peer.onKeyUpdate(update as never);
        expect(await peer['loadKey'](binding, true)).toBeNull();
        const refresh = keyRequest();
        expect(refresh).toMatchObject({ version: 2, keyVersion: 2 });
        await stale.onKeyRequest(refresh);
        await peer.onKeyShare(
          mocks.websocket.serverSend.mock.calls.findLast(([name]) => name === 'CloudBackupKeyShare')?.[1] as never,
        );
        expect(peer['clientKeys'].get(fingerprint)?.current).toBe(1);
        await sut.onKeyRequest(refresh);
        await peer.onKeyShare(
          mocks.websocket.serverSend.mock.calls.findLast(([name]) => name === 'CloudBackupKeyShare')?.[1] as never,
        );
        expect(peer['clientKeys'].get(fingerprint)).toEqual(file.client);
        expect(active.clientKeys).toEqual(oldFile.client);
        expect(active.connection.recoveryKeys).toEqual(oldFile.client.keys);
        expect(active.bucketKey).toEqual(key);
        expect(
          peer['clientWriteVersion']({
            clientKeys: active.clientKeys,
            metadata: binding,
            progress: { result: {} },
          } as never),
        ).toBe(1);

        await restarted.onBootstrapAskForKey();
        const bootstrap = keyRequest();
        await stale.onKeyRequest(bootstrap);
        const oldReply = mocks.websocket.serverSend.mock.calls.findLast(
          ([name]) => name === 'CloudBackupKeyShare',
        )?.[1];
        await restarted.onKeyShare(oldReply as never);
        expect(restarted['clientKeys'].get(fingerprint)?.current).toBe(1);
        await sut.onKeyRequest(bootstrap);
        const newer = mocks.websocket.serverSend.mock.calls.findLast(([name]) => name === 'CloudBackupKeyUpdate')?.[1];
        await restarted.onKeyUpdate(newer as never);
        expect(await restarted['loadKey'](binding, true)).toBeNull();
        await restarted.onKeyShare(oldReply as never);
        await sut.onKeyRequest(keyRequest());
        await restarted.onKeyShare(
          mocks.websocket.serverSend.mock.calls.findLast(([name]) => name === 'CloudBackupKeyShare')?.[1] as never,
        );
        expect(restarted['clientKeys'].get(fingerprint)).toEqual(file.client);
        for (const worker of [peer, restarted]) {
          expect(
            worker['clientWriteVersion']({
              clientKeys: worker['clientKeys'].get(fingerprint),
              metadata: binding,
              progress: { result: {} },
            } as never),
          ).toBe(2);
          expect(
            worker['ownBucketConnection'](binding, (await savedConfig()).frameleafCloud.cloudBackup).recoveryKeys,
          ).toEqual(file.client.keys);
          expect(worker['importedHistory'].get(fingerprint)?.anchor).toEqual(fixture.history.anchor);
          const operationKey = await worker['loadKey'](binding, true);
          expect(operationKey).toEqual(key);
          const connection = worker['ownBucketConnection'](binding, (await savedConfig()).frameleafCloud.cloudBackup);
          for (const version of [1, 2]) {
            const plaintext = Buffer.from(`historical media version ${version}`);
            const root = Buffer.from(file.client.keys[version], 'base64');
            const object = clientBackupObjectKey(
              root,
              fixture.vaultId,
              version,
              createHash('sha256').update(plaintext).digest('hex'),
            );
            const context = clientBackupContext(connection.bucket, object)!;
            const ciphertext = Buffer.concat(
              await Array.fromAsync(encryptClientBackup(Readable.from([plaintext]), plaintext.length, root, context)),
            );
            const restored = Buffer.concat(
              await Array.fromAsync(
                decryptClientBackup(
                  Readable.from([ciphertext]),
                  Buffer.from(connection.recoveryKeys![version], 'base64'),
                  context,
                ),
              ),
            );
            expect(restored).toEqual(plaintext);
          }
        }
      } finally {
        await Promise.all([peer, stale, restarted].map((worker) => worker.onShutdown()));
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('ignores forged version hints and cannot reacquire keys from a hint after a lock', async () => {
      const fixture = recoveryFixture();
      const binding = claim({ keyMode: 'own-memory', instanceId: fixture.vaultId });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = binding;
      await sut.unlock({ key: JSON.stringify(fixture.file) });
      const holder = new CloudBackupKeyChannel('holder', () => Promise.resolve(workerIdentity));
      holder.setKey(binding, key);
      try {
        const update = (await holder.update(binding, 2))!;
        mocks.websocket.serverSend.mockClear();
        await sut.onKeyUpdate({ ...update, keyVersion: 3 });
        expect(mocks.websocket.serverSend).not.toHaveBeenCalled();
        let release!: () => void;
        vi.mocked(loadBackupWorkerIdentity).mockImplementationOnce(
          () =>
            new Promise((done) => {
              release = () => done(workerIdentity);
            }),
        );
        const accepting = sut.onKeyUpdate(update);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        sut['clearMemoryKey']();
        release();
        await accepting;
        await sut.onKeyUpdate((await holder.update(binding, 2))!);
        expect(mocks.websocket.serverSend).not.toHaveBeenCalled();
        expect(sut['keyChannel'].getKey(binding)).toBeNull();
        expect(sut['keyDiscovery'].size).toBe(0);
      } finally {
        holder.close();
      }
    });

    // a rootless replacement is refused at setup, so the replacement always carries its client roots
    it('accepts a replacement bucket on a remote peer after the old bucket rotated', async () => {
      const fixture = recoveryFixture();
      const binding = claim({ keyMode: 'own-memory', instanceId: fixture.vaultId });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = binding;
      mocks.instanceIdentity.loadOrCreate.mockResolvedValue({ ...instance, instanceId: fixture.vaultId } as never);
      store.readMarker.mockResolvedValue({ instanceId: fixture.vaultId });
      const peer = build();
      peer.keyAskMs = 0;
      try {
        await sut.unlock({ key: JSON.stringify(fixture.file) });
        await peer.unlock({ key: JSON.stringify(fixture.file) });
        await sut.unlock({
          key: JSON.stringify({ ...fixture.file, client: rotateClientBackupKeys(fixture.file.client, key) }),
        });
        await peer.onKeyUpdate(
          mocks.websocket.serverSend.mock.calls.findLast(([name]) => name === 'CloudBackupKeyUpdate')?.[1] as never,
        );
        await sut.onKeyRequest(keyRequest());
        const oldReply = mocks.websocket.serverSend.mock.calls.findLast(
          ([name]) => name === 'CloudBackupKeyShare',
        )?.[1];
        await peer.onKeyShare(oldReply as never);
        expect(peer['clientKeys'].get(fingerprint)?.current).toBe(2);

        await sut.unlock({
          key: JSON.stringify({
            ...fixture.file,
            client: rotateClientBackupKeys(sut['clientKeys'].get(fingerprint)!, key),
          }),
        });
        const oldUpdate = mocks.websocket.serverSend.mock.calls.findLast(
          ([name]) => name === 'CloudBackupKeyUpdate',
        )?.[1];
        let release!: () => void;
        vi.mocked(loadBackupWorkerIdentity).mockImplementationOnce(
          () =>
            new Promise((done) => {
              release = () => done(workerIdentity);
            }),
        );
        const delayed = peer.onKeyUpdate(oldUpdate as never);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));

        const newKey = Buffer.alloc(32, 11);
        const newFile = addClientBackupKeys({
          ...fixture.file,
          key: newKey.toString('base64'),
          fingerprint: keyFingerprint(newKey),
          bucket: 'new-family-backup',
        });
        await sut.setup(authStub.admin, {
          target: 'byo-s3',
          s3: { ...s3, bucket: newFile.bucket },
          keyMode: 'own-memory',
          key: JSON.stringify(newFile),
          acknowledgement: 'I understand',
        });
        const config = mocks.event.emit.mock.calls.findLast(([name]) => name === 'ConfigUpdate')?.[1];
        peer.onConfigUpdate(config as never);
        await peer.getStatus();
        const request = keyRequest();
        release();
        await delayed;
        expect(keyRequest()).toBe(request);
        expect(request).toMatchObject({
          version: 1,
          bucketRef: bucketRef(s3.endpoint, newFile.bucket),
          keyFingerprint: keyFingerprint(newKey),
        });
        expect(request.keyVersion).toBeUndefined();
        await peer.onKeyShare(oldReply as never);
        await sut.onKeyRequest(request);
        await peer.onKeyShare(
          mocks.websocket.serverSend.mock.calls.findLast(([name]) => name === 'CloudBackupKeyShare')?.[1] as never,
        );
        const current = metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup;
        const opened = (await peer['openBucket'](
          operationOf({
            snapshot: { version: 1, bucketRef: current.bucketRef, keyFingerprint: current.keyFingerprint },
          }),
          'claim-new',
          () => Promise.resolve(),
        ))!;
        expect(opened.bucketKey).toEqual(newKey);
        expect(opened.clientKeys).toEqual(newFile.client);
      } finally {
        await peer.onShutdown();
      }
    });

    it('does not activate CSE roots or history when a lock overtakes an asynchronous unlock', async () => {
      const fixture = recoveryFixture();
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ keyMode: 'own-memory', instanceId: fixture.vaultId });
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig('own-memory');
      const oldConfig = await savedConfig();
      const newConfig = structuredClone(oldConfig);
      newConfig.frameleafCloud.cloudBackup.enabled = false;
      let release!: () => void;
      vi.mocked(loadBackupWorkerIdentity).mockImplementationOnce(
        () =>
          new Promise((done) => {
            release = () => done(workerIdentity);
          }),
      );
      const pending = sut.unlock({ key: JSON.stringify({ ...fixture.file, recovery: fixture.history }) });
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      sut.onConfigUpdate({ oldConfig, newConfig });
      const rejected = expect(pending).rejects.toThrow('changed or locked');
      release();
      await rejected;
      expect(sut['clientKeys'].size).toBe(0);
      expect(sut['importedHistory'].size).toBe(0);
      expect(
        sut['keyChannel'].getRecovery(metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup),
      ).toBeNull();
    });

    it.each(['embedded-key', 'vault', 'legacy-root', 'history'])(
      'refuses an authenticated reply with invalid CSE %s before installing keys',
      async (invalid) => {
        const fixture = recoveryFixture();
        const binding = claim({ keyMode: 'own-memory', instanceId: fixture.vaultId });
        metadata[SystemMetadataKey.FrameleafCloudBackup] = binding;
        const file = { ...fixture.file, recovery: fixture.history };
        switch (invalid) {
          case 'embedded-key': {
            file.key = Buffer.alloc(32, 19).toString('base64');
            break;
          }
          case 'vault': {
            file.client.vaultId = 'f0000000-0000-4000-8000-000000000099';
            break;
          }
          case 'legacy-root': {
            file.client.keys[1] = key.toString('base64');
            break;
          }
          case 'history': {
            file.recovery.snapshots[0].signature = 'A'.repeat(86);
            break;
          }
        }
        const holder = new CloudBackupKeyChannel('holder', () => Promise.resolve(workerIdentity));
        holder.setKey(binding, key, holder.revision, Buffer.from(JSON.stringify(file)));
        try {
          await sut.onBootstrapAskForKey();
          await sut.onKeyShare((await holder.share(keyRequest(), binding))!);
          expect(sut['keyChannel'].getKey(binding)).toBeNull();
          expect(sut['keyChannel'].getRecovery(binding)).toBeNull();
          expect(sut['clientKeys'].size).toBe(0);
          expect(sut['importedHistory'].size).toBe(0);
        } finally {
          holder.close();
        }
      },
    );

    it('asks the other workers for the key when this worker restarted without it', async () => {
      sut.keyAskMs = 5000;
      const status = sut.getStatus();
      await vi.waitFor(() =>
        expect(mocks.websocket.serverSend).toHaveBeenCalledWith('CloudBackupKeyRequest', expect.anything()),
      );

      // another worker answers: the status is read with the key, without waiting out the timeout
      const holder = new CloudBackupKeyChannel('holder', () => Promise.resolve(workerIdentity));
      holder.setKey(claim(), key);
      await sut.onKeyShare((await holder.share(keyRequest(), claim()))!);
      holder.close();

      await expect(status).resolves.toMatchObject({ keyLoaded: true });
    });

    it('asks for the key when a worker starts', async () => {
      await sut.onBootstrapAskForKey();

      expect(mocks.websocket.serverSend).toHaveBeenCalledWith(
        'CloudBackupKeyRequest',
        expect.objectContaining({ version: 1, publicKey: expect.any(String), signature: expect.any(String) }),
      );
    });

    it('has nothing to unlock in the stored key modes', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ keyMode: 'server' });

      await expect(sut.unlock({ key: key.toString('base64') })).rejects.toThrow('nothing to unlock');
    });

    it('lets a run wait for the key without failing it', async () => {
      await sut.run(operationOf(), 'claim-1');

      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('CloudBackupKeyRequest', expect.anything());
      expect(operations.requeue).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ returnAttempt: true }),
      );
      expect(operations.fail).not.toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({ dedupeKey: 'cloud-backup:key-locked' }),
      );
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        lastRun: { status: 'waiting-for-key' },
      });
    });

    it('requires a usable private identity to unlock and reports a mount problem without logging material', async () => {
      vi.mocked(loadBackupWorkerIdentity).mockRejectedValue(new Error('identity unavailable'));
      await expect(sut.unlock({ key: key.toString('base64') })).rejects.toThrow('FRAMELEAF_IDENTITY_DIR');
      await expect(sut.getStatus()).resolves.toMatchObject({ keyLoaded: false });
      expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(key.toString('base64'));
    });

    it.each(['metadata', 'identity'])('does not reinstall a key when a lock overtakes the %s read', async (phase) => {
      const oldConfig = await savedConfig();
      const newConfig = structuredClone(oldConfig);
      newConfig.frameleafCloud.cloudBackup.enabled = false;
      let release!: () => void;
      let entered!: () => void;
      const barrier = new Promise<void>((done) => (release = done));
      const started = new Promise<void>((done) => (entered = done));
      if (phase === 'identity') {
        vi.mocked(loadBackupWorkerIdentity).mockImplementationOnce(async () => {
          entered();
          await barrier;
          return workerIdentity;
        });
      } else {
        mocks.systemMetadata.get.mockImplementationOnce(async () => {
          entered();
          await barrier;
          return claim({ keyMode: 'own-memory' }) as never;
        });
      }
      const pending = sut.unlock({ key: key.toString('base64') });
      await started;
      sut.onConfigUpdate({ oldConfig, newConfig });
      const rejected = expect(pending).rejects.toThrow('changed or locked');
      release();
      await rejected;
      await expect(sut.getStatus()).resolves.toMatchObject({ keyLoaded: false });
      metadata[SystemMetadataKey.SystemConfig] = newConfig;
      await expect(sut.unlock({ key: key.toString('base64') })).resolves.toMatchObject({ keyLoaded: true });
    });

    it.each(['own-memory', 'server'])('keeps a newer key when an older %s status read finishes', async (mode) => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ keyMode: mode });
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig(mode);
      keys.read.mockResolvedValue(keyFileOf());
      let release!: () => void;
      operations.getActiveOfKind.mockReturnValueOnce(new Promise<void>((done) => (release = done)));
      const previousStatus = sut.getStatus();
      expect(mocks.systemMetadata.get).toHaveBeenCalledWith(SystemMetadataKey.FrameleafCloudBackup);
      const next = Buffer.alloc(32, 17);
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        keyMode: 'own-memory',
        keyFingerprint: keyFingerprint(next),
      });
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig('own-memory');
      await expect(sut.unlock({ key: next.toString('base64') })).resolves.toMatchObject({ keyLoaded: true });
      release();
      await previousStatus;
      await expect(sut.getStatus()).resolves.toMatchObject({ keyLoaded: true });
    });

    it('clears own-memory keys on configuration lock, mode change and shutdown', async () => {
      await sut.unlock({ key: key.toString('base64') });
      const oldConfig = await savedConfig();
      const newConfig = structuredClone(oldConfig);
      newConfig.frameleafCloud.cloudBackup.enabled = false;
      sut.onConfigUpdate({ oldConfig, newConfig });
      await expect(sut.getStatus()).resolves.toMatchObject({ keyLoaded: false });
      await sut.unlock({ key: key.toString('base64') });
      const stored = structuredClone(newConfig);
      stored.frameleafCloud.cloudBackup.keyMode = 'server';
      sut.onConfigUpdate({ oldConfig: newConfig, newConfig: stored });
      await expect(sut.getStatus()).resolves.toMatchObject({ keyLoaded: false });
      await sut.unlock({ key: key.toString('base64') });
      await sut.onShutdown();
      await expect(sut.getStatus()).resolves.toMatchObject({ keyLoaded: false });
    });

    it('keeps an active operation key stable through a memory lock, then wipes its private copy', async () => {
      await sut.unlock({ key: keyFileOf('own-memory') });
      const oldConfig = await savedConfig();
      const newConfig = structuredClone(oldConfig);
      newConfig.frameleafCloud.cloudBackup.enabled = false;
      let operationKey: Buffer | undefined;
      store.readMarker.mockImplementation((_connection: unknown, bytes: Buffer) => {
        operationKey = bytes;
        sut.onConfigUpdate({ oldConfig, newConfig });
        expect(bytes).toEqual(key);
        return { instanceId: INSTANCE_ID };
      });
      await sut.run(operationOf(), 'claim-1');
      expect(operations.complete).toHaveBeenCalled();
      expect(operationKey).toEqual(Buffer.alloc(32));
      await expect(sut.getStatus()).resolves.toMatchObject({ keyLoaded: false });
    });
  });

  describe('run', () => {
    beforeEach(() => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
    });

    it.each(['server', 'own-memory'] as const)(
      'writes v3 references and durably anchors the exact encrypted manifest in %s mode',
      async (keyMode) => {
        const directory = await mkdtemp(join(tmpdir(), 'client-backup-run-'));
        const vaultId = 'f0000000-0000-4000-8000-000000000001';
        const file = addClientBackupKeys({ ...JSON.parse(keyFileOf()), instanceId: vaultId });
        const root = Buffer.from(file.client.keys[1], 'base64');
        const manifestId = 'f0000000-0000-4000-8000-000000000002';
        const pair = generateKeyPairSync('ed25519');
        const jwk = pair.publicKey.export({ format: 'jwk' });
        const publicJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: jwk.x! };
        mocks.instanceIdentity.loadOrCreate.mockResolvedValue({ ...instance, instanceId: vaultId } as never);
        mocks.instanceIdentity.currentSigner.mockReturnValue({
          kid: ed25519Thumbprint(publicJwk),
          publicJwk,
          sign: () => '',
          signBytes: (bytes: Buffer) => sign(null, bytes, pair.privateKey),
        });
        mocks.config.getEnv.mockReturnValue(
          mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir: directory } }),
        );
        metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ instanceId: vaultId, keyMode });
        metadata[SystemMetadataKey.SystemConfig] = enabledConfig(keyMode);
        store.readMarker.mockResolvedValue({
          format: 'frameleaf-backup',
          version: 1,
          instanceId: vaultId,
          keyFingerprint: fingerprint,
          claimedAt: '2026-09-25T00:00:00.000Z',
        });
        keys.read.mockResolvedValue(JSON.stringify(file));
        let operationRoot: Buffer | undefined;
        if (keyMode === 'own-memory') {
          keys.read.mockResolvedValue(null);
          await sut.unlock({ key: JSON.stringify(file) });
          const binding = metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup;
          const ownedKey = sut['keyChannel'].getKey(binding)!;
          const ownedRecovery = sut['keyChannel'].getRecovery(binding)!;
          const oldConfig = await savedConfig();
          const newConfig = structuredClone(oldConfig);
          newConfig.frameleafCloud.cloudBackup.enabled = false;
          store.uploadFile.mockImplementationOnce((_connection, _key, _path, bytes) => {
            operationRoot = [...sut['operationKeys']].find((value) => value.equals(root));
            sut.onConfigUpdate({ oldConfig, newConfig });
            expect(ownedKey).toEqual(Buffer.alloc(32));
            expect(ownedRecovery).toEqual(Buffer.alloc(ownedRecovery.length));
            expect(bytes).toEqual(key);
            expect(operationRoot).toEqual(root);
            return Promise.resolve({ etag: 'database', size: 50 });
          });
        }
        index.createManifest.mockImplementation(({ key }) => Promise.resolve({ id: manifestId, key }));
        index.listAssets.mockResolvedValueOnce([asset('asset-1', SHA_A)]).mockResolvedValueOnce([]);
        index.getEntriesPage.mockResolvedValue([entry('asset-1:original')]);
        store.hashObject = vi.fn().mockRejectedValue(new CloudBackupStoreError('missing', 404, 'NoSuchKey'));
        store.finishClientUpload = vi.fn().mockResolvedValue(undefined);
        store.uploadStream.mockImplementation(async (_connection, _key, source: AsyncIterable<Buffer>) => {
          const chunks: Buffer[] = [];
          for await (const chunk of source) chunks.push(Buffer.from(chunk));
          streamed.push(Buffer.concat(chunks));
          return {
            etag: 'encrypted',
            size: streamed.at(-1)!.length,
            versionId: 'provider-version-1',
            ciphertextSha256: 'a'.repeat(64),
          };
        });
        try {
          await sut.run(operationOf(), 'claim-1');
          expect(operations.fail).not.toHaveBeenCalled();
          expect(operations.complete).toHaveBeenCalled();
          if (keyMode === 'own-memory') {
            expect(operationRoot).toEqual(Buffer.alloc(32));
            expect(sut['clientKeys'].size).toBe(0);
            expect(sut['importedHistory'].size).toBe(0);
          }
          expect(manifestOf()).toMatchObject({
            version: 3,
            instanceId: vaultId,
            assets: {
              'asset-1': {
                files: [expect.objectContaining({ objectKey: clientBackupObjectKey(root, vaultId, 1, SHA_A) })],
              },
            },
          });
          const historyPath = join(directory, `cloud-backup-history-${hex(ref)}.json`);
          const history = (await readBackupHistory(historyPath))!;
          expect(selectBackupSnapshot(history).record.descriptor.manifest).toMatchObject({
            versionId: 'provider-version-1',
            ciphertextSha256: 'a'.repeat(64),
          });
          expect(await readFile(historyPath, 'utf8')).not.toContain(file.client.keys[1]);
          expect(store.finishClientUpload.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(
            index.finishManifest.mock.invocationCallOrder[0],
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );

    it('removes the partial downloads and transfer folders of operations that ended', async () => {
      const ended = '00000000-0000-4000-8000-0000000000e1';
      const running = '00000000-0000-4000-8000-0000000000e2';
      const partial = '/data/library/owner-1/2026/.frameleaf-part-abc';
      index.getEndedTransfers.mockResolvedValue([
        {
          id: ended,
          transfer: {
            kind: 'download',
            key: `o/${SHA_A}`,
            partial,
            expectedSha256: SHA_A,
            etag: '"e"',
            size: 100,
            offset: 10,
            completed: null,
          },
        },
      ]);
      mocks.storage.readdir.mockImplementation((folder) =>
        Promise.resolve(folder.endsWith('cloud-backup-transfers') ? [ended, running, 'notes'] : []),
      );
      index.getUnfinishedOperationIds.mockResolvedValue(new Set([running]));

      await sut.run(operationOf(), 'claim-1');

      expect(mocks.storage.unlink).toHaveBeenCalledWith(partial);
      expect(index.clearEndedTransfer).toHaveBeenCalledWith(ended);
      expect(mocks.storage.unlinkDir).toHaveBeenCalledOnce();
      expect(mocks.storage.unlinkDir).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`cloud-backup-transfers/${ended}$`)),
        {
          recursive: true,
          force: true,
        },
      );
    });

    it('keeps BYO multipart permission requirements and avoids Cloud capability calls', async () => {
      await sut.run(operationOf(), 'claim-1');
      expect(store.uploadFile).toHaveBeenCalled();
      expect(store.uploadFile.mock.calls.every(([connection]) => connection.transfer === undefined)).toBe(true);
      expect(cloudBackup.grant).not.toHaveBeenCalled();
      expect(cloudBackup.rotate).not.toHaveBeenCalled();
    });

    it('backs up the database first, then every unique file once, then the manifest', async () => {
      index.listAssets
        .mockResolvedValueOnce([
          asset('asset-1', SHA_A),
          // the same photo twice on this server: one object
          asset('asset-2', SHA_A),
          asset('asset-3', SHA_B, [{ type: 'sidecar', path: 'sidecar' }]),
        ])
        .mockResolvedValueOnce([]);
      index.getEntriesPage.mockResolvedValue([
        entry('asset-1:original'),
        entry('profile:owner-1', { assetId: null, role: 'profile', sha256: SHA_C }),
      ]);

      await sut.run(operationOf(), 'claim-1');

      expect(databaseBackup.createDatabaseBackup).toHaveBeenCalledWith('cloud-backup-', {
        signal: expect.any(AbortSignal),
        progress: expect.any(Function),
      });
      expect(uploadedKeys()).toEqual([clientDumpKey, objectKeyOf(SHA_A), objectKeyOf(SHA_B), objectKeyOf(SHA_SIDECAR)]);
      // the checksum on record was trusted for the originals; the sidecar was hashed now
      expect(mocks.crypto.hashFile).toHaveBeenCalledWith('sidecar', 'sha256');
      expect(mocks.crypto.hashFile).not.toHaveBeenCalledWith('/data/library/asset-1.jpg', 'sha256');
      expect(index.upsertEntries).toHaveBeenCalledWith(
        MANIFEST_ID,
        expect.arrayContaining([
          expect.objectContaining({ fileKey: 'asset-2:original', sha256: SHA_A }),
          expect.objectContaining({ fileKey: 'asset-3:sidecar:sidecar', role: 'sidecar', sha256: SHA_SIDECAR }),
        ]),
      );
      // only the run's own dump is removed from this server
      expect(mocks.storage.unlink).toHaveBeenCalledOnce();
      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        join(StorageCore.getBaseFolder(StorageFolder.Backups), dumpName),
      );

      const [, manifestKey, , bucketKey, contentType] = store.uploadStream.mock.calls[0];
      expect(manifestKey).toBe(MANIFEST_KEY);
      expect(bucketKey).toEqual(key);
      expect(contentType).toBe('application/gzip');
      expect(manifestOf()).toEqual({
        format: 'frameleaf-backup-manifest',
        version: 3,
        instanceId: INSTANCE_ID,
        createdAt: expect.any(String),
        database: { key: clientDumpKey, sha256: SHA_DUMP, size: 50 },
        assets: {
          'asset-1': {
            owner: 'owner-1',
            files: [
              {
                role: 'original',
                path: '/data/library/asset-1:original',
                sha256: SHA_A,
                objectKey: objectKeyOf(SHA_A),
                size: 100,
                mtime: '2026-09-01T00:00:00.000Z',
              },
            ],
          },
        },
        profiles: {
          'owner-1': {
            role: 'profile',
            path: '/data/library/profile:owner-1',
            sha256: SHA_C,
            objectKey: objectKeyOf(SHA_C),
            size: 100,
            mtime: '2026-09-01T00:00:00.000Z',
          },
        },
        albums: {},
        people: {},
      });
      expect(index.setManifestDatabase).toHaveBeenCalledWith(MANIFEST_ID, clientDumpKey);
      expect(index.finishManifest).toHaveBeenCalledWith(MANIFEST_ID, {
        status: 'complete',
        assetCount: 1,
        fileCount: 2,
        bytes: 200,
      });
      // the done checkpoint is saved before the recorded files go, so a retry never writes it again
      const done = orderOf(
        operations.setBulkResult,
        (call) => (call[2] as { result: { phase: string } }).result.phase === 'done',
      );
      expect(done).toBeLessThan(index.deleteEntries.mock.invocationCallOrder[0]);
      expect(index.deleteEntries).toHaveBeenCalledWith(MANIFEST_ID);
      expect(operations.complete).toHaveBeenCalled();
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        lastManifestKey: MANIFEST_KEY,
        lastRun: { status: 'completed', uploaded: 3, skipped: 1 },
      });
    });

    it('uploads no file on a second run when nothing changed', async () => {
      index.listAssets
        .mockResolvedValueOnce([asset('asset-1', SHA_A), asset('asset-2', SHA_B)])
        .mockResolvedValueOnce([]);
      // this server's own upload receipts, and the bucket still answers with the same objects
      index.getRecorded.mockResolvedValue(
        new Map([
          [SHA_A, { size: 100, etag: '"a"' }],
          [SHA_B, { size: 100, etag: '"b"' }],
        ]),
      );
      store.head.mockImplementation((_connection, objectKey: string) =>
        Promise.resolve(
          { [objectKeyOf(SHA_A)]: { size: 100, etag: 'a' }, [objectKeyOf(SHA_B)]: { size: 100, etag: 'b' } }[
            objectKey
          ] ?? null,
        ),
      );

      await sut.run(operationOf(), 'claim-1');

      expect(uploadedKeys().filter((name) => name.startsWith('o/'))).toEqual([]);
      expect(index.getRecorded).toHaveBeenCalledWith(expect.anything(), [SHA_A, SHA_B]);
      // an authenticated receipt needs no full read of the object
      expect(store.hashObject).not.toHaveBeenCalled();
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ lastRun: { uploaded: 0, skipped: 2 } });
    });

    it('hashes a file written since its checksum was taken and uploads it under its new hash', async () => {
      index.listAssets.mockResolvedValueOnce([asset('asset-1', SHA_A)]).mockResolvedValueOnce([]);
      mocks.storage.stat.mockResolvedValue({ size: 100, mtime: new Date('2026-09-20T00:00:00.000Z') } as never);
      mocks.crypto.hashFile.mockImplementation((path: string | Buffer) =>
        Promise.resolve(Buffer.from(String(path).includes('dump') ? SHA_DUMP : SHA_C, 'hex')),
      );

      await sut.run(operationOf(), 'claim-1');

      expect(uploadedKeys()).toContain(objectKeyOf(SHA_C));
      expect(uploadedKeys()).not.toContain(objectKeyOf(SHA_A));
    });

    it('uploads a file again once when it changed while uploading', async () => {
      index.listAssets.mockResolvedValueOnce([asset('asset-1', SHA_A)]).mockResolvedValueOnce([]);
      store.uploadFile
        .mockResolvedValueOnce({ etag: '"db"', size: 50 })
        .mockRejectedValueOnce(new CloudBackupFileChangedError('/data/library/asset-1.jpg'))
        .mockResolvedValueOnce({ etag: '"etag"', size: 100 });

      await sut.run(operationOf(), 'claim-1');

      expect(uploadedKeys().at(-1)).toBe(objectKeyOf(hex('/data/library/asset-1.jpg')));
      expect(operations.complete).toHaveBeenCalled();
    });

    it('counts a missing file and carries on', async () => {
      index.listAssets
        .mockResolvedValueOnce([asset('asset-1', SHA_A), asset('asset-2', SHA_B)])
        .mockResolvedValueOnce([]);
      mocks.storage.stat.mockImplementation((path) =>
        path === '/data/library/asset-1.jpg'
          ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
          : Promise.resolve({ size: 100, mtime: new Date('2026-09-01T00:00:00.000Z') } as never),
      );

      await sut.run(operationOf(), 'claim-1');

      expect(uploadedKeys()).toEqual([clientDumpKey, objectKeyOf(SHA_B)]);
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ lastRun: { missing: 1 } });
    });

    it('asks for thumbnails and transcoded videos only when they are included', async () => {
      await sut.run(operationOf(), 'claim-1');
      expect(index.listAssets).toHaveBeenCalledWith(
        expect.objectContaining({ includeThumbs: false, includeEncodedVideo: false }),
      );

      metadata[SystemMetadataKey.SystemConfig] = enabledConfig('server', { thumbs: true, encodedVideo: true });
      await sut.run(operationOf(), 'claim-2');
      expect(index.listAssets).toHaveBeenLastCalledWith(
        expect.objectContaining({ includeThumbs: true, includeEncodedVideo: true }),
      );
    });

    it('fills the index from the bucket listing on the first run in a bucket', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ reconciledAt: undefined });
      store.listAll = vi
        .fn()
        .mockImplementation((_connection, prefix: string, onPage: (objects: unknown[]) => Promise<void>) =>
          prefix === 'o/'
            ? onPage([
                { key: `o/${SHA_A}`, size: 100, etag: '"a"' },
                { key: 'o/not-a-hash', size: 1, etag: null },
              ]).then(() => 2)
            : Promise.resolve(0),
        );

      await sut.run(operationOf(), 'claim-1');

      expect(index.record).toHaveBeenCalledWith(ref, [{ sha256: SHA_A, size: 100, etag: '"a"' }]);
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toHaveProperty('reconciledAt');
    });

    it('resumes the same manifest after a restart, from its cursor, without dumping the database again', async () => {
      index.getManifest.mockResolvedValue({ id: MANIFEST_ID, key: MANIFEST_KEY, status: 'running' });
      const resumed = operationOf({
        result: {
          phase: 'assets',
          manifestId: MANIFEST_ID,
          manifestKey: MANIFEST_KEY,
          cursor: 'asset-25',
          database: { key: 'db/earlier.sql.gz', sha256: SHA_DUMP, size: 50 },
          uploaded: 25,
          skipped: 0,
          missing: 0,
          changed: 0,
          bytesUploaded: 2500,
          assets: 25,
          total: 30,
        },
      });

      await sut.run(resumed, 'claim-2');

      expect(databaseBackup.createDatabaseBackup).not.toHaveBeenCalled();
      expect(index.createManifest).not.toHaveBeenCalled();
      expect(index.listAssets).toHaveBeenCalledWith(expect.objectContaining({ afterId: 'asset-25' }));
      expect(store.uploadStream).toHaveBeenCalledWith(
        expect.anything(),
        MANIFEST_KEY,
        expect.anything(),
        key,
        'application/gzip',
      );
    });

    it('writes its cursor every 25 assets and stops there when paused', async () => {
      index.listAssets.mockResolvedValue(Array.from({ length: 25 }, (_, i) => asset(`asset-${i}`, SHA_A)));
      operations.setBulkResult.mockImplementation((_id, _token, { result }) =>
        Promise.resolve(result.cursor === 'asset-24' ? { ...running, pauseRequestedAt: new Date() } : running),
      );

      await sut.run(operationOf(), 'claim-1');

      expect(operations.setBulkResult).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ result: expect.objectContaining({ cursor: 'asset-24', assets: 25 }) }),
      );
      expect(operations.settlePause).toHaveBeenCalledWith('run-1', 'claim-1');
      expect(store.uploadStream).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('ends the manifest without writing it when cancelled', async () => {
      operations.setBulkResult.mockResolvedValue({ ...running, cancelRequestedAt: new Date() });

      await sut.run(operationOf(), 'claim-1');

      expect(operations.acknowledgeCancel).toHaveBeenCalledWith('run-1', 'claim-1', { released: false });
      expect(index.finishManifest).toHaveBeenCalledWith(MANIFEST_ID, { status: 'cancelled' });
      expect(index.deleteEntries).toHaveBeenCalledWith(MANIFEST_ID);
      expect(store.uploadStream).not.toHaveBeenCalled();
    });

    it('never writes a manifest again once it is complete, when a claim resumes after writing it', async () => {
      index.getManifest.mockResolvedValue({ id: MANIFEST_ID, key: MANIFEST_KEY, status: 'complete' });
      const resumed = operationOf({
        result: {
          phase: 'manifest',
          manifestId: MANIFEST_ID,
          manifestKey: MANIFEST_KEY,
          cursor: 'asset-9',
          database: { key: clientDumpKey, sha256: SHA_DUMP, size: 50 },
          uploaded: 3,
          skipped: 1,
          missing: 0,
          changed: 0,
          bytesUploaded: 350,
          assets: 10,
          total: 10,
        },
      });

      await sut.run(resumed, 'claim-2');

      expect(store.uploadStream).not.toHaveBeenCalled();
      expect(index.finishManifest).not.toHaveBeenCalled();
      expect(operations.setBulkResult).toHaveBeenCalledWith(
        'run-1',
        'claim-2',
        expect.objectContaining({ result: expect.objectContaining({ phase: 'done' }) }),
      );
      expect(index.deleteEntries).toHaveBeenCalledWith(MANIFEST_ID);
      expect(operations.complete).toHaveBeenCalled();
    });

    it('keeps a manifest complete when its run fails after writing it', async () => {
      index.getManifest
        .mockResolvedValueOnce({ id: MANIFEST_ID, status: 'running' })
        .mockResolvedValue({ id: MANIFEST_ID, status: 'complete' });
      operations.beginValidation.mockRejectedValue(new Error('database went away'));

      await sut.run(operationOf(), 'claim-1');

      expect(store.uploadStream).toHaveBeenCalledOnce();
      expect(operations.fail).toHaveBeenCalled();
      expect(index.finishManifest).not.toHaveBeenCalledWith(MANIFEST_ID, { status: 'failed' });
    });

    it('writes each item’s record and details, and the albums and people they name (manifest v2, written as v3)', async () => {
      index.getEntriesPage.mockResolvedValue([entry('asset-1:original'), entry('asset-2:original')]);
      const details = (albums: Array<{ id: string; name: string }>, personId: string | null) => ({
        isFavorite: true,
        visibility: 'timeline',
        rating: 5,
        description: 'Lake',
        dateTimeOriginal: '2026-08-14T09:12:00.000Z',
        timeZone: null,
        latitude: null,
        longitude: null,
        tags: ['Trips'],
        albums,
        faces: personId ? [{ personId, box: [1, 2, 3, 4], imageWidth: 10, imageHeight: 10, isHidden: false }] : [],
        stack: null,
        edits: [],
      });
      const record = {
        type: 'IMAGE',
        originalFileName: 'IMG_1.jpg',
        fileCreatedAt: '2026-08-14T07:12:00.000Z',
        fileModifiedAt: '2026-08-14T07:12:00.000Z',
        localDateTime: '2026-08-14T09:12:00.000Z',
        duration: null,
      };
      index.getAssetDetails.mockResolvedValue(
        new Map([
          ['asset-1', { record, details: details([{ id: 'album-1', name: 'Lake house' }], 'person-1') }],
          ['asset-2', { record, details: details([{ id: 'album-1', name: 'Lake house' }], null) }],
        ]),
      );
      const album = {
        name: 'Lake house',
        description: '',
        ownerId: 'owner-1',
        coverAssetId: 'asset-1',
        order: 'desc',
        sharedUsers: [],
      };
      const person = { ownerId: 'owner-1', name: 'Jamie', birthDate: null, isHidden: false, isFavorite: false };
      index.getAlbumRecords.mockResolvedValue(new Map([['album-1', album]]));
      index.getPersonRecords.mockResolvedValue(new Map([['person-1', person]]));

      await sut.run(operationOf(), 'claim-1');

      expect(index.getAssetDetails).toHaveBeenCalledWith(['asset-1', 'asset-2']);
      expect(index.getAlbumRecords).toHaveBeenCalledWith(['album-1']);
      expect(index.getPersonRecords).toHaveBeenCalledWith([{ ownerId: 'owner-1', personId: 'person-1' }]);
      const manifest = manifestOf();
      expect(manifest.version).toBe(3);
      expect(manifest.assets['asset-1']).toMatchObject({ ...record, details: { rating: 5, tags: ['Trips'] } });
      expect(manifest.albums).toEqual({ 'album-1': album });
      expect(manifest.people).toEqual({ 'person-1': person });
    });

    it('streams the manifest a page of recorded files at a time', async () => {
      const first = Array.from({ length: 1000 }, (_, i) =>
        entry(`asset-${String(i).padStart(4, '0')}:original`, { sha256: SHA_B }),
      );
      index.getEntriesPage.mockResolvedValueOnce(first).mockResolvedValueOnce([entry('asset-9999:original')]);

      await sut.run(operationOf(), 'claim-1');

      expect(index.getEntriesPage).toHaveBeenNthCalledWith(1, MANIFEST_ID, null, 1000);
      expect(index.getEntriesPage).toHaveBeenNthCalledWith(2, MANIFEST_ID, 'asset-0999:original', 1000);
      const manifest = manifestOf();
      expect(Object.keys(manifest.assets)).toHaveLength(1001);
      expect(index.finishManifest).toHaveBeenCalledWith(MANIFEST_ID, expect.objectContaining({ fileCount: 1001 }));
    });

    it('drops recorded objects the bucket no longer holds when it reads the listing', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ reconciledAt: undefined });
      index.pruneUnseen.mockResolvedValue(4);

      await sut.run(operationOf(), 'claim-1');

      expect(index.pruneUnseen).toHaveBeenCalledWith(ref, '2026-09-26T02:59:00.123456+00:00');
      expect(index.currentTime.mock.invocationCallOrder[0]).toBeLessThan(
        orderOf(store.listAll, ([, prefix]) => prefix === 'o/'),
      );
    });

    it('refuses a run whose bucket lost its claim (emptied or recreated), rather than trusting the index', async () => {
      store.readMarker.mockRejectedValue(
        new CloudBackupClaimError('claim-missing', 'This bucket no longer holds frameleaf-backup.json.'),
      );

      await sut.run(operationOf(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('no longer holds') }),
      );
      expect(databaseBackup.createDatabaseBackup).not.toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
    });

    it('refuses a run when another server claimed the bucket since', async () => {
      store.readMarker.mockResolvedValue({ instanceId: 'instance-2' });

      await sut.run(operationOf(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('another Frameleaf server') }),
      );
      expect(store.uploadFile).not.toHaveBeenCalled();
    });

    it('never removes a database dump: only the clean-up, which reads the kept manifests, does (FL-164)', async () => {
      const older = Array.from({ length: 9 }, (_, i) => `db/cloud-backup-immich-db-backup-2026090${i}.sql.gz`);
      store.listAll = vi
        .fn()
        .mockImplementation((_connection, prefix: string, onPage: (objects: unknown[]) => Promise<void>) =>
          prefix === 'db/'
            ? onPage([...older, dumpKey].map((name) => ({ key: name, size: 1, etag: null }))).then(
                () => older.length + 1,
              )
            : Promise.resolve(0),
        );

      await sut.run(operationOf(), 'claim-1');

      expect(operations.complete).toHaveBeenCalled();
      expect(store.delete).not.toHaveBeenCalled();
    });

    it('records backups found in the bucket that this server has no record of (FL-164)', async () => {
      const earlier = 'm/20260920T030000Z.json.gz';
      store.listAll = vi
        .fn()
        .mockImplementation((_connection, prefix: string, onPage: (objects: unknown[]) => Promise<void>) =>
          prefix === 'm/' ? onPage([{ key: earlier, size: 1, etag: null }]).then(() => 1) : Promise.resolve(0),
        );
      store.get = vi.fn().mockResolvedValue(
        gzipSync(
          JSON.stringify({
            format: 'frameleaf-backup-manifest',
            version: 1,
            instanceId: INSTANCE_ID,
            createdAt: '2026-09-20T03:00:00.000Z',
            database: { key: dumpKey, sha256: SHA_DUMP, size: 50 },
            assets: {
              'asset-1': {
                owner: 'owner-1',
                files: [{ role: 'original', path: '/data/a.jpg', sha256: SHA_A, size: 100, mtime: null }],
              },
            },
            profiles: {},
          }),
        ),
      );

      await sut.run(operationOf(), 'claim-1');

      expect(index.adoptManifests).toHaveBeenCalledWith(ref, [
        {
          key: earlier,
          createdAt: new Date('2026-09-20T03:00:00.000Z'),
          databaseKey: dumpKey,
          assetCount: 1,
          fileCount: 1,
          bytes: 100,
        },
      ]);
    });

    it('trusts a recorded checksum only when it was verified at the original path', async () => {
      index.listAssets
        .mockResolvedValueOnce([{ ...asset('asset-1', SHA_A), checksumPathVerified: false }])
        .mockResolvedValueOnce([]);

      await sut.run(operationOf(), 'claim-1');

      expect(mocks.crypto.hashFile).toHaveBeenCalledWith('/data/library/asset-1.jpg', 'sha256');
      expect(uploadedKeys()).toContain(objectKeyOf(hex('/data/library/asset-1.jpg')));
    });

    it('removes a dump an earlier run left behind before it makes a new one, and nothing else', async () => {
      mocks.storage.readdir.mockResolvedValue([
        'cloud-backup-frameleaf-db-backup-20260925T030000-v3.2.0-pg19beta4.sql.gz.tmp',
        'frameleaf-db-backup-20260925T020000-v3.2.0-pg19beta4.sql.gz',
        'cloud-backup-immich-db-backup-20260925T030000-v3.2.0-pg16.4.sql.gz.tmp',
      ]);

      await sut.run(operationOf(), 'claim-1');

      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        expect.stringContaining('cloud-backup-frameleaf-db-backup-20260925T030000-v3.2.0-pg19beta4.sql.gz.tmp'),
      );
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith(
        expect.stringContaining('/frameleaf-db-backup-20260925T020000'),
      );
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith(
        expect.stringContaining('cloud-backup-immich-db-backup-20260925T030000-v3.2.0-pg16.4.sql.gz.tmp'),
      );
      expect(mocks.storage.readdir.mock.invocationCallOrder[0]).toBeLessThan(
        databaseBackup.createDatabaseBackup.mock.invocationCallOrder[0],
      );
    });

    it('ends the manifests of runs the lease sweep failed before it looks for work, at most once a minute', async () => {
      index.endAbandonedManifests.mockResolvedValue(1);

      await sut.drain();
      await sut.drain();

      expect(index.endAbandonedManifests).toHaveBeenCalledOnce();
      expect(index.endAbandonedManifests.mock.invocationCallOrder[0]).toBeLessThan(
        operations.claimNext.mock.invocationCallOrder[0],
      );
      expect(operations.claimNext).toHaveBeenCalledTimes(2);
    });

    it('records a run cancelled after its manifest was written as complete', async () => {
      operations.beginValidation.mockResolvedValue(false);

      await sut.run(operationOf(), 'claim-1');

      expect(store.uploadStream).toHaveBeenCalledOnce();
      expect(operations.acknowledgeCancel).toHaveBeenCalledWith('run-1', 'claim-1', { released: false });
      expect(operations.complete).not.toHaveBeenCalled();
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        lastRun: { status: 'completed' },
        lastManifestKey: MANIFEST_KEY,
        lastSuccessAt: expect.any(String),
      });
    });

    it('notifies every administrator once when a run fails for good', async () => {
      store.uploadFile.mockRejectedValue(new CloudBackupStoreError('The storage provider refused PUT: 403', 403, null));

      await sut.run(operationOf(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_backup_failed' }),
      );
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({ title: 'Cloud backup failed', dedupeKey: 'cloud-backup:failed' }),
      );
      expect(index.finishManifest).toHaveBeenCalledWith(MANIFEST_ID, { status: 'failed' });
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ lastRun: { status: 'failed' } });
      // The checkpointed dump remains reachable for a retry; a fresh run can remove abandoned dumps.
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('tells the owner by push that cloud backup needs attention when a run fails for good (FL-228)', async () => {
      store.uploadFile.mockRejectedValue(new CloudBackupStoreError('The storage provider refused PUT: 403', 403, null));

      await sut.run(operationOf(), 'claim-1');

      expect(mocks.event.emit).toHaveBeenCalledWith(
        'PushNotify',
        expect.objectContaining({
          type: PushEventType.BackupNeedsAttention,
          admins: true,
          title: 'Cloud backup failed',
          // native apps: Retry starts a new run (`POST /admin/cloud/backup/runs`)
          data: { reason: 'cloud-backup:failed', job: 'run-1', jobType: 'cloud-backup-run', jobActions: 'retry' },
        }),
      );
    });

    it('keeps the manifest for the automatic retry and does not notify yet', async () => {
      store.uploadFile.mockRejectedValue(new CloudBackupStoreError('unreachable', null, null));
      operations.fail.mockResolvedValue('retrying');

      await sut.run(operationOf(), 'claim-1');

      expect(index.finishManifest).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AdminNotify', expect.anything());
    });

    it('refuses a run queued for a bucket that is no longer the claimed one', async () => {
      await sut.run(
        operationOf({ snapshot: { version: 1, bucketRef: 'https://elsewhere/bucket', keyFingerprint: fingerprint } }),
        'claim-1',
      );

      expect(operations.fail).toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
    });

    it('fails a stored-key run whose key file is missing, and never guesses a key', async () => {
      keys.read.mockResolvedValue(null);

      await sut.run(operationOf(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('key file is missing') }),
      );
      expect(store.uploadFile).not.toHaveBeenCalled();
    });

    it('fails a run whose key file has no client roots before it dumps or uploads anything', async () => {
      keys.read.mockResolvedValue(legacyKeyFileOf());

      await sut.run(operationOf(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: 'Load the complete backup recovery key file before starting a new backup.' }),
      );
      expect(index.createManifest).not.toHaveBeenCalled();
      expect(databaseBackup.createDatabaseBackup).not.toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
      expect(store.uploadStream).not.toHaveBeenCalled();
    });

    it('refuses to resume an unfinished backup that is not encrypted on this server', async () => {
      const legacy = 'm/20260926T030000Z.json.gz';
      index.getManifest.mockResolvedValue({ id: MANIFEST_ID, key: legacy, status: 'running' });

      await sut.run(
        operationOf({
          result: { ...emptyRunResult(), phase: 'assets', manifestId: MANIFEST_ID, manifestKey: legacy },
        }),
        'claim-2',
      );

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-2',
        expect.objectContaining({
          error: 'This unfinished backup is not encrypted on this server. Cancel it and start a new backup.',
        }),
      );
      expect(store.uploadFile).not.toHaveBeenCalled();
      expect(store.uploadStream).not.toHaveBeenCalled();
      expect(index.finishManifest).not.toHaveBeenCalledWith(MANIFEST_ID, { status: 'complete' });
    });
  });

  describe('runs', () => {
    beforeEach(() => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
    });

    it('pauses, resumes and cancels a run for any administrator', async () => {
      operations.getOfKind.mockResolvedValue(operationOf({ ownerId: 'other-admin' }));

      await sut.pauseRun('run-1');
      await sut.resumeRun('run-1');
      await sut.cancelRun('run-1');

      expect(operations.requestPause).toHaveBeenCalledWith('run-1', 'other-admin', [
        MediaOperationKind.CloudBackup,
        MediaOperationKind.CloudRestore,
      ]);
      expect(operations.resume).toHaveBeenCalledWith('run-1', 'other-admin');
      expect(operations.requestCancel).toHaveBeenCalledWith('run-1', 'other-admin');
    });

    it('turns cloud backup off and keeps the claim and the key', async () => {
      await sut.turnOff(authStub.admin);

      expect(await savedConfig()).toMatchObject({
        frameleafCloud: { cloudBackup: { enabled: false } },
      });
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ bucketRef: ref });
      // FL-146 (FL-66): listed in the settings history as a Frameleaf Cloud change by this administrator
      expect((metadata[SystemMetadataKey.SystemConfigHistory] as ConfigHistory).entries[0]).toMatchObject({
        source: 'frameleaf-cloud',
        actorId: authStub.admin.user.id,
        changes: expect.arrayContaining([expect.objectContaining({ path: 'frameleafCloud.cloudBackup.enabled' })]),
      });
    });
  });

  describe('onConfigValidate', () => {
    it('needs a storage address and a bucket for your own bucket, over HTTPS', () => {
      const config = (s3Settings: Record<string, string>) =>
        ({
          frameleafCloud: { cloudBackup: { enabled: true, target: 'byo-s3', s3: { ...s3, ...s3Settings } } },
        }) as never;

      expect(() => sut.onConfigValidate({ newConfig: config({ bucket: '' }), oldConfig: config({}) })).toThrow(
        'storage address and a bucket name',
      );
      expect(() =>
        // an HTTP storage address is what is being refused
        sut.onConfigValidate({ newConfig: config({ endpoint: 'http://s3.example.test' }), oldConfig: config({}) }),
      ).toThrow('HTTPS');
      expect(() => sut.onConfigValidate({ newConfig: config({}), oldConfig: config({}) })).not.toThrow();
    });
  });
  describe('schedule (FL-164)', () => {
    const scheduled = (cronExpression = '0 4 * * *') =>
      ({
        frameleafCloud: {
          cloudBackup: { enabled: true, target: 'byo-s3', schedule: { cronExpression }, verifyWeekly: true },
        },
      }) as never;

    beforeEach(() => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      mocks.user.getAdmin.mockResolvedValue({ id: 'admin-1' } as never);
    });

    it('runs the schedule on the one server that holds its lock', async () => {
      mocks.cron.create.mockReturnValue();
      mocks.cron.update.mockReturnValue();
      mocks.database.tryLock.mockResolvedValue(false);
      await sut.onConfigInit({ newConfig: scheduled() });
      expect(mocks.cron.create).not.toHaveBeenCalled();

      mocks.database.tryLock.mockResolvedValue(true);
      await sut.onConfigInit({ newConfig: scheduled() });
      expect(mocks.database.tryLock).toHaveBeenCalledWith(DatabaseLock.FrameleafCloudBackupCheck);
      // FL-362: the run itself is started by the one backup schedule, so only the check has a timer here.
      expect(mocks.cron.create).toHaveBeenCalledTimes(1);
      expect(mocks.cron.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: CLOUD_BACKUP_VERIFY_CRON, start: true }),
      );

      sut.onConfigUpdate({ newConfig: scheduled('0 */6 * * *'), oldConfig: scheduled() });
      expect(mocks.cron.update).toHaveBeenCalledTimes(1);
      expect(mocks.cron.update).toHaveBeenCalledWith(expect.objectContaining({ name: CLOUD_BACKUP_VERIFY_CRON }));
    });

    it('queues one scheduled run under the lock, owned by the first administrator', async () => {
      await expect(sut.handleSchedule()).resolves.toBe(JobStatus.Success);

      expect(operations.createExclusive).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'admin-1',
          kind: MediaOperationKind.CloudBackup,
          snapshot: expect.objectContaining({ task: 'backup', scheduled: true }),
        }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );
    });

    it('never duplicates a run already queued or in progress', async () => {
      operations.createExclusive.mockResolvedValue({ active: { id: 'run-1', ownerId: 'admin-1', fingerprint: null } });
      operations.getOfKind.mockResolvedValue(operationOf());

      await expect(sut.handleSchedule()).resolves.toBe(JobStatus.Skipped);
      expect(operations.createExclusive).toHaveBeenCalledTimes(1);
    });

    it('does nothing while cloud backup is off', async () => {
      metadata[SystemMetadataKey.SystemConfig] = { frameleafCloud: { cloudBackup: { enabled: false } } };

      await expect(sut.handleSchedule()).resolves.toBe(JobStatus.Skipped);
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('follows a scheduled run with the clean-up of runs past retention', async () => {
      keys.read.mockResolvedValue(keyFileOf());

      const snapshot = { version: 1, bucketRef: ref, keyFingerprint: fingerprint, scheduled: true };
      await sut.run(operationOf({ snapshot }), 'claim-1');

      expect(operations.complete).toHaveBeenCalled();
      expect(operations.createExclusive).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: expect.objectContaining({ task: 'prune', dryRun: false, scheduled: true }),
        }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );
    });

    /** A schedule far from the fixed "now" below, so the quiet hour before a backup never interferes. */
    const farSchedule = () => ({
      frameleafCloud: {
        cloudBackup: { ...enabledConfig().frameleafCloud.cloudBackup, schedule: { cronExpression: '0 0 1 1 *' } },
      },
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('queues the monthly full check first, then a weekly sample, and nothing in between', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-15T12:00:00.000Z') });
      metadata[SystemMetadataKey.SystemConfig] = farSchedule();
      await expect(sut.handleVerifyCheck()).resolves.toBe(JobStatus.Success);
      expect(operations.createExclusive).toHaveBeenLastCalledWith(
        expect.objectContaining({ snapshot: expect.objectContaining({ task: 'verify', depth: 'full' }) }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );

      const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const lastWeek = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastFullVerifyAt: recent,
        lastVerify: { at: lastWeek },
      });
      await expect(sut.handleVerifyCheck()).resolves.toBe(JobStatus.Success);
      expect(operations.createExclusive).toHaveBeenLastCalledWith(
        expect.objectContaining({ snapshot: expect.objectContaining({ task: 'verify', depth: 'sample' }) }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );

      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastFullVerifyAt: recent,
        lastVerify: { at: recent },
      });
      await expect(sut.handleVerifyCheck()).resolves.toBe(JobStatus.Skipped);
      expect(operations.createExclusive).toHaveBeenCalledTimes(2);
    });

    it('waits a day after a failed check, and starts none in the hour before the scheduled backup', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-15T12:00:00.000Z') });
      metadata[SystemMetadataKey.SystemConfig] = farSchedule();
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastVerify: { at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), status: 'failed' },
      });
      await expect(sut.handleVerifyCheck()).resolves.toBe(JobStatus.Skipped);

      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = {
        frameleafCloud: {
          cloudBackup: { ...enabledConfig().frameleafCloud.cloudBackup, schedule: { cronExpression: '*/30 * * * *' } },
        },
      };
      await expect(sut.handleVerifyCheck()).resolves.toBe(JobStatus.Skipped);
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('starts a scheduled run that found a check holding the bucket once the check has ended', async () => {
      const snapshot = { version: 1, bucketRef: ref, keyFingerprint: fingerprint, task: 'verify' };
      const check = () => operationOf({ id: 'check-1', snapshot });
      operations.createExclusive.mockResolvedValueOnce({
        active: { id: 'check-1', ownerId: 'admin-1', fingerprint: null },
      });
      operations.getOfKind.mockResolvedValueOnce(check());

      await expect(sut.handleSchedule()).resolves.toBe(JobStatus.Success);
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ scheduledRunDueAt: expect.any(String) });

      // the check ends (here, it cannot open the bucket and fails); the run it held up is queued then
      await sut.run(check(), 'claim-1');

      expect(operations.createExclusive).toHaveBeenLastCalledWith(
        expect.objectContaining({ snapshot: expect.objectContaining({ task: 'backup', scheduled: true }) }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).not.toHaveProperty('scheduledRunDueAt');
    });
  });

  describe('clean-up (FL-164)', () => {
    beforeEach(() => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
    });

    it('asked for by hand, needs a dry run first', async () => {
      await expect(sut.startPrune(authStub.admin, { dryRun: false })).rejects.toThrow('Preview the clean-up first');

      await sut.startPrune(authStub.admin, { dryRun: true });
      expect(operations.createExclusive).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'Cloud backup clean-up preview',
          snapshot: expect.objectContaining({ dryRun: true }),
        }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );

      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastPrune: { dryRun: true, at: new Date().toISOString() },
      });
      await sut.startPrune(authStub.admin, { dryRun: false });
      expect(operations.createExclusive).toHaveBeenLastCalledWith(
        expect.objectContaining({
          label: 'Cloud backup clean-up',
          snapshot: expect.objectContaining({ dryRun: false }),
        }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );
    });

    it('needs a new dry run once a backup has run since the last one', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastPrune: { dryRun: true, at: new Date(Date.now() - 60_000).toISOString() },
        lastSuccessAt: new Date().toISOString(),
      });

      await expect(sut.startPrune(authStub.admin, { dryRun: false })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('Frameleaf-managed storage (FL-164)', () => {
    const grant = managedGrantFixture('backup/grant-response.json');
    const rotated = managedGrantFixture('backup/grant-rotate-response.json');
    const managedRef = managedStorageRef(grant.storageId);
    const cloudUrl = 'https://cloud.frameleaf.test';
    const managedClaim = (overrides: Record<string, unknown> = {}) =>
      claim({
        target: 'managed',
        bucketRef: managedRef,
        endpoint: grant.endpoint,
        region: grant.region,
        bucket: grant.bucket,
        managed: {
          storageId: grant.storageId,
          location: grant.location,
          readOnly: false,
          readOnlyReason: null,
          quotaBytes: grant.quotaBytes,
          checkedAt: '2026-09-25T00:00:00.000Z',
        },
        ...overrides,
      });
    const managedOperation = () =>
      operationOf({ snapshot: { version: 1, bucketRef: managedRef, keyFingerprint: fingerprint } });

    beforeEach(() => {
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir, url: cloudUrl } }),
      );
      metadata[SystemMetadataKey.FrameleafCloudLink] = { status: 'linked', cloudUrl, instanceId: INSTANCE_ID };
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim();
      metadata[SystemMetadataKey.SystemConfig] = {
        frameleafCloud: { cloudBackup: { enabled: true, target: 'managed', keyMode: 'server' } },
      };
      keys.read.mockResolvedValue(keyFileOf());
      mocks.frameleafCloud.discovery.mockResolvedValue({ api: 'https://api.frameleaf.test' } as never);
      mocks.frameleafCloud.accessToken.mockResolvedValue({ accessToken: 'token' } as never);
      cloudBackup.rotate.mockResolvedValue(rotated);
      vi.mocked(selectBackupLocation).mockResolvedValue({ ...grant.location, probeUrl: grant.endpoint });
    });

    it('exports through renewable restore-only managed credentials, including read-only storage', async () => {
      const read = {
        ...rotated,
        readOnly: true,
        readOnlyReason: 'plan_full',
        capability: { ...rotated.capability, operation: 'restore' },
      };
      cloudBackup.rotate.mockResolvedValue(read);
      store.readMarker.mockRejectedValue(new Error('managed export reader reached'));
      const file = JSON.stringify({ ...JSON.parse(keyFileOf()), bucket: grant.bucket });
      await expect(
        sut.exportFromBucket({ managed: true, key: file, scope: 'library', restoreDatabase: false }, '/unused'),
      ).rejects.toThrow('managed export reader reached');

      const connection = store.readMarker.mock.calls[0][0];
      expect(connection.sessionToken).toBe(read.capability.credentials.sessionToken);
      expect(await connection.managedCredentials()).toEqual(read.capability.credentials);
      const renewed = {
        ...read,
        capability: { ...read.capability, credentials: { ...read.capability.credentials, accessKeyId: 'renewed' } },
      };
      cloudBackup.rotate.mockResolvedValueOnce(renewed);
      expect(await connection.managedCredentials(read.capability.credentials.accessKeyId)).toEqual(
        renewed.capability.credentials,
      );
      expect(cloudBackup.rotate).toHaveBeenNthCalledWith(1, expect.anything(), 'restore');
      expect(cloudBackup.rotate).toHaveBeenNthCalledWith(2, expect.anything(), 'restore');
      cloudBackup.rotate.mockResolvedValueOnce({ ...renewed, bucket: 'changed' });
      await expect(connection.managedCredentials('renewed')).rejects.toThrow('changed');
    });

    it.each([
      { instanceId: 'another-vault' },
      { bucket: 'another-bucket' },
      { key: Buffer.alloc(32, 9).toString('base64'), fingerprint: keyFingerprint(Buffer.alloc(32, 9)) },
    ])(
      'refuses a managed export with a different recovery binding before requesting credentials: %j',
      async (change) => {
        // the binding fields alone: a client ring would be refused for its own vault first
        const file = JSON.stringify({ ...JSON.parse(legacyKeyFileOf()), bucket: grant.bucket, ...change });
        await expect(
          sut.exportFromBucket({ managed: true, key: file, scope: 'library', restoreDatabase: false }, '/unused'),
        ).rejects.toThrow('recovery file does not match');
        expect(cloudBackup.rotate).not.toHaveBeenCalled();
        expect(store.readMarker).not.toHaveBeenCalled();
      },
    );

    it('never falls back to own storage when managed export authorization fails', async () => {
      const own = vi.spyOn(sut as never, 'connectionFor');
      cloudBackup.rotate.mockRejectedValue(new Error('authorization refused'));
      const file = JSON.stringify({ ...JSON.parse(keyFileOf()), bucket: grant.bucket });
      await expect(
        sut.exportFromBucket({ managed: true, key: file, scope: 'library', restoreDatabase: false }, '/unused'),
      ).rejects.toThrow('authorization refused');
      expect(own).not.toHaveBeenCalled();
      expect(store.readMarker).not.toHaveBeenCalled();
    });

    it('refuses managed mode for database restoration and for a server with own storage', async () => {
      const options = { managed: true as const, key: keyFileOf(), scope: 'library' as const, restoreDatabase: true };
      await expect(sut.restoreFromBucket(options, vi.fn())).rejects.toThrow('only exports');
      await expect(sut.exportFromBucket(options, '/unused')).rejects.toThrow('only exports');
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      await expect(sut.exportFromBucket({ ...options, restoreDatabase: false }, '/unused')).rejects.toThrow(
        'no managed backup',
      );
      expect(cloudBackup.rotate).not.toHaveBeenCalled();
    });

    it('refuses default managed writes without the client format contract before writing any objects', async () => {
      const vaultId = 'f0000000-0000-4000-8000-000000000001';
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({ instanceId: vaultId });
      keys.read.mockResolvedValue(
        JSON.stringify(addClientBackupKeys({ ...JSON.parse(keyFileOf()), instanceId: vaultId })),
      );
      store.readMarker.mockResolvedValue({ instanceId: vaultId });
      cloudBackup.rotate.mockResolvedValue({ ...rotated, objectFormats: { ...rotated.objectFormats, write: [] } });

      await sut.run(managedOperation(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('qualified opaque-storage grant') }),
      );
      expect(index.createManifest).not.toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
      expect(store.uploadStream).not.toHaveBeenCalled();
    });

    it.each([
      ['a backup that has none yet', undefined],
      ['a previously encrypted backup', 'm/v1/f0000000-0000-4000-8000-000000000001/1/20261011T000000Z.json.gz'],
    ])('never writes anything for %s once its key file has lost its client roots', async (_, lastManifestKey) => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({ lastManifestKey });
      keys.read.mockResolvedValue(legacyKeyFileOf());
      await sut.run(managedOperation(), 'claim-1');
      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({
          error: expect.stringContaining('Load the complete backup recovery key file before starting a new backup.'),
        }),
      );
      expect(index.createManifest).not.toHaveBeenCalled();
      expect(databaseBackup.createDatabaseBackup).not.toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
      expect(store.uploadStream).not.toHaveBeenCalled();
    });

    it.each(['managed', 'byo-s3'] as const)(
      'refuses %s setup with a key file that has no client roots before requesting or claiming storage',
      async (target) => {
        metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
        for (const rootless of [key.toString('base64'), legacyKeyFileOf()]) {
          await expect(
            sut.setup(authStub.admin, {
              target,
              ...(target === 'byo-s3' && { s3 }),
              keyMode: 'server',
              key: rootless,
            } as never),
          ).rejects.toThrow(new BadRequestException('Use a complete backup recovery key file.'));
        }
        expect(cloudBackup.metadata).not.toHaveBeenCalled();
        expect(cloudBackup.grant).not.toHaveBeenCalled();
        expect(store.probe).not.toHaveBeenCalled();
        expect(store.claim).not.toHaveBeenCalled();
        expect(keys.write).not.toHaveBeenCalled();
        expect(configWrites()).toHaveLength(0);
      },
    );

    it('does not replace an existing encrypted keyring with its legacy key during setup', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim();
      await expect(
        sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: key.toString('base64') }),
      ).rejects.toThrow('Use a complete backup recovery key file.');
      expect(cloudBackup.grant).not.toHaveBeenCalled();
      expect(keys.write).not.toHaveBeenCalled();
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toEqual(managedClaim());
    });

    it('refuses a rootless reconfiguration even for its unchanged storage binding (no legacy writes remain)', async () => {
      cloudBackup.metadata.mockResolvedValue(grant);
      cloudBackup.grant.mockResolvedValue(rotated);
      store.claim.mockResolvedValue({ existing: true, claimedAt: '2026-09-25T00:00:00.000Z' });
      await expect(
        sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: legacyKeyFileOf() }),
      ).rejects.toThrow('Use a complete backup recovery key file.');
      expect(cloudBackup.grant).not.toHaveBeenCalled();
      expect(store.claim).not.toHaveBeenCalled();
      // the complete key file reconfigures the same binding
      await expect(
        sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: keyFileOf() }),
      ).resolves.toBeDefined();
      expect(store.claim).toHaveBeenCalledOnce();
    });

    it('rotates the key at the start of every run and never keeps it', async () => {
      await sut.run(managedOperation(), 'claim-1');

      expect(cloudBackup.rotate).toHaveBeenCalledTimes(1);
      expect(store.readMarker).toHaveBeenCalledWith(
        expect.objectContaining({ bucket: grant.bucket, accessKeyId: rotated.capability.credentials.accessKeyId }),
        key,
      );
      expect(operations.complete).toHaveBeenCalled();
      const secret = rotated.capability.credentials.secretAccessKey;
      expect(JSON.stringify(metadata)).not.toContain(secret);
      expect(JSON.stringify(configWrites())).not.toContain(secret);
      expect(JSON.stringify(mocks.logger.log.mock.calls)).not.toContain(secret);
    });

    describe('licence coverage (FL-362)', () => {
      const ownerTwo = 'owner-2';
      const withOwner = (id: string, sha: string, ownerId: string) => ({ ...asset(id, sha), ownerId });
      const uploadedObjects = () => uploadedKeys().filter((objectKey) => objectKey.startsWith('o/'));
      const recordedOwners = () =>
        index.upsertEntries.mock.calls.flatMap(([, entries]) =>
          (entries as CloudBackupEntry[]).map(({ ownerId, role }) => `${role}:${ownerId}`),
        );

      beforeEach(() => {
        mocks.user.getList.mockResolvedValue([{ id: 'owner-1' }, { id: ownerTwo }] as never);
        index.listAssets
          .mockResolvedValueOnce([withOwner('asset-1', SHA_A, 'owner-1'), withOwner('asset-2', SHA_B, ownerTwo)])
          .mockResolvedValueOnce([]);
        index.listProfileImages.mockResolvedValue([
          { userId: 'owner-1', path: '/data/profile/owner-1.jpg' },
          { userId: ownerTwo, path: '/data/profile/owner-2.jpg' },
        ]);
      });

      it('uploads only the accounts an Individual licence covers', async () => {
        cloudBackup.rotate.mockResolvedValue({
          ...rotated,
          coverage: { scope: 'users', userFingerprints: [backupUserFingerprint(INSTANCE_ID, 'owner-1')] },
        });

        await sut.run(managedOperation(), 'claim-1');

        expect(operations.complete).toHaveBeenCalled();
        expect(uploadedObjects()).toContain(objectKeyOf(SHA_A));
        expect(uploadedObjects()).not.toContain(objectKeyOf(SHA_B));
        expect(recordedOwners()).toEqual(expect.arrayContaining(['original:owner-1', 'profile:owner-1']));
        expect(recordedOwners()).not.toContain(`original:${ownerTwo}`);
        expect(recordedOwners()).not.toContain(`profile:${ownerTwo}`);
        // the database copy is the whole library, whoever the licence covers
        expect(uploadedKeys()).toContain(clientDumpKey);
      });

      it('uploads no account when the licence covers nobody, and still copies the database', async () => {
        cloudBackup.rotate.mockResolvedValue({ ...rotated, coverage: { scope: 'none' } });

        await sut.run(managedOperation(), 'claim-1');

        expect(uploadedObjects()).toEqual([]);
        expect(recordedOwners()).toEqual([]);
        expect(uploadedKeys()).toContain(clientDumpKey);
      });

      it('uploads every account under a Server licence', async () => {
        cloudBackup.rotate.mockResolvedValue({ ...rotated, coverage: { scope: 'all' } });

        await sut.run(managedOperation(), 'claim-1');

        expect(uploadedObjects()).toEqual(expect.arrayContaining([objectKeyOf(SHA_A), objectKeyOf(SHA_B)]));
        expect(recordedOwners()).toEqual(
          expect.arrayContaining(['original:owner-1', `original:${ownerTwo}`, `profile:${ownerTwo}`]),
        );
        expect(mocks.user.getList).not.toHaveBeenCalled();
      });
    });

    describe('Locked key files (FL-721)', () => {
      const OWNER = '00000000-0000-4000-8000-000000000001';
      let media: string;
      let previous: string;
      let keyPath: string;
      const keyText = '{"format":"frameleaf-locked-key/1","wraps":"wrapped-secret-material"}';

      beforeEach(async () => {
        previous = StorageCore.getMediaLocation();
        media = await mkdtemp(join(tmpdir(), 'cloud-backup-locked-'));
        StorageCore.setMediaLocation(media);
        await mkdir(join(media, 'locked-keys'), { mode: 0o700 });
        keyPath = join(media, 'locked-keys', `${OWNER}.json`);
        await writeFile(keyPath, keyText, { mode: 0o600 });
        // a half-written key file and anything that is not a person's key file stay out
        await writeFile(join(media, 'locked-keys', `${OWNER}.json.0b6e5c7e-3f0b-4c8e-9a51-2f1f3c4d5e6f.tmp`), 'x');
        await writeFile(join(media, 'locked-keys', 'notes.json'), 'x');
      });

      afterEach(async () => {
        StorageCore.setMediaLocation(previous);
        await rm(media, { recursive: true, force: true });
      });

      it('Cloud capture includes locked-keys/*.json', async () => {
        index.getEntriesPage.mockResolvedValue([
          entry('profile:owner-1', { assetId: null, role: 'profile', sha256: SHA_C }),
          entry(`locked-key:${OWNER}`, {
            assetId: null,
            ownerId: OWNER,
            role: 'locked-key',
            path: keyPath,
            sha256: SHA_B,
          }),
        ]);

        await sut.run(managedOperation(), 'claim-1');

        const recorded = index.upsertEntries.mock.calls.flatMap(([, entries]) => entries as CloudBackupEntry[]);
        expect(recorded.filter(({ role }) => role === 'locked-key')).toEqual([
          expect.objectContaining({ fileKey: `locked-key:${OWNER}`, assetId: null, ownerId: OWNER, path: keyPath }),
        ]);
        expect(uploadedKeys()).toContain(objectKeyOf(hex(keyPath)));
        // its own manifest section, never mistaken for the person's profile image
        const manifest = manifestOf();
        expect(manifest.lockedKeys).toEqual({
          [OWNER]: expect.objectContaining({ role: 'locked-key', path: keyPath, sha256: SHA_B }),
        });
        expect(Object.keys(manifest.profiles)).toEqual(['owner-1']);
        // the wrapped key is never read into a log line
        const logged = Object.values(mocks.logger)
          .filter((value) => vi.isMockFunction(value))
          .map((fn) => fn.mock.calls as unknown[]);
        expect(JSON.stringify(logged)).not.toContain('wrapped-secret-material');
      });

      it('backs up the key files first, before the database and any media', async () => {
        index.listAssets.mockResolvedValueOnce([asset('asset-1', SHA_A)]).mockResolvedValueOnce([]);

        await sut.run(managedOperation(), 'claim-1');

        const keyObject = objectKeyOf(hex(keyPath));
        expect(uploadedKeys().indexOf(keyObject)).toBe(0);
        expect(uploadedKeys().indexOf(keyObject)).toBeLessThan(uploadedKeys().indexOf(clientDumpKey));
        expect(uploadedKeys().indexOf(keyObject)).toBeLessThan(uploadedKeys().indexOf(objectKeyOf(SHA_A)));
        expect(mocks.crypto.hashFile.mock.invocationCallOrder[0]).toBeLessThan(
          databaseBackup.createDatabaseBackup.mock.invocationCallOrder[0],
        );
        expect(operations.complete).toHaveBeenCalled();
      });

      /** OWNER's real key file (the public half is all a backup reads) and an original sealed to it. */
      const sealedToOwner = async (recipient?: Buffer) => {
        const pair = generateLockedKeyPair();
        await writeFile(
          keyPath,
          JSON.stringify({
            format: 'frameleaf-locked-key/1',
            userId: OWNER,
            publicKey: pair.publicKey.toString('base64'),
          }),
          { mode: 0o600 },
        );
        const folder = join(media, 'library', OWNER);
        await mkdir(folder, { recursive: true });
        const plain = join(media, 'plain.jpg');
        const sealed = join(folder, 'IMG_1.jpg');
        await writeFile(plain, 'the photo');
        await encryptLockedFile(plain, sealed, [{ publicKey: recipient ?? pair.publicKey }], {
          assetId: 'asset-1',
          kind: 'original',
          originalFileName: 'IMG_1.jpg',
          mime: 'image/jpeg',
        });
        return sealed;
      };

      it('never completes a backup of encrypted files whose owner had no key file when it started', async () => {
        const sealed = await sealedToOwner();
        // the key file came after the run started (encryption turned on during it): live by the check
        const live = await readFile(keyPath, 'utf8');
        await rm(keyPath);
        index.listAssets
          .mockImplementationOnce(async () => {
            await writeFile(keyPath, live, { mode: 0o600 });
            return [{ ...asset('asset-1', null), ownerId: OWNER, originalPath: sealed }];
          })
          .mockResolvedValueOnce([]);

        await sut.run(managedOperation(), 'claim-1');

        expect(operations.complete).not.toHaveBeenCalled();
        expect(store.uploadStream).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('had no key file when the run started'));
      });

      it('an item restored under an older key, which no key file opens, never fails the backup', async () => {
        // single-item restore after encryption was turned off and on again: its key is no live key
        const sealed = await sealedToOwner(generateLockedKeyPair().publicKey);
        index.listAssets
          .mockResolvedValueOnce([{ ...asset('asset-1', null), ownerId: OWNER, originalPath: sealed }])
          .mockResolvedValueOnce([]);

        await sut.run(managedOperation(), 'claim-1');

        expect(operations.complete).toHaveBeenCalled();
        expect(mocks.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('had no key file'));
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('older key(s) that no key file opens'));
      });

      it('a partner copy of an encrypted item needs the owner’s key file, never the partner’s', async () => {
        const PARTNER = '00000000-0000-4000-8000-000000000002';
        const sealed = await sealedToOwner();
        // the partner never set a Locked PIN: no key file. Their copy points at the owner's file.
        index.listAssets
          .mockResolvedValueOnce([
            { ...asset('asset-1', null), ownerId: OWNER, originalPath: sealed },
            { ...asset('asset-2', null), ownerId: PARTNER, originalPath: sealed },
          ])
          .mockResolvedValueOnce([]);

        await sut.run(managedOperation(), 'claim-1');

        expect(operations.complete).toHaveBeenCalled();
        expect(mocks.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('had no key file'));
      });

      it('an encrypted file on the verified fast path still needs its owner’s key file', async () => {
        const sealed = await sealedToOwner();
        const live = await readFile(keyPath, 'utf8');
        await rm(keyPath);
        // its checksum is on record and verified at this path: the file is never hashed again
        index.listAssets
          .mockImplementationOnce(async () => {
            await writeFile(keyPath, live, { mode: 0o600 });
            return [{ ...asset('asset-1', SHA_A), ownerId: OWNER, originalPath: sealed }];
          })
          .mockResolvedValueOnce([]);

        await sut.run(managedOperation(), 'claim-1');

        expect(operations.complete).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('had no key file when the run started'));
      });

      it('a file with a .fllk.tmp sibling is left for the next run', async () => {
        const folder = join(media, 'library', OWNER);
        await mkdir(folder, { recursive: true });
        const sealing = join(folder, 'IMG_1.jpg');
        const settled = join(folder, 'IMG_2.jpg');
        await writeFile(sealing, 'plain');
        await writeFile(`${sealing}.0b6e5c7e-3f0b-4c8e-9a51-2f1f3c4d5e6f.fllk.tmp`, 'half sealed');
        await writeFile(settled, 'sealed');
        // another file's temporary file names only that file
        await writeFile(join(folder, 'IMG_10.jpg.0b6e5c7e-3f0b-4c8e-9a51-2f1f3c4d5e6f.fllk.tmp'), 'x');
        index.listAssets
          .mockResolvedValueOnce([
            { ...asset('asset-1', SHA_A), ownerId: OWNER, originalPath: sealing },
            { ...asset('asset-2', SHA_B), ownerId: OWNER, originalPath: settled },
          ])
          .mockResolvedValueOnce([]);

        await sut.run(managedOperation(), 'claim-1');

        const recorded = index.upsertEntries.mock.calls.flatMap(([, entries]) =>
          (entries as CloudBackupEntry[]).map(({ fileKey }) => fileKey),
        );
        expect(recorded).toContain('asset-2:original');
        expect(recorded).not.toContain('asset-1:original');
        expect(uploadedKeys()).not.toContain(objectKeyOf(SHA_A));
        expect(operations.complete).toHaveBeenCalled();
        // counted as changed: the next run backs it up
        const results = operations.setBulkResult.mock.calls.map(
          (call) => (call[2] as { result: { changed: number } }).result,
        );
        expect(results.at(-1)).toMatchObject({ changed: 1 });
      });
    });

    describe('selected Cloud Backup (FL-362)', () => {
      const decision = {
        runId: 'run-1',
        manifestKey: MANIFEST_KEY,
        inventoryAt: new Date('2026-09-26T03:00:01.000Z'),
        licenceScope: 'all',
      };
      let reports: Map<string, Record<string, unknown>>;

      beforeEach(() => {
        let decided = false;
        reports = new Map();
        selection.captureInventory.mockImplementation(() => {
          decided = true;
          return Promise.resolve({ inventoryAt: decision.inventoryAt, created: true });
        });
        selection.getDecisionRun.mockImplementation(() => Promise.resolve(decided ? decision : undefined));
        selection.getEligibleOwners.mockResolvedValue(new Set(['owner-1']));
        selection.getDecisionAccounts.mockResolvedValue([
          {
            userId: 'owner-1',
            userFingerprint: 'a'.repeat(64),
            selectionHash: null,
            totalOriginals: 2,
            selectedOriginals: 1,
            licenceEligible: true,
            includedOriginals: 1,
          },
        ]);
        selection.getCoverageReport.mockImplementation((runId: string) => Promise.resolve(reports.get(runId)));
        selection.createCoverageReport.mockImplementation((report: Record<string, unknown>) => {
          reports.set(report.runId as string, { attempts: 0, revisionAccepted: false, ...report });
          return Promise.resolve(reports.get(report.runId as string));
        });
        selection.updateCoverageReport.mockImplementation((runId: string, patch: Record<string, unknown>) => {
          reports.set(runId, { ...reports.get(runId), ...patch });
          return Promise.resolve();
        });
        cloudBackup.beginCoverage = vi.fn().mockResolvedValue({});
        cloudBackup.putCoveragePage = vi.fn().mockResolvedValue({});
        cloudBackup.finalizeCoverage = vi.fn().mockResolvedValue({});
        cloudBackup.getCoverageState = vi.fn().mockResolvedValue({ published: null, pending: null });
        index.listAssets.mockResolvedValueOnce([asset('asset-1', SHA_A)]).mockResolvedValueOnce([]);
        index.getEntriesPage.mockResolvedValue([entry('asset-1:original')]);
      });

      it('takes the inventory before the database copy and walks only what it keeps', async () => {
        cloudBackup.rotate.mockResolvedValue({
          ...rotated,
          coverage: { scope: 'users', userFingerprints: [backupUserFingerprint(INSTANCE_ID, 'owner-1')] },
        });

        await sut.run(managedOperation(), 'claim-1');

        expect(operations.complete).toHaveBeenCalled();
        expect(selection.captureInventory).toHaveBeenCalledWith({
          runId: 'run-1',
          manifestKey: MANIFEST_KEY,
          instanceId: INSTANCE_ID,
          licence: { scope: 'users', userFingerprints: [backupUserFingerprint(INSTANCE_ID, 'owner-1')] },
        });
        expect(selection.captureInventory.mock.invocationCallOrder[0]).toBeLessThan(
          databaseBackup.createDatabaseBackup.mock.invocationCallOrder[0],
        );
        expect(index.countAssets).toHaveBeenCalledWith('run-1');
        expect(index.listAssets).toHaveBeenCalledWith(expect.objectContaining({ decisionRunId: 'run-1' }));
        expect(selection.recordIncluded).toHaveBeenCalledWith('run-1', MANIFEST_ID);
        expect(selection.recordIncluded.mock.invocationCallOrder[0]).toBeLessThan(
          index.deleteEntries.mock.invocationCallOrder[0],
        );
        // nothing about the choice in the manifest
        expect(Object.keys(manifestOf())).not.toEqual(expect.arrayContaining(['selection']));
        expect(JSON.stringify(manifestOf())).not.toMatch(/selection|albumIds|favorites/);
      });

      it('names no manifest in the run report and publishes coverage bound to its signed snapshot receipt', async () => {
        await sut.run(managedOperation(), 'claim-1');

        // a client-encrypted manifest is named by its signed receipt, never by its key
        expect(cloudBackup.reportRun).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ runId: 'run-1', status: 'succeeded', manifestKey: null }),
        );
        const history = (await readBackupHistory(join(identityDir, `cloud-backup-history-${hex(managedRef)}.json`)))!;
        const receipt = selectBackupSnapshot(history).record;
        expect(receipt.descriptor).toMatchObject({ snapshotId: MANIFEST_ID, manifest: { objectKey: MANIFEST_KEY } });
        expect(cloudBackup.beginCoverage).toHaveBeenCalledWith(
          expect.anything(),
          'run-1',
          expect.objectContaining({
            sequence: 1,
            accountCount: 1,
            pageCount: 1,
            snapshot: { kind: 'receipt', vaultId: INSTANCE_ID, snapshotId: MANIFEST_ID, digest: receipt.digest },
          }),
        );
        const body = cloudBackup.putCoveragePage.mock.calls[0][4];
        expect(JSON.parse(body)).toEqual({
          rows: [
            {
              userFingerprint: 'a'.repeat(64),
              totalOriginals: 2,
              selectedOriginals: 1,
              licenceEligible: true,
              includedOriginals: 1,
            },
          ],
        });
        expect(cloudBackup.finalizeCoverage).toHaveBeenCalled();
        expect(reports.get('run-1')).toMatchObject({ status: 'published' });
      });

      it('never reports a refused run again, and still binds its coverage to the signed snapshot receipt', async () => {
        cloudBackup.reportRun
          .mockRejectedValueOnce(new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, 400, 'invalid', null))
          .mockResolvedValue(undefined);

        await sut.run(managedOperation(), 'claim-1');

        // the report never named a manifest key, so there is nothing to drop and send again
        expect(cloudBackup.reportRun).toHaveBeenCalledOnce();
        expect(cloudBackup.beginCoverage).toHaveBeenCalledWith(
          expect.anything(),
          'run-1',
          expect.objectContaining({ snapshot: expect.objectContaining({ kind: 'receipt', snapshotId: MANIFEST_ID }) }),
        );
        expect(JSON.parse(cloudBackup.putCoveragePage.mock.calls[0][4]).rows[0].includedOriginals).toBe(1);
        expect(operations.complete).toHaveBeenCalled();
      });

      it('reports a failed run and its coverage with nothing committed, and the run still fails as before', async () => {
        store.uploadFile.mockRejectedValue(new Error('provider down'));

        await sut.run(managedOperation(), 'claim-1');

        expect(operations.fail).toHaveBeenCalled();
        expect(cloudBackup.reportRun).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ status: 'failed', manifestKey: null, errorCode: 'cloud_backup_failed' }),
        );
        expect(cloudBackup.beginCoverage).toHaveBeenCalledWith(
          expect.anything(),
          'run-1',
          expect.objectContaining({ snapshot: null }),
        );
        expect(JSON.parse(cloudBackup.putCoveragePage.mock.calls[0][4]).rows[0].includedOriginals).toBeNull();
      });

      it('never lets coverage publication fail or hold up a backup', async () => {
        cloudBackup.beginCoverage.mockRejectedValue(new Error('cloud unreachable'));

        await sut.run(managedOperation(), 'claim-1');

        expect(operations.complete).toHaveBeenCalled();
        expect(operations.fail).not.toHaveBeenCalled();
        expect(reports.get('run-1')).toMatchObject({ status: 'pending', attempts: 1 });
      });

      it('keeps a claim from before FL-362 walking as it did', async () => {
        await sut.run(
          operationOf({
            snapshot: managedOperation().snapshot,
            result: {
              ...emptyRunResult(),
              phase: 'reconcile',
              manifestId: MANIFEST_ID,
              manifestKey: decision.manifestKey,
            },
          }),
          'claim-1',
        );

        expect(selection.captureInventory).not.toHaveBeenCalled();
        expect(index.listAssets).toHaveBeenCalledWith(
          expect.not.objectContaining({ decisionRunId: expect.anything() }),
        );
        expect(cloudBackup.beginCoverage).not.toHaveBeenCalled();
      });
    });

    it('retains the same transfer operation while Cloud renewal is temporarily unavailable', async () => {
      store.uploadFile.mockRejectedValueOnce(new ManagedBackupAuthorizationError(undefined, 120_000));
      await sut.run(managedOperation(), 'claim-1');
      expect(operations.requeue).toHaveBeenCalledWith('run-1', 'claim-1', {
        delayMs: 120_000,
        returnAttempt: true,
        requireActiveClaim: true,
      });
      expect(operations.fail).not.toHaveBeenCalled();
      expect(index.finishManifest).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('writes managed backups encrypted and retains a pinned dump through renewal outage, root rotation and pause', async () => {
      const vaultId = 'f0000000-0000-4000-8000-000000000001';
      const file = addClientBackupKeys({ ...JSON.parse(keyFileOf()), instanceId: vaultId });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({ instanceId: vaultId });
      keys.read.mockResolvedValue(JSON.stringify(file));
      store.readMarker.mockResolvedValue({ instanceId: vaultId });
      index.createManifest.mockImplementation(({ key }) => Promise.resolve({ id: MANIFEST_ID, key }));
      store.finishClientUpload = vi.fn().mockResolvedValue(undefined);
      store.uploadFile.mockImplementationOnce(async (connection, objectKey) => {
        await connection.transfer.save({
          kind: 'upload',
          key: objectKey,
          source: '/identity/cloud-backup-staging/pinned.ciphertext',
          sourceStamp: 'ciphertext-stamp',
          expectedSha256: 'd'.repeat(64),
          uploadId: 'upload-1',
          previousUploads: [],
          parts: [],
          completing: false,
        });
        throw new ManagedBackupAuthorizationError(undefined, 60_000);
      });
      const first = managedOperation();
      await sut.run(first, 'claim-1');
      const pinned = operations.setBulkResult.mock.calls
        .map((call) => call[2].result)
        .find((result) => result.phase === 'database' && result.database);
      expect(pinned.database.key).toMatch(/^db\/v1\/.+\/1\//);
      expect(operations.requeue).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ requireActiveClaim: true }),
      );
      keys.read.mockResolvedValue(JSON.stringify({ ...file, client: rotateClientBackupKeys(file.client, key) }));
      index.getManifest.mockResolvedValue({ id: MANIFEST_ID, key: pinned.manifestKey, status: 'running' });
      operations.setBulkResult.mockImplementation((_id, _claim, progress) =>
        Promise.resolve(progress.result.phase === 'reconcile' ? { ...running, pauseRequestedAt: new Date() } : running),
      );
      store.uploadFile.mockImplementationOnce(async (connection) => {
        expect(connection.recoveryKeys[1]).toBe(file.client.keys[1]);
        expect(connection.transfer.current).toMatchObject({ expectedSha256: 'd'.repeat(64), uploadId: 'upload-1' });
        await connection.transfer.save(null);
        return { size: 50, etag: 'completed-ciphertext' };
      });
      await sut.run(
        operationOf({
          snapshot: first.snapshot,
          result: { ...pinned, backupTransfer: (first.result as Record<string, unknown>).backupTransfer },
        }),
        'claim-2',
      );
      expect(databaseBackup.createDatabaseBackup).toHaveBeenCalledTimes(1);
      expect(mocks.crypto.hashFile).toHaveBeenCalledTimes(1);
      expect(store.uploadFile.mock.calls.map(([, objectKey]) => objectKey)).toEqual([
        pinned.database.key,
        pinned.database.key,
      ]);
      expect(operations.setBackupTransfer).toHaveBeenNthCalledWith(
        1,
        'run-1',
        'claim-1',
        expect.objectContaining({ uploadId: 'upload-1' }),
      );
      expect(operations.setBackupTransfer).toHaveBeenNthCalledWith(2, 'run-1', 'claim-2', null);
      expect(operations.setBulkResult).toHaveBeenCalledWith(
        'run-1',
        'claim-2',
        expect.objectContaining({
          result: expect.objectContaining({
            phase: 'reconcile',
            database: expect.objectContaining({ key: pinned.database.key }),
            backupTransfer: null,
          }),
        }),
      );
      expect(operations.settlePause).toHaveBeenCalledWith('run-1', 'claim-2');
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
      expect(store.finishClientUpload).not.toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('refuses to resume a pre-CSE database upload rather than finish it unencrypted or dump again', async () => {
      const source = join(StorageCore.getBaseFolder(StorageFolder.Backups), dumpName);
      const resumed = managedOperation();
      resumed.result = {
        ...emptyRunResult(),
        backupTransfer: {
          kind: 'upload',
          key: dumpKey,
          source,
          sourceStamp: 'legacy-source',
          expectedSha256: SHA_DUMP,
          uploadId: 'upload-legacy',
          previousUploads: [],
          parts: [],
          completing: false,
        },
      };
      await sut.run(resumed, 'claim-2');
      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-2',
        expect.objectContaining({ error: 'The encrypted database upload has no pinned dump identity.' }),
      );
      expect(databaseBackup.createDatabaseBackup).not.toHaveBeenCalled();
      expect(mocks.crypto.hashFile).not.toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('stops persistent provider authorization failures without replaying a refused operation', async () => {
      store.uploadFile.mockRejectedValueOnce(new ManagedBackupAuthorizationError('Capability refused'));
      await sut.run(managedOperation(), 'claim-1');
      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: 'Capability refused' }),
        { retry: false, requireActiveClaim: true },
      );
      expect(operations.requeue).not.toHaveBeenCalled();
    });

    it.each(['pause', 'cancel', 'lost', 'expired'])(
      'settles a refused transfer checkpoint after %s without recording failure',
      async (reason) => {
        store.uploadFile.mockRejectedValueOnce(new OperationClaimLostError());
        operations.getOfKind.mockResolvedValue({
          ...managedOperation(),
          claimToken: reason === 'lost' ? 'replacement-claim' : 'claim-1',
          ...(reason === 'pause' && { pauseRequestedAt: new Date() }),
          ...(reason === 'cancel' && { cancelRequestedAt: new Date() }),
          ...(reason === 'expired' && { claimExpiresAt: new Date(0) }),
        });
        await sut.run(managedOperation(), 'claim-1');
        expect(operations.fail).not.toHaveBeenCalled();
        expect(operations.complete).not.toHaveBeenCalled();
        expect(index.finishManifest).not.toHaveBeenCalled();
        if (reason === 'pause') expect(operations.settlePause).toHaveBeenCalledWith('run-1', 'claim-1');
        else if (reason === 'cancel')
          expect(operations.acknowledgeCancel).toHaveBeenCalledWith('run-1', 'claim-1', { released: false });
      },
    );

    it.each([
      ['verify', undefined, 'restore'],
      ['prune', true, 'restore'],
      ['prune', false, 'prune'],
      ['backup', undefined, 'upload'],
    ])('requests the least authority for %s (dry run %s)', (task, dryRun, expected) => {
      expect(sut['backupOperation'](operationOf({ snapshot: { task, dryRun } }))).toBe(expected);
    });

    it('follows the first backup of the activation chain by push, ending it when the backup is done (FL-228)', async () => {
      await sut.run(managedOperation(), 'claim-1');

      const activation = mocks.event.emit.mock.calls
        .filter(([name]) => name === 'PushNotify')
        .map(([, notice]) => notice as PushNotice)
        .filter(({ type }) => type === PushEventType.CloudBackupActivation);
      expect(activation.length).toBeGreaterThanOrEqual(2);
      expect(activation[0]).toMatchObject({
        admins: true,
        activation: { step: 4, total: 4, stage: 'first-backup', state: 'active' },
      });
      expect(activation.at(-1)).toMatchObject({
        admins: true,
        body: '4 of 4 · First backup complete',
        systemTemplate: { version: 1, key: 'activation-first-backup-complete', args: { step: 4, total: 4 } },
        activation: { step: 4, stage: 'first-backup', state: 'complete', firstRun: 'done' },
      });
    });

    it('says storage is being prepared when managed setup starts (FL-228)', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
      cloudBackup.grant.mockRejectedValue(new Error('stop here'));

      await expect(
        sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: keyFileOf() } as never),
      ).rejects.toThrow();

      expect(mocks.event.emit).toHaveBeenCalledWith(
        'PushNotify',
        expect.objectContaining({
          type: PushEventType.CloudBackupActivation,
          admins: true,
          body: '3 of 4 · Preparing storage',
          systemTemplate: { version: 1, key: 'activation-preparing-storage', args: { step: 3, total: 4 } },
          activation: expect.objectContaining({ step: 3, stage: 'preparing-storage', state: 'active' }),
        }),
      );
    });

    it('leaves the activation chain alone once a first backup has been done (FL-228)', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({ lastSuccessAt: '2026-09-20T00:00:00.000Z' });

      await sut.run(managedOperation(), 'claim-1');

      expect(mocks.event.emit).not.toHaveBeenCalledWith(
        'PushNotify',
        expect.objectContaining({ type: PushEventType.CloudBackupActivation }),
      );
    });

    it('stops uploads without touching this server’s files while the grant is read-only', async () => {
      cloudBackup.rotate.mockResolvedValue({ ...rotated, readOnly: true });

      await sut.run(managedOperation(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('read-only') }),
      );
      expect(databaseBackup.createDatabaseBackup).not.toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('pauses for a full plan, words it, and carries on by itself once the grant is writable (FL-301)', async () => {
      cloudBackup.rotate.mockResolvedValue({ ...rotated, readOnly: true, readOnlyReason: 'plan_full' });

      await sut.run(managedOperation(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('because the Frameleaf plan is full') }),
      );
      expect((metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup).managed).toMatchObject({
        readOnly: true,
        readOnlyReason: 'plan_full',
      });
      expect(store.uploadFile).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).not.toHaveBeenCalled();

      operations.fail.mockClear();
      cloudBackup.rotate.mockResolvedValue({ ...rotated, readOnly: false });
      await sut.run(managedOperation(), 'claim-1');

      expect(operations.fail).not.toHaveBeenCalled();
      expect((metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup).managed).toMatchObject({
        readOnly: false,
        readOnlyReason: null,
      });
    });

    it('treats a read-only reason it does not know as read-only, worded generically (FL-301)', async () => {
      cloudBackup.rotate.mockResolvedValue({ ...rotated, readOnly: true, readOnlyReason: 'something_new' });

      await sut.run(managedOperation(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({
          error: expect.stringMatching(
            /^Frameleaf-managed storage is read-only for this server, so backups are paused/,
          ),
        }),
      );
      expect(store.uploadFile).not.toHaveBeenCalled();
    });

    it('asks for no storage while Frameleaf Cloud suspects a copy of this server, and says so', async () => {
      metadata[SystemMetadataKey.FrameleafCloudLink] = {
        status: 'linked',
        cloudUrl,
        instanceId: INSTANCE_ID,
        heartbeat: { cloneSuspected: true },
      };

      await sut.run(managedOperation(), 'claim-1');

      expect(cloudBackup.rotate).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('copy of another one') }),
      );
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({ dedupeKey: 'frameleaf-cloud:clone-suspected' }),
      );
    });

    it('waits out a rate limit rather than failing', async () => {
      cloudBackup.rotate.mockRejectedValue(
        new FrameleafCloudError(
          MlAdmissionRefusal.CloudUnavailable,
          429,
          'rate limited',
          errorEnvelopeSchema.parse(cloudContractFixture('errors/rate-limited.json')),
          null,
          120,
        ),
      );

      await sut.run(managedOperation(), 'claim-1');

      expect(operations.requeue).toHaveBeenCalledWith('run-1', 'claim-1', { delayMs: 120_000, returnAttempt: true });
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('stops on a withdrawn grant with the reason Frameleaf Cloud gave', async () => {
      cloudBackup.rotate.mockRejectedValue(
        new FrameleafCloudError(
          MlAdmissionRefusal.CloudUnavailable,
          410,
          'withdrawn',
          errorEnvelopeSchema.parse(cloudContractFixture('errors/grant-revoked.json')),
        ),
      );

      await sut.run(managedOperation(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('unlinked from Frameleaf Cloud') }),
      );
    });

    it('sets up with the bucket Frameleaf Cloud grants, and keeps no credential for it', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
      metadata[SystemMetadataKey.SystemConfig] = {};
      cloudBackup.grant.mockResolvedValue(managedGrantFixture('backup/grant-metadata.json'));

      await sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: keyFileOf() } as never);

      // a repeated grant answers without a key, so one is rotated for the claim
      expect(selectBackupLocation).toHaveBeenCalled();
      expect(cloudBackup.grant).toHaveBeenCalledWith(expect.anything(), grant.location.locationId, 'upload');
      expect(vi.mocked(selectBackupLocation).mock.invocationCallOrder[0]).toBeLessThan(
        cloudBackup.grant.mock.invocationCallOrder[0],
      );
      expect(cloudBackup.rotate).toHaveBeenCalled();
      expect(store.claim).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: grant.bucket,
          secretAccessKey: rotated.capability.credentials.secretAccessKey,
        }),
        key,
        expect.anything(),
      );
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        target: 'managed',
        bucketRef: managedRef,
        bucket: grant.bucket,
        managed: {
          storageId: grant.storageId,
          location: grant.location,
          readOnly: false,
          quotaBytes: grant.quotaBytes,
        },
      });
      const persisted = JSON.stringify(configWrites());
      expect(persisted).toContain('"target":"managed"');
      expect(persisted).not.toContain(rotated.capability.credentials.secretAccessKey);
      expect(cloudBackup.putSettings).toHaveBeenCalledWith(expect.anything(), {
        keyMode: 'server',
        scheduleEnabled: true,
      });
    });

    it('tests locations on this server before the first grant, and provisions nothing when selection fails', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
      const locations = [{ ...grant.location, probeUrl: grant.endpoint }];
      cloudBackup.locations.mockResolvedValue({ version: 2, locations });
      vi.mocked(selectBackupLocation).mockRejectedValue(new Error('provider detail must not escape'));

      await expect(
        sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: keyFileOf() } as never),
      ).rejects.toThrow('No backup location could be reached reliably. Try setup again.');
      expect(selectBackupLocation).toHaveBeenCalledWith(locations);
      expect(cloudBackup.grant).not.toHaveBeenCalled();
      expect(cloudBackup.rotate).not.toHaveBeenCalled();
      expect(store.claim).not.toHaveBeenCalled();
    });

    it('propagates the actual measured median and stable-ID winner into the first grant and persisted claim', async () => {
      // These are authored interfaces, not evidence of live Cloud provisioning or socket connectivity.
      const actual = await vi.importActual<typeof import('src/utils/backup-location-selection.js')>(
        'src/utils/backup-location-selection.js',
      );
      const locations = [
        { ...grant.location, locationId: 'loc-08', probeUrl: 'https://s3.eu-west-1.backup.frameleaf.cloud/' },
        { ...grant.location, locationId: 'loc-01', probeUrl: 'https://s3.eu-central-2.backup.frameleaf.cloud/' },
        { ...grant.location, probeUrl: `${grant.endpoint}/` },
      ];
      const samples: Record<string, number[]> = {
        's3.eu-west-1.backup.frameleaf.cloud': [70, 70, 80],
        's3.eu-central-2.backup.frameleaf.cloud': [1, 90, 100],
        's3.eu-central-1.backup.frameleaf.cloud': [70, 70, 1000],
      };
      let now = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
      vi.mocked(lookup).mockImplementation(((
        _host: string,
        _options: unknown,
        callback: (error: Error | null, addresses: LookupAddress[]) => void,
      ) => callback(null, [{ address: '8.8.8.8', family: 4 }])) as never);
      vi.mocked(request).mockImplementation(((
        url: URL,
        options: RequestOptions,
        respond: (response: unknown) => void,
      ) => {
        expect(options).toMatchObject({ method: 'HEAD', agent: false, rejectUnauthorized: true });
        expect(options).not.toHaveProperty('headers');
        const req = new EventEmitter() as EventEmitter & { end: () => void };
        req.end = () => {
          (options.lookup as LookupFunction)(url.hostname, {}, (error, address) => {
            expect(error).toBeNull();
            expect(address).toBe('8.8.8.8');
            now += samples[url.hostname].shift()!;
            respond({ statusCode: 200, resume: vi.fn() });
          });
        };
        return req;
      }) as never);
      vi.mocked(selectBackupLocation).mockImplementation((candidates) => actual.selectBackupLocation(candidates));
      metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
      metadata[SystemMetadataKey.SystemConfig] = {};
      const transport = vi.fn(
        (schema: { parse: (value: unknown) => unknown }, options: { url: string; method?: string }) => {
          if (options.url.endsWith('/locations')) {
            return Promise.resolve(schema.parse({ version: 2, locations }));
          }
          if (options.method !== 'POST') {
            return Promise.reject(
              new FrameleafCloudError(
                MlAdmissionRefusal.CloudUnavailable,
                404,
                'unclaimed',
                errorEnvelopeSchema.parse({ code: 'not-found', message: 'unclaimed', retryable: false }),
              ),
            );
          }
          return Promise.resolve(schema.parse(grant));
        },
      );
      const repository = new FrameleafCloudBackupRepository({
        requestJson: transport,
        requestJsonTimed: async (
          schema: Parameters<typeof transport>[0],
          request: Parameters<typeof transport>[1],
        ) => ({ data: await transport(schema, request), serverTime: Date.parse('2026-10-11T12:00:00Z'), elapsedMs: 0 }),
      } as never);
      cloudBackup.metadata = vi.fn<FrameleafCloudBackupRepository['metadata']>((target) => repository.metadata(target));
      cloudBackup.locations = vi.fn<FrameleafCloudBackupRepository['locations']>((target) =>
        repository.locations(target),
      );
      cloudBackup.grant = vi.fn<FrameleafCloudBackupRepository['grant']>((target, id, operation) =>
        repository.grant(target, id, operation),
      );
      try {
        await sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: keyFileOf() } as never);
        expect(request).toHaveBeenCalledTimes(9);
        expect(Object.values(samples)).toEqual([[], [], []]);
        expect(cloudBackup.grant).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'loc-07', 'upload');
        expect(transport).toHaveBeenLastCalledWith(expect.anything(), {
          method: 'POST',
          url: 'https://api.frameleaf.test/v4/backup/grant',
          timeoutMs: 120_000,
          dpop: expect.anything(),
          body: { locationId: 'loc-07', operation: 'upload' },
        });
        expect(vi.mocked(request).mock.invocationCallOrder.at(-1)).toBeLessThan(
          cloudBackup.grant.mock.invocationCallOrder[0],
        );
        expect(cloudBackup.rotate).not.toHaveBeenCalled();
        expect(store.claim).toHaveBeenCalledTimes(1);
        expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
          bucketRef: managedRef,
          managed: { storageId: grant.storageId, location: grant.location },
        });
      } finally {
        clock.mockRestore();
        vi.mocked(request).mockReset();
        vi.mocked(lookup).mockReset();
      }
    });

    it.each([
      ['selected location', { ...grant, location: { ...grant.location, locationId: 'loc-01' } }, rotated],
      [
        'storage ID',
        managedGrantFixture('backup/grant-metadata.json'),
        { ...rotated, storageId: '0194b445-9c8a-7001-8000-000000000099' },
      ],
      [
        'bucket',
        managedGrantFixture('backup/grant-metadata.json'),
        { ...rotated, bucket: grant.bucket.replace('fl-eu-', 'fl-na-') },
      ],
      ['region', managedGrantFixture('backup/grant-metadata.json'), { ...rotated, region: 'us-east-1' }],
    ])(
      'refuses an initial setup grant/rotation %s mismatch before local claim or settings persistence',
      async (_field, offered, issued) => {
        metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
        metadata[SystemMetadataKey.SystemConfig] = {};
        // This refusal fixture has an existing fixed identity. Seed its metadata
        // so legitimate identity initialization is not mistaken for backup mutation.
        metadata[SystemMetadataKey.FrameleafInstance] = structuredClone(instance);
        const before = structuredClone(metadata);
        cloudBackup.grant.mockResolvedValue(offered);
        cloudBackup.rotate.mockResolvedValue(issued);
        await expect(
          sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: keyFileOf() } as never),
        ).rejects.toThrow('different storage binding');
        expect(cloudBackup.grant).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          grant.location.locationId,
          'upload',
        );
        expect(store.claim).not.toHaveBeenCalled();
        expect(keys.write).not.toHaveBeenCalled();
        expect(configWrites()).toEqual([]);
        expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
        expect(cloudBackup.putSettings).not.toHaveBeenCalled();
        expect(metadata).toEqual(before);
      },
    );

    it('reuses the persisted location on setup retry without fetching or probing a new catalog', async () => {
      const recorded = managedGrantFixture('backup/grant-metadata.json');
      cloudBackup.metadata.mockResolvedValue(recorded);
      cloudBackup.grant.mockResolvedValue(grant);

      await sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: keyFileOf() } as never);
      expect(cloudBackup.grant).toHaveBeenCalledWith(expect.anything(), recorded.location.locationId, 'upload');
      expect(cloudBackup.locations).not.toHaveBeenCalled();
      expect(selectBackupLocation).not.toHaveBeenCalled();
    });

    it('keeps stable storage identity independently of the connection hostname but rejects a changed physical region or storage ID', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({
        endpoint: 'https://previous.backup.frameleaf.cloud',
      });
      await sut.run(managedOperation(), 'claim-1');
      expect(operations.complete).toHaveBeenCalled();
      expect((metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup).bucketRef).toBe(managedRef);

      operations.complete.mockClear();
      for (const changed of [
        { ...rotated, region: 'us-east-1' },
        { ...rotated, storageId: '0194b445-9c8a-7001-8000-000000000099' },
        { ...rotated, location: { ...rotated.location, locationId: 'loc-01' } },
        { ...rotated, bucket: rotated.bucket.replace('fl-eu-', 'fl-na-') },
      ]) {
        cloudBackup.rotate.mockResolvedValue(changed);
        await sut.run(managedOperation(), 'claim-1');
        expect(operations.fail).toHaveBeenCalledWith(
          'run-1',
          'claim-1',
          expect.objectContaining({ error: expect.stringContaining('different storage binding') }),
        );
      }
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('keeps an older address-based index identity unchanged without a backup-data migration', async () => {
      const oldRef = bucketRef(grant.endpoint, grant.bucket);
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({
        bucketRef: oldRef,
        managed: {
          readOnly: false,
          readOnlyReason: null,
          quotaBytes: grant.quotaBytes,
          checkedAt: '2026-09-25T00:00:00.000Z',
        },
      });
      await sut.run(
        operationOf({ snapshot: { version: 1, bucketRef: oldRef, keyFingerprint: fingerprint } }),
        'claim-1',
      );
      expect(operations.complete).toHaveBeenCalled();
      const saved = metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup;
      expect(saved.bucketRef).toBe(oldRef);
      expect(saved.managed?.storageId).toBeUndefined();
    });

    it('rejects a changed recorded legacy location before storage I/O or metadata replacement', async () => {
      const saved = managedClaim({
        bucketRef: bucketRef(grant.endpoint, grant.bucket),
        managed: {
          location: grant.location,
          readOnly: false,
          readOnlyReason: null,
          quotaBytes: grant.quotaBytes,
          checkedAt: '2026-09-25T00:00:00.000Z',
        },
      });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = saved;
      cloudBackup.rotate.mockResolvedValue({ ...rotated, location: { ...rotated.location, locationId: 'loc-01' } });

      await expect(sut['openManaged'](saved, managedOperation(), 'claim-1')).rejects.toThrow(
        'different storage binding',
      );
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toBe(saved);
      expect(store.get).not.toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
    });

    it('rejects a rotation that disagrees with the POST binding during first setup before claiming storage', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
      cloudBackup.grant.mockResolvedValue(managedGrantFixture('backup/grant-metadata.json'));
      for (const changed of [
        { ...rotated, region: 'us-east-1' },
        { ...rotated, storageId: '0194b445-9c8a-7001-8000-000000000099' },
        { ...rotated, bucket: rotated.bucket.replace('fl-eu-', 'fl-na-') },
      ]) {
        cloudBackup.rotate.mockResolvedValue(changed);
        await expect(
          sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: keyFileOf() } as never),
        ).rejects.toThrow('different storage binding');
      }
      expect(store.claim).not.toHaveBeenCalled();
    });

    it('reclaims the same legacy binding without moving its index or dropping its history', async () => {
      const oldRef = bucketRef('https://previous.backup.frameleaf.cloud', grant.bucket);
      const lastSuccessAt = '2026-09-25T01:00:00.000Z';
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({
        bucketRef: oldRef,
        endpoint: 'https://previous.backup.frameleaf.cloud',
        lastSuccessAt,
        managed: { readOnly: false, readOnlyReason: null, quotaBytes: grant.quotaBytes, checkedAt: lastSuccessAt },
      });
      cloudBackup.metadata.mockResolvedValue(managedGrantFixture('backup/grant-metadata.json'));
      cloudBackup.grant.mockResolvedValue(grant);
      store.claim.mockResolvedValue({ existing: true, claimedAt: lastSuccessAt });
      await sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: keyFileOf() } as never);

      const saved = metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup;
      expect(saved.bucketRef).toBe(oldRef);
      expect(saved.lastSuccessAt).toBe(lastSuccessAt);
      expect(saved.managed?.storageId).toBeUndefined();
      expect(index.deleteBucket).not.toHaveBeenCalled();
      expect(sut['managedConnection'](rotated, saved, 'upload').region).toBe(grant.region);
    });

    it('does not serve a warm manifest cache after its recorded storage binding changes', async () => {
      const saved = managedClaim() as FrameleafCloudBackup;
      const key = 'm/2026-09-25T01:00:00.000Z.json.gz';
      index.listKeptManifests.mockResolvedValue([{ key }]);
      const manifest = {} as never;
      sut['manifestCache'] = {
        bucketRef: saved.bucketRef,
        key,
        manifest,
        binding: JSON.stringify([
          saved.bucketRef,
          saved.region,
          saved.bucket,
          saved.keyFingerprint,
          saved.managed?.storageId ?? null,
          saved.managed?.location?.locationId ?? null,
        ]),
      };
      await expect(sut['readManifestForRequest'](saved, key)).resolves.toBe(manifest);
      for (const changed of [
        { ...saved, region: 'us-east-1' },
        { ...saved, bucket: saved.bucket.replace('fl-eu-', 'fl-na-') },
        { ...saved, keyFingerprint: 'different-key-fingerprint' },
        { ...saved, managed: { ...saved.managed!, storageId: '0194b445-9c8a-7001-8000-000000000099' } },
        { ...saved, managed: { ...saved.managed!, location: { ...grant.location, locationId: 'loc-01' } } },
      ]) {
        await expect(sut['readManifestForRequest'](changed, key)).rejects.toThrow();
      }
      expect(store.get).not.toHaveBeenCalled();
    });
  });

  describe('key escrow (FL-164)', () => {
    const cloudUrl = 'https://cloud.frameleaf.test';

    beforeEach(() => {
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir, url: cloudUrl } }),
      );
      metadata[SystemMetadataKey.FrameleafCloudLink] = { status: 'linked', cloudUrl, instanceId: INSTANCE_ID };
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
      mocks.frameleafCloud.discovery.mockResolvedValue({ api: 'https://api.frameleaf.test' } as never);
      mocks.frameleafCloud.accessToken.mockResolvedValue({ accessToken: 'token' } as never);
    });

    it(
      'wraps independent and historical client roots into v2 escrow without sending plaintext recovery material',
      { timeout: SCRYPT_TEST_TIMEOUT_MS },
      async () => {
        const vaultId = 'f0000000-0000-4000-8000-000000000001';
        metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ instanceId: vaultId });
        const file = JSON.stringify(
          addClientBackupKeys(
            backupKeyFile({ key, instanceId: vaultId, bucket: s3.bucket, mode: 'server', createdAt: new Date() }),
          ),
        );
        keys.read.mockResolvedValue(file);
        const passphrase = 'correct horse battery staple';
        await sut.storeEscrow(authStub.admin, { passphrase });
        expect(cloudBackup.putEscrow).not.toHaveBeenCalled();
        const blob = cloudBackup.putRecoveryPackage.mock.calls[0][1];
        expect(JSON.parse(await unwrapBackupRecoveryKit(blob, passphrase))).toEqual(JSON.parse(file));
        const wire = JSON.stringify(cloudBackup.putRecoveryPackage.mock.calls);
        expect(wire).not.toContain(JSON.parse(file).client.keys[1]);
        expect(wire).not.toContain(passphrase);
      },
    );

    it(
      'sends only the scrypt-wrapped key, never the key or the passphrase (server key mode)',
      { timeout: SCRYPT_TEST_TIMEOUT_MS },
      async () => {
        // a key file from before client roots still escrows its bucket key alone
        keys.read.mockResolvedValue(legacyKeyFileOf());
        const passphrase = 'correct horse battery staple';

        const status = await sut.storeEscrow(authStub.admin, { passphrase });

        const [, blob] = cloudBackup.putEscrow.mock.calls[0];
        expect(keyEscrowBlobSchema.safeParse(blob).success).toBe(true);
        await expect(unwrapBucketKey(blob, passphrase)).resolves.toEqual(key);
        const sent = JSON.stringify([cloudBackup.putEscrow.mock.calls, cloudBackup.putSettings.mock.calls]);
        expect(sent).not.toContain(key.toString('base64'));
        expect(sent).not.toContain(passphrase);
        expect(status.escrow).toMatchObject({ stored: true });
        expect(await savedConfig()).toMatchObject({
          frameleafCloud: { cloudBackup: { escrow: true } },
        });
      },
    );

    it('is never offered for your own key', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ keyMode: 'own-stored' });

      await expect(sut.storeEscrow(authStub.admin, { passphrase: 'correct horse battery staple' })).rejects.toThrow(
        'only available when this server generates its own backup key',
      );
      expect(cloudBackup.putEscrow).not.toHaveBeenCalled();
      expect(() =>
        sut.onConfigValidate({
          newConfig: { frameleafCloud: { cloudBackup: { enabled: false, keyMode: 'own-memory', escrow: true } } },
          oldConfig: {},
        } as never),
      ).toThrow('only available');
    });

    it(
      'marks the stored copy outdated once the client root rotates past the version it holds',
      { timeout: SCRYPT_TEST_TIMEOUT_MS },
      async () => {
        const stored = await sut.storeEscrow(authStub.admin, { passphrase: 'correct horse battery staple' });

        expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ escrow: { keyVersion: 1 } });
        expect(stored.escrow).toMatchObject({ stored: true, outdated: false });

        keys.read.mockResolvedValue(
          JSON.stringify({ ...JSON.parse(keyFileOf()), client: rotateClientBackupKeys(clientRing, key) }),
        );
        await expect(sut.getStatus()).resolves.toMatchObject({ escrow: { stored: true, outdated: true } });
      },
    );

    it('hands out the signed history for the recovery file, without any key material', async () => {
      await expect(sut.getRecoveryHistory()).resolves.toEqual({ history: null });

      const fixture = recoveryFixture();
      const binding = (metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup).bucketRef;
      await writeBackupHistory(sut['clientHistoryPath'](binding), fixture.history);
      const { history } = await sut.getRecoveryHistory();
      expect(JSON.parse(history!)).toEqual(fixture.history);
      expect(history).not.toContain(key.toString('base64'));
      expect(history).not.toContain(clientRing.keys[1]);
    });

    it('keeps a newer history from the saved file and refuses one from another vault', async () => {
      const fixture = recoveryFixture();
      const binding = (metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup).bucketRef;
      await writeBackupHistory(sut['clientHistoryPath'](binding), fixture.older);
      const { history } = await sut.getRecoveryHistory({ recovery: JSON.stringify(fixture.history) });
      expect(JSON.parse(history!)).toEqual(fixture.history);

      await expect(
        sut.getRecoveryHistory({ recovery: JSON.stringify(recoveryFixture().history) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('counts a stored copy without a key version as version 1', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ escrow: { storedAt: '2026-09-26T00:00:00.000Z' } });
      await expect(sut.getStatus()).resolves.toMatchObject({ escrow: { stored: true, outdated: false } });

      keys.read.mockResolvedValue(
        JSON.stringify({ ...JSON.parse(keyFileOf()), client: rotateClientBackupKeys(clientRing, key) }),
      );
      await expect(sut.getStatus()).resolves.toMatchObject({ escrow: { stored: true, outdated: true } });
    });

    it('removes the copy from Frameleaf Cloud', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ escrow: { storedAt: '2026-09-26T00:00:00.000Z' } });

      const status = await sut.removeEscrow(authStub.admin);

      expect(cloudBackup.deleteEscrow).toHaveBeenCalled();
      expect(cloudBackup.deleteRecoveryPackages).toHaveBeenCalled();
      expect(status.escrow).toMatchObject({ stored: false });
    });
  });

  describe('FL234 owner history and thumbnails', () => {
    const manifestKey = 'm/20260926T030000Z.json.gz';
    const thumb = Buffer.from([255, 216, 255]);
    const thumbHash = createHash('sha256').update(thumb).digest('hex');
    const owner = authStub.user1.user.id;
    const dto = { manifestKey, limit: 10, offset: 0 };
    const kept = { key: manifestKey, status: 'complete', createdAt: new Date(), finishedAt: new Date() };
    const captured = () =>
      new Map([
        [
          'asset-1',
          {
            deletion: {
              ownerId: owner,
              deletedAt: new Date(),
              visibility: 'timeline',
              wasLocked: false,
              checksum: Buffer.from(SHA_A, 'hex'),
              checksumAlgorithm: 'sha256',
              evidenceVersion: 1,
              modernPrivacyEvidenceUnavailable: true,
            },
          },
        ],
      ]);
    const entry = (id: string) => ({
      owner: id,
      type: 'IMAGE',
      originalFileName: id === owner ? 'Own.jpg' : 'Secret.jpg',
      fileCreatedAt: '2026-09-01T00:00:00Z',
      fileModifiedAt: '2026-09-01T00:00:00Z',
      localDateTime: '2026-09-01T00:00:00Z',
      duration: null,
      details: EMPTY_DETAILS,
      files: [
        { role: 'original', path: '/private/path', sha256: SHA_A, size: 100, mtime: null },
        { role: 'thumbnail', path: '/private/thumb', sha256: thumbHash, size: thumb.length, mtime: null },
      ],
    });
    const refresh = () => vi.fn().mockResolvedValue(authStub.user1);
    beforeEach(() => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
      index.listKeptManifests.mockResolvedValue([kept]);
      index.getOwnerHistoryState.mockResolvedValue(captured());
      store.get = vi.fn().mockResolvedValue(
        gzipSync(
          JSON.stringify({
            format: 'frameleaf-backup-manifest',
            version: 2,
            instanceId: INSTANCE_ID,
            createdAt: '2026-09-26T03:00:00Z',
            database: null,
            assets: { 'asset-1': entry(owner), 'foreign-1': entry('foreign') },
            profiles: {},
            albums: {},
            people: {},
          }),
        ),
      );
      store.getPreview = vi.fn().mockResolvedValue(thumb);
    });
    it('refuses forbidden metadata target before reading its original bytes', async () => {
      const folder = await mkdtemp(join(tmpdir(), 'owner-metadata-'));
      const target = join(folder, 'original.jpg');
      try {
        await writeFile(target, 'a');
        mocks.crypto.hashFile.mockResolvedValue(Buffer.from(SHA_A, 'hex'));
        index.withOwnerRestore = vi.fn().mockRejectedValue(new Error('current target forbidden'));
        await expect(
          sut['restoreOwnerLibrary'](
            operationOf() as MediaOperation,
            'claim',
            {} as CloudBackupManifest,
            { owner: { ownerId: owner, sessionId: 'session' }, assetIds: ['asset-1'] } as CloudBackupRestoreSnapshot,
            [{ assetId: 'asset-1', role: 'original', inPlace: true, target, sha256: SHA_A } as never],
            emptyRestoreResult(),
          ),
        ).rejects.toThrow('current target forbidden');
        expect(index.withOwnerRestore).toHaveBeenCalledOnce();
        expect(mocks.crypto.hashFile).not.toHaveBeenCalled();
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });

    it('keeps a failed owner restore filename out of the public durable operation error', async () => {
      operations.fail.mockResolvedValue('failed');
      const operation = {
        id: 'owner-operation',
        kind: MediaOperationKind.CloudRestore,
        snapshot: { owner: { ownerId: owner } },
      } as unknown as MediaOperation;
      await sut['failTask'](
        operation,
        'claim',
        new Error('write failed /data/library/Locked-secret-name.jpg'),
        'Restore from cloud backup',
      );
      expect(operations.fail).toHaveBeenCalledWith(
        'owner-operation',
        'claim',
        expect.objectContaining({
          error:
            'The owner backup restore stopped. Already restored work is retained; check access and backup availability.',
          errorCode: 'cloud_restore_failed',
        }),
      );
    });

    it('queues only own bounded restore with a credentials-free immutable snapshot and allowlisted response', async () => {
      const elevated = { ...authStub.user1, session: { id: 'owner-session', hasElevatedPermission: true } };
      index.getOwnerRestoreIdentities.mockResolvedValue({});
      index.getAssetDetails.mockResolvedValue(new Map());
      const response = await sut.startOwnerRestore(
        elevated,
        { manifestKey, assetIds: ['asset-1'] },
        vi.fn().mockResolvedValue(elevated),
      );
      expect(Object.keys(response).sort()).toEqual(['operationId', 'status']);
      expect(operations.createExclusive).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: owner,
          settings: {},
          snapshot: expect.objectContaining({
            scope: 'asset',
            assetIds: ['asset-1'],
            owner: expect.objectContaining({ ownerId: owner, sessionId: 'owner-session' }),
          }),
        }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudBackup] },
      );
      expect(JSON.stringify(operations.createExclusive.mock.calls[0][0].snapshot)).not.toMatch(
        /token|password|bucketKey/i,
      );
    });
    it('refuses related album metadata changed after the immutable owner restore was submitted', async () => {
      const elevated = { ...authStub.user1, session: { id: 'owner-session', hasElevatedPermission: true } };
      index.getOwnerRestoreIdentities.mockResolvedValue({});
      index.getAssetDetails.mockResolvedValue(new Map());
      const backedUp = JSON.parse(
        gunzipSync(await (store.get as () => Promise<Buffer>)()).toString(),
      ) as CloudBackupManifest;
      backedUp.assets['asset-1'].details!.albums = [{ id: 'own-album', name: 'Original name' }];
      backedUp.albums['own-album'] = {
        name: 'Original name',
        description: '',
        ownerId: owner,
        coverAssetId: null,
        order: 'asc',
        sharedUsers: [],
      };
      store.get.mockResolvedValue(gzipSync(JSON.stringify(backedUp)));
      await sut.startOwnerRestore(
        elevated,
        { manifestKey, assetIds: ['asset-1'] },
        vi.fn().mockResolvedValue(elevated),
      );
      const snapshot = operations.createExclusive.mock.calls[0][0].snapshot as unknown as CloudBackupRestoreSnapshot;
      backedUp.albums['own-album'].name = 'Changed after submission';
      await expect(sut['checkOwnerRestoreItems'](elevated, backedUp, snapshot, true)).rejects.toThrow(
        'Backup item unavailable',
      );
    });

    it('refuses current external originals before creating an apparently supported owner restore', async () => {
      const elevated = { ...authStub.user1, session: { id: 'owner-session', hasElevatedPermission: true } };
      index.getOwnerRestoreIdentities.mockResolvedValue({
        'asset-1': {
          ownerId: owner,
          originalPath: '/external/Own.jpg',
          checksum: SHA_A,
          checksumAlgorithm: 'sha256',
          isExternal: true,
        },
      });
      index.getAssetDetails.mockResolvedValue(new Map());
      await expect(
        sut.startOwnerRestore(elevated, { manifestKey, assetIds: ['asset-1'] }, vi.fn().mockResolvedValue(elevated)),
      ).rejects.toThrow('external destination');
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('refuses duplicate and oversized owner selections before reading private backup metadata', async () => {
      for (const assetIds of [['asset-1', 'asset-1'], Array.from({ length: 101 }, (_, index) => `asset-${index}`)]) {
        await expect(sut.startOwnerRestore(authStub.user1, { manifestKey, assetIds }, refresh())).rejects.toThrow(
          'distinct',
        );
      }
      expect(store.get).not.toHaveBeenCalled();
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('refuses foreign selection, relocked session and unloaded key before queueing owner restore', async () => {
      const elevated = { ...authStub.user1, session: { id: 'owner-session', hasElevatedPermission: true } };
      index.getOwnerRestoreIdentities.mockResolvedValue({});
      index.getAssetDetails.mockResolvedValue(new Map());
      await expect(
        sut.startOwnerRestore(elevated, { manifestKey, assetIds: ['foreign-1'] }, vi.fn().mockResolvedValue(elevated)),
      ).rejects.toThrow('Backup item unavailable');
      await expect(sut.startOwnerRestore(elevated, { manifestKey, assetIds: ['asset-1'] }, refresh())).rejects.toThrow(
        'PIN',
      );
      keys.read.mockResolvedValue(null);
      await expect(
        sut.startOwnerRestore(elevated, { manifestKey, assetIds: ['asset-1'] }, vi.fn().mockResolvedValue(elevated)),
      ).rejects.toThrow('backup key file is missing');
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('projects only own history and owner-scoped discovery with no paths/global owners', async () => {
      const result = await sut.listOwnerHistory(authStub.user1, dto, refresh());
      expect(result.total).toBe(1);
      expect(JSON.stringify(result)).not.toMatch(/Secret|private|foreign|ownerName|bucket/);
      expect(index.getOwnerNames).not.toHaveBeenCalled();
      expect(await sut.listOwnerBackups(authStub.user1, { limit: 1, offset: 0 }, refresh())).toMatchObject({
        backups: [{ manifestKey }],
        nextOffset: null,
      });
    });
    it('lists backups without downloading a manifest that holds none of the owner’s restorable items', async () => {
      index.getOwnerBackupCandidates.mockResolvedValue(new Set());
      expect(await sut.listOwnerBackups(authStub.user1, { limit: 1, offset: 0 }, refresh())).toEqual({
        backups: [],
        nextOffset: null,
      });
      expect(store.get).not.toHaveBeenCalled();
      expect(index.getOwnerBackupCandidates).toHaveBeenCalledWith(expect.any(String), authStub.user1.user.id);
    });
    it('refuses revoked normal auth, shared links, changed owner, relock and pruned cached manifest', async () => {
      const revoked = refresh().mockRejectedValueOnce(new Error('revoked'));
      await expect(sut.listOwnerHistory(authStub.user1, dto, revoked)).rejects.toThrow('revoked');
      await expect(
        sut.listOwnerHistory(authStub.user1, dto, vi.fn().mockResolvedValue(authStub.adminSharedLink)),
      ).rejects.toThrow('Owner backup access');
      index.getOwnerHistoryState.mockResolvedValue(new Map([['asset-1', { ownerId: 'foreign', allowed: false }]]));
      expect((await sut.listOwnerHistory(authStub.user1, dto, refresh())).total).toBe(0);
      index.listKeptManifests.mockResolvedValue([]);
      await expect(sut.listOwnerHistory(authStub.user1, dto, refresh())).rejects.toThrow('not one of the kept backups');
    });
    it('rechecks privacy after thumbnail I/O and never returns stale authorized bytes', async () => {
      store.getPreview = vi.fn<() => Promise<Buffer>>(() => {
        index.getOwnerHistoryState.mockResolvedValue(new Map([['asset-1', { ownerId: owner, allowed: false }]]));
        return Promise.resolve(thumb);
      });
      await expect(sut.readOwnerThumbnail(authStub.user1, 'asset-1', manifestKey, refresh())).rejects.toThrow(
        'Backup preview unavailable',
      );
      expect(store.getPreview).toHaveBeenCalledWith(expect.anything(), `o/${thumbHash}`, key, thumbHash, thumb.length);
    });
    it('does not read foreign/missing thumbnails or disclose provider errors and requires a loaded key', async () => {
      await expect(sut.readOwnerThumbnail(authStub.user1, 'foreign-1', manifestKey, refresh())).rejects.toThrow(
        'Backup preview unavailable',
      );
      expect(store.getPreview).not.toHaveBeenCalled();
      store.getPreview.mockRejectedValueOnce(new Error('/private/provider-key'));
      await expect(sut.readOwnerThumbnail(authStub.user1, 'asset-1', manifestKey, refresh())).rejects.toThrow(
        'Backup preview unavailable',
      );
      keys.read.mockResolvedValue(null);
      await expect(sut.listOwnerHistory(authStub.user1, dto, refresh())).rejects.toThrow('backup key file is missing');
    });
  });

  describe('restore (FL-164)', () => {
    const manifestKey = 'm/20260926T030000Z.json.gz';
    const kept = {
      key: manifestKey,
      status: 'complete',
      databaseKey: dumpKey,
      createdAt: new Date('2026-09-26T03:00:00.000Z'),
      finishedAt: null,
      assetCount: 1,
      fileCount: 1,
      bytes: 100,
    };
    const manifestBody = gzipSync(
      JSON.stringify({
        format: 'frameleaf-backup-manifest',
        version: 1,
        instanceId: INSTANCE_ID,
        createdAt: '2026-09-26T03:00:00.000Z',
        database: { key: dumpKey, sha256: SHA_DUMP, size: 50 },
        assets: {
          'asset-1': {
            owner: 'owner-1',
            files: [{ role: 'original', path: '/data/library/IMG_1.jpg', sha256: SHA_A, size: 100, mtime: null }],
          },
        },
        profiles: {},
      }),
    );
    const restoreOperation = (scope: string, assetIds: string[] | null = null) =>
      operationOf({
        id: 'restore-1',
        kind: MediaOperationKind.CloudRestore,
        snapshot: { version: 1, bucketRef: ref, keyFingerprint: fingerprint, manifestKey, scope, assetIds },
      });

    beforeEach(() => {
      vi.mocked(link).mockResolvedValue(undefined);
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
      index.listKeptManifests.mockResolvedValue([kept]);
      store.get = vi.fn().mockResolvedValue(manifestBody);
      store.download = vi.fn().mockImplementation((_connection, _key, _bucketKey, _target, sha256: string) =>
        // the restorer checks the staged copy against the manifest: its size as well as its hash
        Promise.resolve({ size: sha256 === SHA_SIDECAR ? 5 : 100, sha256 }),
      );
    });

    afterEach(() => vi.mocked(link).mockReset());

    it('queues a restore under the bucket lock, named without the item, only from a kept backup', async () => {
      await expect(
        sut.startRestore(authStub.admin, { manifestKey: 'm/20250101T030000Z.json.gz', scope: 'files' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        sut.startRestore(authStub.admin, { manifestKey, scope: 'asset', assetIds: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await sut.startRestore(authStub.admin, {
        manifestKey,
        scope: 'asset',
        assetIds: ['8c5c3a24-2f65-4a8e-b3d4-3f1c3cb0c3e1'],
      });

      expect(operations.createExclusive).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.CloudRestore,
          label: 'Restore an item from cloud backup',
          snapshot: expect.objectContaining({ manifestKey, scope: 'asset' }),
        }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudBackup] },
      );
    });

    it('is refused while a backup operation holds the bucket', async () => {
      operations.createExclusive.mockResolvedValue({ active: { id: 'run-1', ownerId: 'admin', fingerprint: null } });

      await expect(sut.startRestore(authStub.admin, { manifestKey, scope: 'database' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('restores files into the restore folder as a cloud_restore operation, each checked by its hash', async () => {
      await sut.run(restoreOperation('files'), 'claim-1');

      expect(store.download).toHaveBeenCalledWith(
        expect.objectContaining({ bucket: s3.bucket }),
        `o/${SHA_A}`,
        key,
        // Downloaded beside the target, then published exclusively after its size and hash match.
        expect.stringMatching(/frameleaf\/restore\/restore-1\/asset-1\/\.cloud-restore-[\da-f-]+\.tmp$/),
        SHA_A,
      );
      expect(link).toHaveBeenCalledWith(
        vi.mocked(store.download).mock.calls[0][3],
        expect.stringMatching(/frameleaf\/restore\/restore-1\/asset-1\/original-IMG_1\.jpg$/),
      );
      expect(operations.complete).toHaveBeenCalledWith(
        'restore-1',
        'claim-1',
        { resultAssetId: null },
        undefined,
        true,
      );
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        lastRestore: { operationId: 'restore-1', scope: 'files', status: 'completed', files: 1 },
      });
    });

    it('single-item restore into a server whose key file doesn’t open the item reports "encrypted with an older key" instead of failing silently', async () => {
      const OWNER = '00000000-0000-4000-8000-000000000001';
      const previous = StorageCore.getMediaLocation();
      const media = await mkdtemp(join(tmpdir(), 'cloud-restore-older-key-'));
      try {
        StorageCore.setMediaLocation(media);
        // the person turned encryption off and on again: today's key file is a new key pair
        const older = generateLockedKeyPair();
        const current = generateLockedKeyPair();
        await mkdir(join(media, 'locked-keys'), { mode: 0o700 });
        await writeFile(
          join(media, 'locked-keys', `${OWNER}.json`),
          JSON.stringify({
            format: 'frameleaf-locked-key/1',
            userId: OWNER,
            publicKey: current.publicKey.toString('base64'),
            mode: 'pin',
            wraps: [],
          }),
          { mode: 0o600 },
        );
        const plain = join(media, 'plain.jpg');
        const sealed = join(media, 'sealed.jpg');
        await writeFile(plain, 'the photo');
        await encryptLockedFile(plain, sealed, [{ publicKey: older.publicKey }], {
          assetId: 'asset-1',
          kind: 'original',
          originalFileName: 'IMG_1.jpg',
          mime: 'image/jpeg',
        });
        const target = join(media, 'library', OWNER, 'IMG_1.jpg');
        await mkdir(join(media, 'library', OWNER), { recursive: true });
        store.get = vi.fn().mockResolvedValue(
          gzipSync(
            JSON.stringify({
              format: 'frameleaf-backup-manifest',
              version: 1,
              instanceId: INSTANCE_ID,
              createdAt: '2026-09-26T03:00:00.000Z',
              database: null,
              assets: {
                'asset-1': {
                  owner: OWNER,
                  files: [{ role: 'original', path: target, sha256: SHA_A, size: 100, mtime: null }],
                },
              },
              profiles: {},
            }),
          ),
        );
        // the verified download is published at the target: the backed-up ciphertext lands there
        vi.mocked(link).mockImplementation((_staged, to) => copyFileOf(sealed, String(to)));

        await sut.run(restoreOperation('asset', ['asset-1']), 'claim-1');

        expect(await isLockedFile(target)).toBe(true);
        expect(operations.complete).toHaveBeenCalled();
        expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
          lastRestore: { scope: 'asset', status: 'completed', files: 1, encryptedWithOlderKey: 1 },
        });
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('encrypted with an older key'));
      } finally {
        StorageCore.setMediaLocation(previous);
        await rm(media, { recursive: true, force: true });
      }
    });

    describe('Locked key files in a library restore (FL-721)', () => {
      const OWNER = '00000000-0000-4000-8000-000000000001';
      const backedUp =
        '{"format":"frameleaf-locked-key/1","userId":"00000000-0000-4000-8000-000000000001","publicKey":"b2xk","mode":"advanced","encrypting":false,"wraps":[{"kind":"passphrase"},{"kind":"recovery"}],"createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-02T00:00:00.000Z"}';
      let media: string;
      let previous: string;
      let livePath: string;

      beforeEach(async () => {
        previous = StorageCore.getMediaLocation();
        media = await mkdtemp(join(tmpdir(), 'cloud-restore-keys-'));
        StorageCore.setMediaLocation(media);
        livePath = join(media, 'locked-keys', `${OWNER}.json`);
        const keySha = hex(backedUp);
        store.get = vi.fn().mockResolvedValue(
          gzipSync(
            JSON.stringify({
              format: 'frameleaf-backup-manifest',
              version: 1,
              instanceId: INSTANCE_ID,
              createdAt: '2026-09-26T03:00:00.000Z',
              database: { key: dumpKey, sha256: SHA_DUMP, size: 50 },
              assets: {},
              profiles: {},
              lockedKeys: {
                [OWNER]: {
                  role: 'locked-key',
                  path: '/old/locked-keys/k.json',
                  sha256: keySha,
                  size: backedUp.length,
                  mtime: null,
                },
              },
            }),
          ),
        );
        const sizes = new Map([
          [keySha, backedUp.length],
          [SHA_DUMP, 50],
        ]);
        store.download = vi
          .fn()
          .mockImplementation(async (_connection, _key, _bucketKey, target: string, sha256: string) => {
            if (sha256 === keySha) {
              await writeFile(target, backedUp);
            }
            return { size: sizes.get(sha256) ?? 100, sha256 };
          });
        // the verified download is published at its target: the backed-up key file lands there
        vi.mocked(link).mockImplementation((staged, to) =>
          String(to).endsWith('.json') ? copyFileOf(String(staged), String(to)) : Promise.resolve(),
        );
        mocks.lockedEncryption.get.mockResolvedValue(undefined);
        mocks.lockedEncryption.create.mockResolvedValue({} as never);
        // what is on disk, and what it holds, for the key files only (the rest stays mocked)
        mocks.storage.checkFileExists.mockImplementation((path: string) =>
          stat(path)
            .then(() => true)
            .catch(() => false),
        );
        mocks.crypto.hashFile.mockImplementation(async (path: string | Buffer) =>
          String(path).endsWith('.json') || String(path).includes('.cloud-restore-')
            ? createHash('sha256')
                .update(await readFile(String(path)))
                .digest()
            : Buffer.from(hex(String(path).includes('dump') ? 'dump' : String(path)), 'hex'),
        );
      });

      afterEach(async () => {
        StorageCore.setMediaLocation(previous);
        await rm(media, { recursive: true, force: true });
      });

      it('with no live key file, makes the backed-up one live, matches its row and drops any loaded key', async () => {
        await sut.run(restoreOperation('library'), 'claim-1');

        expect(await readFile(livePath, 'utf8')).toBe(backedUp);
        expect(mocks.lockedEncryption.create).toHaveBeenCalledWith(
          expect.objectContaining({ userId: OWNER, mode: 'advanced', status: 'on' }),
        );
        expect(mocks.websocket.serverSend).toHaveBeenCalledWith('LockedKeyChanged', { userId: OWNER });
        expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
          lastRestore: { scope: 'library', status: 'completed' },
        });
        expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).not.toMatchObject({
          lastRestore: { lockedKeysKept: expect.anything() },
        });
      });

      it('keeps a live key file, puts the backed-up one in the replaced folder and says so', async () => {
        const live =
          '{"format":"frameleaf-locked-key/1","userId":"00000000-0000-4000-8000-000000000001","publicKey":"bmV3"}';
        await mkdir(join(media, 'locked-keys'), { mode: 0o700 });
        await writeFile(livePath, live, { mode: 0o600 });

        await sut.run(restoreOperation('library'), 'claim-1');

        expect(await readFile(livePath, 'utf8')).toBe(live);
        const kept = join(media, 'frameleaf', 'restore', 'replaced', 'restore-1', 'locked-keys', `${OWNER}.json`);
        expect(await readFile(kept, 'utf8')).toBe(backedUp);
        expect((await stat(kept)).mode & 0o777).toBe(0o600);
        expect(mocks.lockedEncryption.create).not.toHaveBeenCalled();
        expect(mocks.websocket.serverSend).not.toHaveBeenCalledWith('LockedKeyChanged', expect.anything());
        expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
          lastRestore: { scope: 'library', status: 'completed', lockedKeysKept: 1 },
        });
      });
    });

    it('records a restore cancelled at its end as cancelled, never as completed', async () => {
      operations.setBulkResult.mockResolvedValue({ ...running, cancelRequestedAt: new Date() });

      await sut.run(restoreOperation('asset', ['asset-1']), 'claim-1');

      expect(operations.acknowledgeCancel).toHaveBeenCalledWith('restore-1', 'claim-1', { released: false });
      expect(operations.complete).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ lastRestore: { status: 'cancelled' } });
    });

    it('stops with a report when an object does not match its checksum', async () => {
      store.download = vi.fn().mockRejectedValue(new CloudBackupStoreError('mismatch', null, 'ChecksumMismatch'));

      await sut.run(restoreOperation('files'), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'restore-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('does not match its checksum') }),
      );
      expect(operations.complete).not.toHaveBeenCalled();
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ lastRestore: { status: 'failed' } });
    });

    it('restores on bare metal from the newest backup, with the bucket and the key alone', async () => {
      metadata = {};
      store.listAll = vi
        .fn()
        .mockImplementation((_connection, prefix: string, onPage: (objects: unknown[]) => Promise<void>) =>
          prefix === 'm/'
            ? onPage([
                { key: 'm/20260925T030000Z.json.gz', size: 1, etag: null },
                { key: manifestKey, size: 1, etag: null },
                { key: 'm/notes.txt', size: 1, etag: null },
              ]).then(() => 3)
            : Promise.resolve(0),
        );
      const lines: string[] = [];

      const result = await sut.restoreFromBucket(
        { s3, key: key.toString('base64'), scope: 'files', restoreDatabase: false },
        (line) => {
          lines.push(line);
        },
      );

      expect(store.readMarker).toHaveBeenCalledWith(expect.objectContaining({ bucket: s3.bucket }), key);
      expect(store.get).toHaveBeenCalledWith(expect.anything(), manifestKey, key, undefined);
      expect(result).toMatchObject({ manifestKey, files: 1, databaseRestored: false });
      expect(lines.join('\n')).not.toContain(key.toString('base64'));
      expect(loadBackupWorkerIdentity).not.toHaveBeenCalled();
    });

    it('refuses a cached manifest after it stops being kept', async () => {
      await sut.listManifestItems({ manifestKey });
      index.listKeptManifests.mockResolvedValue([]);
      await expect(sut.listManifestItems({ manifestKey })).rejects.toThrow('not one of the kept backups');
    });

    it('lists the items a backup holds with whether each is still in the library', async () => {
      index.getLibraryState.mockResolvedValue(new Map());

      const found = await sut.listManifestItems({ manifestKey, query: 'img', filter: 'deleted' });

      expect(found).toEqual({
        manifestKey,
        total: 1,
        items: [
          expect.objectContaining({
            assetId: 'asset-1',
            name: 'IMG_1.jpg',
            state: 'deleted',
            bytes: 100,
            hasDetails: false,
          }),
        ],
      });
    });

    it('brings details back only for an item or an album', async () => {
      await expect(
        sut.startRestore(authStub.admin, { manifestKey, scope: 'files', details: 'fill' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.startRestore(authStub.admin, { manifestKey, scope: 'album' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('asks for a newer backup when this one was made before albums were recorded', async () => {
      await expect(
        sut.startRestore(authStub.admin, { manifestKey, scope: 'album', albumId: ALBUM_ID }),
      ).rejects.toThrow('made before albums were recorded');
    });

    describe('albums and details (manifest v2)', () => {
      const record = {
        type: 'IMAGE',
        originalFileName: 'IMG_1.jpg',
        fileCreatedAt: '2026-08-14T07:12:00.000Z',
        fileModifiedAt: '2026-08-14T07:12:00.000Z',
        localDateTime: '2026-08-14T09:12:00.000Z',
        duration: null,
      };
      const detailsOf = (stack: { id: string; isPrimary: boolean } | null = null) => ({
        isFavorite: true,
        visibility: 'timeline',
        rating: 5,
        description: 'Lake',
        dateTimeOriginal: null,
        timeZone: null,
        latitude: null,
        longitude: null,
        tags: [],
        albums: [{ id: ALBUM_ID, name: 'Lake house' }],
        faces: [],
        stack,
        edits: [],
      });
      const album = {
        name: 'Lake house',
        description: '',
        ownerId: 'owner-1',
        coverAssetId: 'asset-1',
        order: 'desc',
        sharedUsers: [],
      };
      const v2Body = gzipSync(
        JSON.stringify({
          format: 'frameleaf-backup-manifest',
          version: 2,
          instanceId: INSTANCE_ID,
          createdAt: '2026-09-26T03:00:00.000Z',
          database: null,
          assets: {
            'asset-1': {
              owner: 'owner-1',
              files: [
                { role: 'original', path: '/data/library/IMG_1.jpg', sha256: SHA_A, size: 100, mtime: null },
                { role: 'sidecar', path: '/data/library/IMG_1.jpg.xmp', sha256: SHA_SIDECAR, size: 5, mtime: null },
              ],
              ...record,
              details: detailsOf({ id: 'stack-1', isPrimary: true }),
            },
            'asset-2': {
              owner: 'owner-1',
              files: [{ role: 'original', path: '/data/library/IMG_2.jpg', sha256: SHA_B, size: 100, mtime: null }],
              ...record,
              originalFileName: 'IMG_2.jpg',
              details: detailsOf(),
            },
            'asset-3': {
              owner: 'owner-1',
              files: [{ role: 'original', path: '/data/library/IMG_3.jpg', sha256: SHA_C, size: 100, mtime: null }],
              ...record,
              details: { ...detailsOf(), albums: [] },
            },
          },
          profiles: {},
          albums: { [ALBUM_ID]: album },
          people: {},
        }),
      );
      const libraryAsset = {
        status: 'active',
        ownerId: 'owner-1',
        originalPath: '/data/library/IMG_2.jpg',
        isExternal: false,
        locked: false,
      };

      beforeEach(() => {
        store.get = vi.fn().mockResolvedValue(v2Body);
      });

      it('never names or finds by name a deleted item the backup recorded as Locked', async () => {
        const body = JSON.parse(gunzipSync(v2Body).toString());
        body.assets['asset-2'].details.visibility = 'locked';
        store.get = vi.fn().mockResolvedValue(gzipSync(JSON.stringify(body)));
        index.getLibraryState.mockResolvedValue(new Map());

        const listed = await sut.listManifestItems({ manifestKey });
        expect(listed.items.find(({ assetId }) => assetId === 'asset-2')).toMatchObject({ name: '', locked: true });
        await expect(sut.listManifestItems({ manifestKey, query: 'img_2' })).resolves.toMatchObject({ total: 0 });
      });

      it('queues an album restore with the album’s items from the backup and how their details come back', async () => {
        await sut.startRestore(authStub.admin, { manifestKey, scope: 'album', albumId: ALBUM_ID, details: 'fill' });

        expect(operations.createExclusive).toHaveBeenCalledWith(
          expect.objectContaining({
            label: 'Restore an album from cloud backup',
            snapshot: expect.objectContaining({
              scope: 'album',
              albumId: ALBUM_ID,
              assetIds: ['asset-1', 'asset-2'],
              details: 'fill',
            }),
          }),
          DatabaseLock.FrameleafCloudBackup,
          { alsoKinds: [MediaOperationKind.CloudBackup] },
        );
        await expect(
          sut.startRestore(authStub.admin, {
            manifestKey,
            scope: 'album',
            albumId: '0f0d1e2c-3b4a-4c5d-8e6f-7a8b9c0d1e2f',
          }),
        ).rejects.toThrow('does not hold the album');
      });

      it('restores an album: its deleted items made again, the others’ details back, then the album', async () => {
        index.getLibraryState = vi
          .fn()
          .mockImplementation((ids: string[]) =>
            Promise.resolve(new Map(ids.includes('asset-2') ? [['asset-2', libraryAsset]] : [])),
          );
        const current = { record, details: { ...detailsOf(), isFavorite: false, albums: [] } };
        index.getAssetDetails.mockResolvedValue(new Map([['asset-2', current]]));
        const operation = operationOf({
          id: 'restore-1',
          kind: MediaOperationKind.CloudRestore,
          snapshot: {
            version: 1,
            bucketRef: ref,
            keyFingerprint: fingerprint,
            manifestKey,
            scope: 'album',
            assetIds: ['asset-1', 'asset-2'],
            albumId: ALBUM_ID,
            details: 'replace',
          },
        });

        await sut.run(operation, 'claim-1');

        expect(details.recreate).toHaveBeenCalledOnce();
        expect(details.recreate).toHaveBeenCalledWith(
          expect.objectContaining({
            assetId: 'asset-1',
            ownerId: 'owner-1',
            record,
            sha256: SHA_A,
            originalPath: '/data/library/IMG_1.jpg',
            sidecarPath: '/data/library/IMG_1.jpg.xmp',
          }),
        );
        expect(details.putBack).toHaveBeenCalledWith(
          expect.objectContaining({ assetId: 'asset-2', mode: 'replace', current: current.details }),
        );
        expect(details.restoreStacks).toHaveBeenCalledWith([
          { assetId: 'asset-1', ownerId: 'owner-1', stack: { id: 'stack-1', isPrimary: true } },
        ]);
        expect(details.restoreAlbum).toHaveBeenCalledWith({
          albumId: ALBUM_ID,
          album,
          memberIds: ['asset-1', 'asset-2'],
        });
        expect(operations.complete).toHaveBeenCalledWith(
          'restore-1',
          'claim-1',
          { resultAssetId: null },
          undefined,
          true,
        );
        expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
          lastRestore: { scope: 'album', status: 'completed', recreated: 1, detailsRestored: 1 },
        });
      });

      it('keeps current details when asked, and gives a deleted item back as its owner’s copy of the same file', async () => {
        details.recreate.mockResolvedValue({ status: 'duplicate', assetId: 'asset-9' });
        const operation = operationOf({
          id: 'restore-1',
          kind: MediaOperationKind.CloudRestore,
          snapshot: {
            version: 1,
            bucketRef: ref,
            keyFingerprint: fingerprint,
            manifestKey,
            scope: 'album',
            assetIds: ['asset-1'],
            albumId: ALBUM_ID,
            details: 'keep',
          },
        });

        await sut.run(operation, 'claim-1');

        expect(details.putBack).not.toHaveBeenCalled();
        expect(details.restoreAlbum).toHaveBeenCalledWith(expect.objectContaining({ memberIds: ['asset-9'] }));
      });

      it('lists deleted albums and albums missing items, by name', async () => {
        index.getAlbumMembers.mockResolvedValue(new Map());
        index.getOwnerNames.mockResolvedValue(new Map([['owner-1', 'Taylor']]));

        await expect(sut.listManifestAlbums({ manifestKey })).resolves.toEqual({
          manifestKey,
          hasDetails: true,
          albums: [
            {
              albumId: ALBUM_ID,
              name: 'Lake house',
              ownerId: 'owner-1',
              ownerName: 'Taylor',
              items: 2,
              missing: 2,
              state: 'deleted',
            },
          ],
        });

        index.getAlbumMembers.mockResolvedValue(new Map([[ALBUM_ID, new Set(['asset-1'])]]));
        sut['manifestCache'] = undefined;
        await expect(sut.listManifestAlbums({ manifestKey })).resolves.toMatchObject({
          albums: [{ state: 'missing-items', missing: 1 }],
        });

        index.getAlbumMembers.mockResolvedValue(new Map([[ALBUM_ID, new Set(['asset-1', 'asset-2'])]]));
        sut['manifestCache'] = undefined;
        await expect(sut.listManifestAlbums({ manifestKey })).resolves.toMatchObject({ albums: [] });
      });
    });
  });

  describe('client recovery regressions', () => {
    let directory: string;
    let fixture: ReturnType<typeof recoveryFixture>;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'client-recovery-service-'));
      fixture = recoveryFixture();
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir: directory } }),
      );
      mocks.instanceIdentity.loadOrCreate.mockResolvedValue({ ...instance, instanceId: fixture.vaultId } as never);
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ instanceId: fixture.vaultId });
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(JSON.stringify(fixture.file));
      store.readMarker.mockResolvedValue({ instanceId: fixture.vaultId });
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    const manifestBytes = (vaultId: string, version = 3) =>
      gzipSync(
        JSON.stringify({
          format: 'frameleaf-backup-manifest',
          version,
          instanceId: vaultId,
          createdAt: '2026-10-11T00:00:00.000Z',
          database: null,
          assets: {},
          profiles: {},
          albums: {},
          people: {},
        }),
      );

    const batch = () => {
      sut['readClientKeys'](JSON.stringify(fixture.file), key, fixture.vaultId);
      return {
        id: 'run-1',
        claimToken: 'claim-1',
        operation: operationOf(),
        metadata: claim({ instanceId: fixture.vaultId }),
        connection: { ...s3, vaultId: fixture.vaultId, recoveryKeys: fixture.file.client.keys },
        bucketKey: key,
        clientKeys: structuredClone(fixture.file.client),
        uploadedNow: new Set<string>(),
        eligibleOwners: null,
        decided: false,
        progress: {
          result: {
            ...emptyRunResult(),
            manifestId: MANIFEST_ID,
            manifestKey: fixture.first.descriptor.manifest.objectKey,
          },
        },
      };
    };

    const fileBatch = () => [
      {
        fileKey: 'asset-1:original',
        assetId: 'asset-1',
        ownerId: 'owner-1',
        role: 'original',
        path: '/data/library/asset-1.jpg',
        recorded: { sha256: SHA_A, size: 100, verifiedAt: new Date('2026-10-11T00:00:00.000Z') },
      },
    ];

    it('uploads only the client address, and records only its own receipt', async () => {
      const present = new Set<string>();
      store.hashObject = vi.fn().mockRejectedValue(new CloudBackupStoreError('missing', 404, 'NoSuchKey'));
      store.head = vi
        .fn()
        .mockImplementation((_connection, object) =>
          Promise.resolve(present.has(object) ? { size: 100, etag: 'etag' } : null),
        );
      store.uploadFile.mockImplementation((_connection, object) => {
        present.add(object);
        return Promise.resolve({ size: 100, etag: 'etag' });
      });
      await sut['backUpFiles'](batch(), fileBatch());
      // a client upload leaves only this server's receipt, never a row of the bucket's shared index
      expect(index.record).not.toHaveBeenCalledWith(ref, expect.anything());
      expect(index.record).toHaveBeenCalledWith(`${ref}#client-v1`, [{ sha256: SHA_A, size: 100, etag: 'etag' }]);
      expect(uploadedKeys()).toEqual([
        clientBackupObjectKey(Buffer.from(fixture.file.client.keys[1], 'base64'), fixture.vaultId, 1, SHA_A),
      ]);
    });

    it('skips a client object its own upload receipt still names, without downloading it again', async () => {
      const run = batch();
      const object = clientBackupObjectKey(
        Buffer.from(fixture.file.client.keys[1], 'base64'),
        fixture.vaultId,
        1,
        SHA_A,
      );
      index.getRecorded.mockResolvedValue(new Map([[SHA_A, { size: 100, etag: '"uploaded"' }]]));
      store.head = vi.fn().mockResolvedValue({ key: object, size: 100, etag: '"uploaded"' });
      store.hashObject = vi.fn();

      await sut['backUpFiles'](run, fileBatch());

      expect(index.getRecorded).toHaveBeenCalledWith(`${ref}#client-v1`, [SHA_A]);
      expect(store.head).toHaveBeenCalledWith(run.connection, object, key);
      expect(store.hashObject).not.toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();

      // a replaced object (another ETag) is read in full again
      store.head = vi.fn().mockResolvedValue({ key: object, size: 100, etag: '"replaced"' });
      store.hashObject = vi.fn().mockResolvedValue({ size: 100, sha256: SHA_A });
      await sut['backUpFiles'](batch(), fileBatch());
      expect(store.hashObject).toHaveBeenCalledOnce();
      expect(index.record).toHaveBeenCalledWith(`${ref}#client-v1`, [{ sha256: SHA_A, size: 100, etag: '"replaced"' }]);
    });

    it('repairs failed client authentication even when a same-size object still exists', async () => {
      const run = batch();
      const object = clientBackupObjectKey(
        Buffer.from(fixture.file.client.keys[1], 'base64'),
        fixture.vaultId,
        1,
        SHA_A,
      );
      store.head = vi.fn().mockResolvedValue({ size: 100, etag: 'unchanged-length' });
      store.hashObject = vi
        .fn()
        .mockRejectedValue(new CloudBackupStoreError('authentication failed', null, 'ChecksumMismatch'));
      const bad = await sut['maintenance']['checkObject'](
        { bucketRef: ref, connection: run.connection, bucketKey: key },
        SHA_A,
        100,
        'sample',
        object,
      );
      expect(bad).toBe('mismatched');
      await sut['maintenance']['settleBad'](
        { bucketRef: ref, connection: run.connection, bucketKey: key },
        [SHA_A],
        new Set(),
      );
      await sut['backUpFiles'](run, fileBatch());
      expect(index.forget).toHaveBeenCalledWith(ref, [SHA_A]);
      expect(uploadedKeys()).toEqual([object]);
      expect(index.record).not.toHaveBeenCalledWith(ref, expect.anything());
      store.hashObject.mockResolvedValue({ size: 100, sha256: SHA_A });
      await sut['backUpFiles'](batch(), fileBatch());
      expect(store.uploadFile).toHaveBeenCalledOnce();
    });

    it.each(['byo-s3', 'managed'] as const)(
      'keeps the established %s anchor when an older kit is supplied to restore or export',
      async (target) => {
        const managed = managedGrantFixture('backup/grant-rotate-response.json');
        const source =
          target === 'managed'
            ? { ...s3, endpoint: managed.endpoint, region: managed.region, bucket: managed.bucket }
            : s3;
        const binding = target === 'managed' ? managedStorageRef(managed.storageId) : ref;
        metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
          target,
          bucketRef: binding,
          instanceId: fixture.vaultId,
          endpoint: source.endpoint,
          bucket: source.bucket,
          ...(target === 'managed' && {
            region: managed.region,
            managed: {
              storageId: managed.storageId,
              location: managed.location,
              readOnly: false,
              readOnlyReason: null,
              quotaBytes: managed.quotaBytes,
              checkedAt: '2026-10-11T00:00:00.000Z',
            },
          }),
        });
        if (target === 'managed') {
          const cloudUrl = 'https://cloud.frameleaf.test';
          mocks.config.getEnv.mockReturnValue(
            mockEnvData({
              frameleafCloud: {
                ...mockEnvData({}).frameleafCloud,
                identityDir: directory,
                url: cloudUrl,
              },
            }),
          );
          metadata[SystemMetadataKey.FrameleafCloudLink] = { status: 'linked', cloudUrl, instanceId: fixture.vaultId };
          mocks.frameleafCloud.discovery.mockResolvedValue({ api: 'https://api.frameleaf.test' } as never);
          mocks.frameleafCloud.accessToken.mockResolvedValue({ accessToken: 'token' } as never);
          cloudBackup.rotate.mockResolvedValue({
            ...managed,
            capability: { ...managed.capability, operation: 'restore' },
          });
        }
        await writeBackupHistory(sut['clientHistoryPath'](binding), fixture.history);
        const bytes = manifestBytes(fixture.vaultId);
        store.get.mockResolvedValue(bytes);
        store.exportObject = vi.fn().mockResolvedValue(undefined);
        store.hashObject = vi
          .fn()
          .mockResolvedValue({ sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
        const options = {
          s3: source,
          key: JSON.stringify({ ...fixture.file, bucket: source.bucket, recovery: fixture.older }),
          scope: 'files' as const,
          restoreDatabase: false,
        };
        const restored = await sut.restoreFromBucket(options, vi.fn());
        expect(restored.manifestKey).toBe(fixture.second.descriptor.manifest.objectKey);
        const exportOptions =
          target === 'managed'
            ? { managed: true as const, key: options.key, scope: options.scope, restoreDatabase: false }
            : options;
        const exported = await sut.exportFromBucket(exportOptions, join(directory, 'export'));
        expect(exported.manifestKey).toBe(restored.manifestKey);
        const kit = JSON.parse(await readFile(join(directory, 'export', 'key-file.json'), 'utf8'));
        expect(kit.recovery.anchor).toEqual(fixture.history.anchor);
        const conflicting = appendBackupSnapshot(null, fixture.snapshot(1, null, 'conflicting-version'));
        const poisoned = {
          ...options,
          key: JSON.stringify({ ...fixture.file, bucket: source.bucket, recovery: conflicting }),
        };
        await expect(sut.restoreFromBucket(poisoned, vi.fn())).rejects.toThrow('conflicts with the local anchor');
        await expect(
          sut.exportFromBucket({ ...exportOptions, key: poisoned.key }, join(directory, 'conflict')),
        ).rejects.toThrow('conflicts with the local anchor');
      },
    );

    it.each([false, true])(
      'retains imported authority across an immediate setup restart (existing file: %s)',
      async (existing) => {
        const repository = new CloudBackupKeyRepository(mocks.logger as never);
        keys.read.mockImplementation(repository.read.bind(repository));
        keys.write.mockImplementation(repository.write.bind(repository));
        if (existing)
          await repository.write(directory, fingerprint, JSON.stringify({ ...fixture.file, recovery: fixture.older }));
        store.claim.mockResolvedValue({ existing: true, claimedAt: '2026-10-11T00:00:00.000Z' });
        await sut.setup(authStub.admin, {
          target: 'byo-s3',
          s3,
          keyMode: 'own-stored',
          key: JSON.stringify({ ...fixture.file, recovery: fixture.history }),
        });
        const stored = JSON.parse((await repository.read(directory, fingerprint))!);
        expect(stored.recovery).toEqual(fixture.history);
        const restarted = build();
        const metadata = claim({ instanceId: fixture.vaultId, keyMode: 'own-stored' });
        expect((await restarted['loadKey'](metadata))!.equals(key)).toBe(true);
        const connection = { ...s3, trustedManifestHead: undefined as string | undefined };
        await restarted['attachClientHistory'](connection, metadata);
        expect(connection.trustedManifestHead).toBe(fixture.second.descriptor.manifest.objectKey);
      },
    );

    it.each(['historical client', 'legacy from mixed history'])(
      'restores the exported %s snapshot by default while retaining its latest anchor',
      async (selection) => {
        const selected =
          selection === 'historical client'
            ? fixture.first.descriptor.manifest.objectKey
            : 'm/20260926T030000Z.json.gz';
        const bytes = manifestBytes(fixture.vaultId, selection === 'historical client' ? 3 : 2);
        const exportedObjects = new Set<string>();
        store.get.mockImplementation((connection, object) => {
          if (object !== selected || (connection.offlineDirectory && !exportedObjects.has(object)))
            return Promise.reject(new CloudBackupStoreError('not exported', 404, 'NoSuchKey'));
          return Promise.resolve(bytes);
        });
        store.exportObject = vi.fn().mockImplementation((_connection, object) => {
          exportedObjects.add(object);
          return Promise.resolve();
        });
        store.hashObject = vi
          .fn()
          .mockResolvedValue({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        const destination = join(directory, 'export');
        await sut.exportFromBucket(
          {
            s3,
            key: JSON.stringify({ ...fixture.file, recovery: fixture.history }),
            manifestKey: selected,
            scope: 'files',
            restoreDatabase: false,
          },
          destination,
        );
        const kit = await readFile(join(destination, 'key-file.json'), 'utf8');
        expect(JSON.parse(kit).recovery.anchor).toEqual(fixture.history.anchor);
        const restored = await sut.restoreFromBucket(
          {
            s3: { ...s3, accessKeyId: '', secretAccessKey: '' },
            key: kit,
            offlineDirectory: destination,
            scope: 'files',
            restoreDatabase: false,
          },
          vi.fn(),
        );
        expect(restored.manifestKey).toBe(selected);
        expect(store.readMarker).toHaveBeenCalledOnce();
        expect(store.listAll).not.toHaveBeenCalled();
      },
    );

    it('reclaims the checkpointed database identity and original write version after interruption', async () => {
      const row = { id: MANIFEST_ID, key: fixture.first.descriptor.manifest.objectKey };
      index.createManifest.mockResolvedValue(row);
      let checkpoint: Record<string, unknown> | undefined;
      operations.setBulkResult.mockImplementation((_id, _token, value) => {
        checkpoint = structuredClone(value.result);
        return Promise.resolve(
          value.result.phase === 'reconcile' ? { ...running, pauseRequestedAt: new Date() } : running,
        );
      });
      operations.fail.mockResolvedValue('retrying');
      store.uploadFile.mockImplementationOnce(() => {
        expect(checkpoint).toMatchObject({
          phase: 'database',
          manifestId: row.id,
          manifestKey: row.key,
          database: { sha256: SHA_DUMP },
        });
        return Promise.reject(new CloudBackupStoreError('connection interrupted', null, null));
      });
      await sut.run(operationOf(), 'claim-1');
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
      const pending = checkpoint!;
      const firstRequest = store.uploadFile.mock.calls[0];
      expect(firstRequest[1]).toContain(`/1/`);
      index.getManifest.mockResolvedValue(row);
      keys.read.mockResolvedValue(
        JSON.stringify({ ...fixture.file, client: rotateClientBackupKeys(fixture.file.client, key) }),
      );
      const restarted = build();
      await restarted.run(operationOf({ result: pending } as never), 'claim-2');
      expect(store.uploadFile.mock.calls[1].slice(1)).toEqual(firstRequest.slice(1));
      expect(databaseBackup.createDatabaseBackup).toHaveBeenCalledOnce();
      expect(mocks.crypto.hashFile).toHaveBeenCalledOnce();
      // the backups folder is read once for leftover dumps (the transfer folders are swept on every open)
      expect(
        mocks.storage.readdir.mock.calls.filter(([folder]) => !folder.endsWith('cloud-backup-transfers')),
      ).toHaveLength(1);
      expect(checkpoint).toMatchObject({ phase: 'reconcile', database: { key: firstRequest[1] } });
    });
  });

  describe('FL-234 owner setup progress', () => {
    const grant = managedGrantFixture('backup/grant-response.json');
    const cloudUrl = 'https://cloud.frameleaf.test';
    const managedRef = bucketRef(grant.endpoint, grant.bucket);
    const managedClaim = (overrides: CloudBackupClaimOverrides = {}) =>
      claim({ target: 'managed', bucketRef: managedRef, endpoint: grant.endpoint, bucket: grant.bucket, ...overrides });
    const ALLOWED = ['bucketClaimed', 'claimedAt', 'entitlement', 'firstRun', 'keyLoaded', 'nextRunAt', 'target'];
    const useManaged = ({ linked }: { linked: boolean }) => {
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir, url: cloudUrl } }),
      );
      if (linked) {
        metadata[SystemMetadataKey.FrameleafCloudLink] = { status: 'linked', cloudUrl, instanceId: INSTANCE_ID };
      }
      metadata[SystemMetadataKey.SystemConfig] = {
        frameleafCloud: { cloudBackup: { enabled: true, target: 'managed', keyMode: 'server' } },
      };
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reports nothing started before setup', async () => {
      const setup = await sut.getOwnerSetup(authStub.admin);

      expect(setup).toEqual({
        target: 'off',
        entitlement: 'not-applicable',
        bucketClaimed: false,
        claimedAt: null,
        keyLoaded: false,
        firstRun: 'not-started',
        nextRunAt: null,
      });
      expect(cloudBackup.usage).not.toHaveBeenCalled();
    });

    it('reports an own bucket claimed, its key loaded and a first run in progress', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
      operations.getActiveOfKind.mockResolvedValue({ id: 'run-1' });
      operations.getOfKind.mockResolvedValue(operationOf({ status: MediaOperationStatus.Rendering }));

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({
        target: 'byo-s3',
        entitlement: 'not-applicable',
        bucketClaimed: true,
        claimedAt: '2026-09-25T00:00:00.000Z',
        keyLoaded: true,
        firstRun: 'running',
      });
    });

    it('reports a queued first run as queued', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      operations.getActiveOfKind.mockResolvedValue({ id: 'run-1' });
      operations.getOfKind.mockResolvedValue(operationOf({ status: MediaOperationStatus.Queued }));

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({ firstRun: 'queued' });
    });

    it('keeps the entitlement pending while managed storage waits for a link', async () => {
      useManaged({ linked: false });

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({
        target: 'managed',
        entitlement: 'pending',
        bucketClaimed: false,
      });
    });

    it('keeps the entitlement pending when Frameleaf Cloud refused it for the plan', async () => {
      useManaged({ linked: true });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim();
      keys.read.mockResolvedValue(keyFileOf());
      mocks.frameleafCloud.discovery.mockResolvedValue({ api: 'https://api.frameleaf.test' } as never);
      mocks.frameleafCloud.accessToken.mockResolvedValue({ accessToken: 'token' } as never);
      cloudBackup.rotate.mockRejectedValue(
        new FrameleafCloudError(
          MlAdmissionRefusal.CloudUnavailable,
          403,
          'entitlement',
          errorEnvelopeSchema.parse(cloudContractFixture('errors/entitlement-missing.json')),
        ),
      );
      await sut.run(operationOf({ snapshot: { version: 1, bucketRef: managedRef, keyFingerprint: fingerprint } }), 'c');

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({
        entitlement: 'pending',
        bucketClaimed: true,
      });
    });

    it('tells the safety status that managed storage is paused for a full plan (FL-301)', async () => {
      useManaged({ linked: true });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({
        managed: { readOnly: true, readOnlyReason: 'plan_full', quotaBytes: 1, checkedAt: '2020-01-01T00:00:00.000Z' },
      });
      keys.read.mockResolvedValue(keyFileOf());

      await expect(sut.getSafetyAvailability()).resolves.toMatchObject({
        readOnly: true,
        readOnlyReason: 'plan_full',
      });
    });

    it('reports the entitlement seen once managed storage is linked and not refused, without asking Cloud', async () => {
      useManaged({ linked: true });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({
        managed: {
          readOnly: false,
          readOnlyReason: null,
          quotaBytes: 1,
          checkedAt: '2020-01-01T00:00:00.000Z',
          usage: { measuredAt: null, bytesCurrent: 0, objects: 0, allowanceBytes: 1, extraBlocks: 0 },
        },
      });

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({ entitlement: 'seen' });
      expect(cloudBackup.usage).not.toHaveBeenCalled();
      expect(mocks.frameleafCloud.discovery).not.toHaveBeenCalled();
    });

    it('reports the first run done once any backup succeeded', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastSuccessAt: '2026-09-26T04:00:00.000Z',
        lastRun: { operationId: 'run-2', status: 'failed', startedAt: '2026-09-27T04:00:00.000Z', error: 'x' },
      });
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      operations.getActiveOfKind.mockResolvedValue({ id: 'run-3' });
      operations.getOfKind.mockResolvedValue(operationOf({ status: MediaOperationStatus.Rendering }));

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({ firstRun: 'done' });
    });

    it('reports a first run that failed', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastRun: { operationId: 'run-1', status: 'failed', startedAt: '2026-09-26T04:00:00.000Z', error: 'IMG_1.jpg' },
      });
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({ firstRun: 'failed' });
    });

    it('computes the next scheduled run from the configured schedule', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-15T12:00:00.000Z') });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = {
        frameleafCloud: {
          cloudBackup: { ...enabledConfig().frameleafCloud.cloudBackup, schedule: { cronExpression: '0 4 * * *' } },
        },
      };

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({
        nextRunAt: '2026-06-16T04:00:00.000Z',
      });
    });

    it("computes the next scheduled run on the server's chosen time zone (FL-426)", async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-15T12:00:00.000Z') });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = {
        server: { timeZone: 'America/Edmonton' },
        frameleafCloud: {
          cloudBackup: { ...enabledConfig().frameleafCloud.cloudBackup, schedule: { cronExpression: '0 4 * * *' } },
        },
      };

      // 04:00 in Edmonton in June (UTC−06:00)
      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({
        nextRunAt: '2026-06-16T10:00:00.000Z',
      });
    });

    it('has no next run while cloud backup is turned off', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = {
        frameleafCloud: { cloudBackup: { ...enabledConfig().frameleafCloud.cloudBackup, enabled: false } },
      };

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({ target: 'off', nextRunAt: null });
    });

    it('refuses a user who is not the server owner', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();

      await expect(sut.getOwnerSetup(authStub.user1)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.systemMetadata.get).not.toHaveBeenCalled();
    });

    it('exposes only the setup fields, never bucket, key, usage or error details', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastRun: { operationId: 'run-1', status: 'failed', startedAt: '2026-09-26T04:00:00.000Z', error: 'IMG_1.jpg' },
      });
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());

      const setup = await sut.getOwnerSetup(authStub.admin);

      expect(Object.keys(setup).sort()).toEqual(ALLOWED);
      const text = JSON.stringify(setup);
      for (const secret of [s3.bucket, s3.endpoint, 'eu-central-2', INSTANCE_ID, fingerprint, 'IMG_1.jpg', 'run-1']) {
        expect(text).not.toContain(secret);
      }
    });
  });
});
