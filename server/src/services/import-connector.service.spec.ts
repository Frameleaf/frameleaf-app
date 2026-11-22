import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { FrameleafEnvironment, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { FAKE_PROVIDER, fakeRemoteSourceProvider } from 'src/import-connectors/fake.source.js';
import {
  RemoteSourceAuthError,
  registerRemoteSource,
  remoteSourceProviders,
  unregisterRemoteSource,
} from 'src/import-connectors/remote-source.js';
import { ImportConnection } from 'src/repositories/import-connector.repository.js';
import { TakeoutImport } from 'src/repositories/takeout.repository.js';
import { ImportConnectorService } from 'src/services/import-connector.service.js';
import { TAKEOUT_DEFAULT_OPTIONS, TakeoutPhase } from 'src/utils/takeout.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newAccessRepositoryMock } from 'test/repositories/access.repository.mock.js';

const ownerId = authStub.user1.user.id;
const connectionId = '0195e2a0-0000-7000-8000-0000000000c0';
const runId = '0195e2a0-0000-7000-8000-000000000001';
const SECRET = 'hunter2-app-password';

const connectionOf = (overrides: Partial<ImportConnection> = {}): ImportConnection => ({
  id: connectionId,
  ownerId,
  provider: FAKE_PROVIDER,
  displayName: 'My Nextcloud',
  sealedCredentials: Buffer.from('sealed'),
  roots: ['Trips'],
  dailyCheck: true,
  cursor: { secretCursor: true },
  lastScanAt: new Date('2027-02-01T08:00:00.000Z'),
  status: 'active',
  createdAt: new Date('2027-01-01T00:00:00.000Z'),
  updatedAt: new Date('2027-01-01T00:00:00.000Z'),
  ...overrides,
});

const runOf = (phase: TakeoutPhase, overrides: Partial<TakeoutImport> = {}): TakeoutImport => ({
  id: runId,
  ownerId,
  name: 'My Nextcloud',
  phase,
  options: { ...TAKEOUT_DEFAULT_OPTIONS },
  runOperationId: null,
  connectionId,
  createdAt: new Date('2027-02-01T08:00:00.000Z'),
  updatedAt: new Date('2027-02-01T08:00:00.000Z'),
  ...overrides,
});

const operationOf = (action: 'scan' | 'import', status: MediaOperationStatus) => ({
  id: '0195e2a0-0000-7000-8000-0000000000aa',
  status,
  snapshot: { importId: runId, action },
  processedUnits: 3,
  totalUnits: 4,
  error: null,
  errorCode: null,
});

describe(ImportConnectorService.name, () => {
  let sut: ImportConnectorService;
  let repository: Record<string, any>;
  let takeout: Record<string, any>;
  let mediaOperations: Record<string, any>;
  let access: ReturnType<typeof newAccessRepositoryMock>;
  let logger: Record<string, any>;
  let environment: FrameleafEnvironment;

  beforeEach(() => {
    registerRemoteSource(fakeRemoteSourceProvider);
    environment = FrameleafEnvironment.Production;
    repository = {
      create: vi.fn((values: Partial<ImportConnection>) => Promise.resolve(connectionOf({ ...values, cursor: null }))),
      list: vi.fn().mockResolvedValue([connectionOf()]),
      get: vi.fn((owner: string, id: string) =>
        Promise.resolve(owner === ownerId && id === connectionId ? connectionOf() : undefined),
      ),
      importedCounts: vi.fn().mockResolvedValue(new Map([[connectionId, 7]])),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue('deleted'),
      statistics: vi.fn().mockResolvedValue([
        { provider: 'dropbox', connections: 2, dailyCheck: 1 },
        { provider: 'webdav', connections: 3, dailyCheck: 3 },
      ]),
      startScan: vi.fn().mockResolvedValue({ importId: runId }),
      retryFailed: vi.fn().mockResolvedValue(0),
      counts: vi.fn().mockResolvedValue({ states: { ready: 2, imported: 1, matched: 1, failed: 1 }, hiddenLocked: 1 }),
      albums: vi.fn().mockResolvedValue([{ folder: 'Trips/Italy', count: 2 }]),
      items: vi.fn().mockResolvedValue({ items: [], total: 0, hiddenLocked: 0 }),
    };
    takeout = {
      get: vi.fn((owner: string, id: string, connector: boolean) =>
        Promise.resolve(owner === ownerId && id === runId && connector ? runOf('review') : undefined),
      ),
      listForConnection: vi.fn().mockResolvedValue([runOf('review')]),
      latestOperations: vi
        .fn()
        .mockResolvedValue([{ importId: runId, operation: operationOf('scan', MediaOperationStatus.Completed) }]),
      sources: vi.fn().mockResolvedValue([
        {
          id: 'source',
          name: 'My Nextcloud',
          kind: 'directory',
          path: '',
          size: 0,
          received: 0,
          scanned: true,
          rejected: 2,
        },
      ]),
      withImport: vi.fn(
        (_owner: string, _id: string, fn: (tx: unknown, row: TakeoutImport, operation: unknown) => Promise<unknown>) =>
          fn({}, runOf('review'), operationOf('scan', MediaOperationStatus.Completed)),
      ),
      setOptions: vi.fn(),
      setPhase: vi.fn(),
      insertOperation: vi.fn(),
    };
    mediaOperations = { pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
    access = newAccessRepositoryMock();
    logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sut = new ImportConnectorService(
      logger as never,
      repository as never,
      takeout as never,
      mediaOperations as never,
      access as never,
      { randomUUID: () => connectionId, serverKeyedHash: vi.fn().mockResolvedValue('keyed-hash') } as never,
      { getEnv: () => ({ environment, frameleafCloud: { identityDir: '/identity' } }) } as never,
    );
  });

  afterEach(() => {
    unregisterRemoteSource(FAKE_PROVIDER);
  });

  const everythingSaid = (...answers: unknown[]) =>
    JSON.stringify([answers, Object.values(logger).flatMap((fn) => fn.mock.calls)]);

  describe('the test source', () => {
    it('is registered only on a server started for tests', () => {
      unregisterRemoteSource(FAKE_PROVIDER);
      sut.onBootstrap();
      expect(remoteSourceProviders()).not.toContain(FAKE_PROVIDER);
      expect(remoteSourceProviders()).toContain('webdav');

      environment = FrameleafEnvironment.Testing;
      sut.onBootstrap();
      expect(sut.providers()).toEqual({ providers: [FAKE_PROVIDER, 'webdav'] });
    });
  });

  describe('credentials', () => {
    it('seals them on create and never returns or logs them', async () => {
      const created = await sut.create(authStub.user1, {
        provider: FAKE_PROVIDER,
        displayName: 'My Nextcloud',
        credentials: { token: SECRET, files: [] },
        roots: [],
        dailyCheck: false,
      });

      const stored = repository.create.mock.calls[0][0];
      expect(stored).toMatchObject({ id: connectionId, ownerId, provider: FAKE_PROVIDER });
      expect(Buffer.isBuffer(stored.sealedCredentials)).toBe(true);
      expect(stored.sealedCredentials.toString('latin1')).not.toContain(SECRET);
      expect(Object.keys(created).toSorted()).toEqual([
        'createdAt',
        'dailyCheck',
        'displayName',
        'id',
        'importedItems',
        'lastScanAt',
        'provider',
        'roots',
        'status',
        'updatedAt',
      ]);
      expect(everythingSaid(created)).not.toContain(SECRET);
    });

    it('returns no credentials, sealed or not, and no cursor from any read', async () => {
      const answers = [
        await sut.list(authStub.user1),
        await sut.get(authStub.user1, connectionId),
        await sut.runs(authStub.user1, connectionId),
        await sut.run(authStub.user1, connectionId, runId),
        await sut.statistics(),
      ];
      const said = everythingSaid(answers);
      expect(said).not.toContain('sealed');
      expect(said).not.toContain(Buffer.from('sealed').toString('base64'));
      expect(said).not.toContain('secretCursor');
    });

    it('refuses a sign-in the source does not accept, in the source’s own words only', async () => {
      await expect(
        sut.create(authStub.user1, {
          provider: FAKE_PROVIDER,
          displayName: 'x',
          credentials: { token: 'expired', files: [] },
          roots: [],
          dailyCheck: false,
        }),
      ).rejects.toThrow(new BadRequestException('The fake source no longer accepts this sign-in'));
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('answers in general terms, and logs no detail, when a source fails in a way it did not describe', async () => {
      registerRemoteSource({
        provider: FAKE_PROVIDER,
        credentials: () => {
          throw new Error(`POST https://user:${SECRET}@example.com refused`);
        },
        open: fakeRemoteSourceProvider.open,
      });
      const refusal = await sut
        .create(authStub.user1, {
          provider: FAKE_PROVIDER,
          displayName: 'x',
          credentials: { token: SECRET },
          roots: [],
          dailyCheck: false,
        })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(BadRequestException);
      expect(everythingSaid((refusal as Error).message)).not.toContain(SECRET);
    });

    it('refuses a kind of source this server does not have', async () => {
      await expect(
        sut.create(authStub.user1, {
          provider: 'dropbox',
          displayName: 'x',
          credentials: {},
          roots: [],
          dailyCheck: false,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets only an administrator allow a home-network address, before anything is contacted', async () => {
      const opened = vi.spyOn(fakeRemoteSourceProvider, 'open');
      await expect(
        sut.create(authStub.user1, {
          provider: FAKE_PROVIDER,
          displayName: 'NAS',
          credentials: { allowPrivateAddress: true },
          roots: [],
          dailyCheck: false,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(opened).not.toHaveBeenCalled();
      expect(repository.create).not.toHaveBeenCalled();
      opened.mockRestore();
    });

    it('makes a connection usable again when the owner signs in again', async () => {
      await sut.update(authStub.user1, connectionId, { credentials: { token: 'renewed', files: [] } });
      expect(repository.update).toHaveBeenCalledWith(
        connectionId,
        expect.objectContaining({ sealedCredentials: expect.any(Buffer) }),
      );
    });
  });

  describe('ownership', () => {
    const stranger = {
      user: { ...authStub.user1.user, id: 'someone-else' },
      session: authStub.user1.session,
    } as AuthDto;

    it('answers "not found" for another account’s connection on every route', async () => {
      const refused = [
        () => sut.get(stranger, connectionId),
        () => sut.update(stranger, connectionId, { dailyCheck: false }),
        () => sut.setRoots(stranger, connectionId, { roots: [] }),
        () => sut.folders(stranger, connectionId, ''),
        () => sut.scan(stranger, connectionId),
        () => sut.runs(stranger, connectionId),
        () => sut.run(stranger, connectionId, runId),
        () => sut.items(stranger, connectionId, runId, { offset: 0, limit: 100 }),
        () => sut.startImport(stranger, connectionId, runId, { ...TAKEOUT_DEFAULT_OPTIONS }),
        () => sut.control(stranger, connectionId, runId, { action: 'pause' }),
      ];
      for (const attempt of refused) {
        await expect(attempt()).rejects.toBeInstanceOf(NotFoundException);
      }
      repository.delete.mockResolvedValue('missing');
      await expect(sut.remove(stranger, connectionId)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.delete).toHaveBeenCalledWith('someone-else', connectionId);
      expect(repository.startScan).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
      expect(takeout.insertOperation).not.toHaveBeenCalled();
    });

    it('lists only the caller’s connections', async () => {
      await sut.list(authStub.user1);
      expect(repository.list).toHaveBeenCalledWith(ownerId);
    });

    it('does not reach a run through a connection it does not belong to', async () => {
      takeout.get.mockResolvedValue(runOf('review', { connectionId: 'another-connection' }));
      await expect(sut.run(authStub.user1, connectionId, runId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reads a run as a connection’s run, never as a Google Photos import', async () => {
      await sut.run(authStub.user1, connectionId, runId);
      expect(takeout.get).toHaveBeenCalledWith(ownerId, runId, true);
    });

    it('is not available on a shared link', async () => {
      const shared = { ...authStub.user1, sharedLink: { id: 'link' } } as AuthDto;
      await expect(sut.list(shared)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('gives an administrator counts and nothing else', async () => {
      await expect(sut.statistics()).resolves.toEqual({
        total: 5,
        providers: [
          { provider: 'dropbox', connections: 2, dailyCheck: 1 },
          { provider: 'webdav', connections: 3, dailyCheck: 3 },
        ],
      });
    });
  });

  describe('scan', () => {
    it('queues a scan job for a new run', async () => {
      const run = await sut.scan(authStub.user1, connectionId);

      const [id, options, operation] = repository.startScan.mock.calls[0];
      expect(id).toBe(connectionId);
      expect(options).toEqual(TAKEOUT_DEFAULT_OPTIONS);
      expect(operation(connectionOf(), runId)).toMatchObject({
        ownerId,
        kind: MediaOperationKind.TakeoutImport,
        label: 'My Nextcloud',
        snapshot: { importId: runId, action: 'scan' },
      });
      expect(run.id).toBe(runId);
    });

    it('refuses while a job is working on the connection', async () => {
      repository.startScan.mockResolvedValue('busy');
      await expect(sut.scan(authStub.user1, connectionId)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses until the owner has signed in again', async () => {
      repository.get.mockResolvedValue(connectionOf({ status: 'sign_in_required' }));
      await expect(sut.scan(authStub.user1, connectionId)).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.startScan).not.toHaveBeenCalled();
    });
  });

  describe('review', () => {
    it('answers a run in the Google Photos import’s shape', async () => {
      const run = await sut.run(authStub.user1, connectionId, runId);

      expect(run).toMatchObject({
        id: runId,
        name: 'My Nextcloud',
        state: 'review',
        phase: 'review',
        action: 'scan',
        processed: 3,
        total: 4,
        counts: { items: 5, ready: 2, imported: 1, matched: 1, failed: 1, rejected: 2, hiddenLocked: 1 },
        albums: [{ folder: 'Trips/Italy', name: 'Italy', count: 2, selected: true, year: false }],
      });
      // No server path, even an empty one, is part of a source.
      expect(run.sources[0]).not.toHaveProperty('path');
    });

    it('lists what a run found with its caption, favourite and album', async () => {
      repository.items.mockResolvedValue({
        total: 1,
        hiddenLocked: 0,
        items: [
          {
            id: 'item',
            remoteId: 'r1',
            path: 'Trips/Italy/rome.MOV',
            size: 12,
            modifiedAt: new Date(),
            albumHint: 'Trips/Italy',
            caption: 'Rome at dusk',
            favourite: true,
            state: 'imported',
            assetId: 'asset-1',
            error: null,
          },
        ],
      });
      access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));

      const page = await sut.items(authStub.user1, connectionId, runId, { offset: 0, limit: 100 });

      expect(page.items[0]).toMatchObject({
        path: 'Trips/Italy/rome.MOV',
        folder: 'Trips/Italy',
        source: 'My Nextcloud',
        kind: 'video',
        state: 'imported',
        assetId: 'asset-1',
        metadata: { title: 'rome.MOV', description: 'Rome at dusk', favorite: true },
        albums: ['Trips/Italy'],
      });
      expect(repository.items).toHaveBeenCalledWith(runId, expect.objectContaining({ includeLocked: false }));
    });
  });

  describe('import', () => {
    it('queues the import with the owner’s choices and retries failed downloads', async () => {
      await sut.startImport(authStub.user1, connectionId, runId, { ...TAKEOUT_DEFAULT_OPTIONS, albums: false });

      expect(takeout.withImport).toHaveBeenCalledWith(ownerId, runId, expect.any(Function), true);
      expect(takeout.setOptions).toHaveBeenCalledWith(
        expect.anything(),
        runId,
        expect.objectContaining({ albums: false }),
      );
      expect(repository.retryFailed).toHaveBeenCalledWith(runId, expect.anything());
      expect(takeout.setPhase).toHaveBeenCalledWith(expect.anything(), runId, 'importing');
      expect(takeout.insertOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ snapshot: { importId: runId, action: 'import' }, retryOfId: null }),
      );
    });

    it('refuses while the scan is still running', async () => {
      takeout.withImport.mockImplementation((_o: string, _i: string, fn: (...args: unknown[]) => Promise<unknown>) =>
        fn({}, runOf('scanning'), operationOf('scan', MediaOperationStatus.Rendering)),
      );
      await expect(
        sut.startImport(authStub.user1, connectionId, runId, { ...TAKEOUT_DEFAULT_OPTIONS }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(takeout.insertOperation).not.toHaveBeenCalled();
    });

    it('adds nothing while an administrator has paused the account’s uploads', async () => {
      const paused = { ...authStub.user1, user: { ...authStub.user1.user, uploadsPaused: true } } as AuthDto;
      await expect(sut.startImport(paused, connectionId, runId, { ...TAKEOUT_DEFAULT_OPTIONS })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('pauses the running job through the job itself', async () => {
      takeout.get.mockResolvedValue(runOf('importing'));
      takeout.latestOperations.mockResolvedValue([
        { importId: runId, operation: operationOf('import', MediaOperationStatus.Rendering) },
      ]);
      await sut.control(authStub.user1, connectionId, runId, { action: 'pause' });
      expect(mediaOperations.pause).toHaveBeenCalledWith(authStub.user1, '0195e2a0-0000-7000-8000-0000000000aa');
    });

    it('has nothing to control when no job is running', async () => {
      await expect(sut.control(authStub.user1, connectionId, runId, { action: 'cancel' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('remove', () => {
    it('refuses while a job is working, and otherwise removes the connection only', async () => {
      repository.delete.mockResolvedValue('busy');
      await expect(sut.remove(authStub.user1, connectionId)).rejects.toBeInstanceOf(BadRequestException);
      repository.delete.mockResolvedValue('deleted');
      await expect(sut.remove(authStub.user1, connectionId)).resolves.toBeUndefined();
    });

    it('surfaces a refused sign-in when listing folders', async () => {
      registerRemoteSource({
        ...fakeRemoteSourceProvider,
        open: () => ({
          listFolders: () => Promise.reject(new RemoteSourceAuthError('Sign in again')),
          scan: () => {
            throw new Error('unused');
          },
          open: () => Promise.reject(new Error('unused')),
        }),
      });
      // The stored value here is not a real seal, so it does not open: also a "sign in again".
      await expect(sut.folders(authStub.user1, connectionId, '')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
