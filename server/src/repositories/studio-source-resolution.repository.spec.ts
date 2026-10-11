import { ConflictException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Permission } from 'src/enum.js';
import {
  type StudioSourceAdmission,
  StudioSourceResolutionRepository,
} from 'src/repositories/studio-source-resolution.repository.js';

const stores = vi.hoisted(() => ({
  currentAuth: vi.fn(),
  hold: vi.fn(),
  checkAccess: vi.fn(),
  originals: vi.fn(),
  sources: vi.fn(),
  shared: vi.fn(),
  imports: vi.fn(),
}));
vi.mock('src/enum.js', () => ({
  AlbumUserRole: { Owner: 'owner', Editor: 'editor', Viewer: 'viewer' },
  Permission: { AssetDownload: 'asset.download' },
}));
vi.mock('kysely', () => ({ Kysely: class {}, sql: () => ({ execute: () => stores.imports() }) }));
vi.mock('nestjs-kysely', () => ({ InjectKysely: () => () => {} }));
vi.mock('src/repositories/access.repository.js', () => ({ AccessRepository: class {} }));
vi.mock('src/repositories/asset.repository.js', () => ({
  AssetRepository: class {
    getByIds() {
      return stores.originals();
    }
  },
}));
vi.mock('src/repositories/derivative-privacy.repository.js', () => ({
  DerivativePrivacyRepository: class {
    lockSources() {
      return stores.sources();
    }
    lockSharedAccess() {
      return stores.shared();
    }
  },
}));
vi.mock('src/repositories/icloud-audit.repository.js', () => ({
  currentAuth: (...args: unknown[]) => stores.currentAuth(...args),
}));
vi.mock('src/repositories/studio-source-admission.js', () => ({
  holdSourceAdmission: (...args: unknown[]) => stores.hold(...args),
}));
vi.mock('src/utils/access.js', () => ({ checkAccess: (...args: unknown[]) => stores.checkAccess(...args) }));

const ownerId = '10000000-0000-4000-8000-000000000001';
const id = '10000000-0000-4000-8000-000000000002';
const projectId = '019a0000-0000-7000-8000-000000000001';
const auth = {
  user: { id: ownerId },
  session: {
    id: '10000000-0000-4000-8000-000000000003',
    hasElevatedPermission: true,
    pinExpiresAt: new Date('2100-01-01'),
  },
} as unknown as AuthDto;

function setup() {
  for (const mock of Object.values(stores)) mock.mockReset();
  const source = { id, ownerId, originalPath: '/private/original', checksum: Buffer.from('a'.repeat(64), 'hex') };
  const library = {
    key: `library-asset:${id}`,
    kind: 'library-asset',
    id,
    ownerId,
    path: source.originalPath,
    checksum: source.checksum.toString('base64'),
    sourceAccess: 'owner',
  };
  const imported = {
    ...library,
    id: ownerId,
    key: `project-import:${ownerId}`,
    kind: 'project-import',
    sourceAccess: 'project',
  };
  const admission = {
    projectId,
    revision: 2,
    graphDigest: 'b'.repeat(64),
    expiresAt: Date.now() + 5000,
    inputs: [library, imported],
    manifest: {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceEpochs: [{ assetId: id, ownerId, epoch: '1' }],
      interactiveAdmissionView: {
        actorId: ownerId,
        sessionId: auth.session!.id,
        owners: [{ ownerId, streamEpoch: null, sequence: '0' }],
      },
    },
  } as unknown as StudioSourceAdmission;
  const project = { id: projectId, ownerId, currentRevision: 2 };
  const revision = { digest: admission.graphDigest };
  const tx = {
    selectFrom: (table: string) => {
      const query = {
        selectAll: () => query,
        select: () => query,
        where: () => query,
        forShare: () => query,
        executeTakeFirst: () => Promise.resolve(table === 'studio_project' ? project : revision),
      };
      return query;
    },
  };
  const db = { transaction: () => ({ execute: (callback: (value: typeof tx) => unknown) => callback(tx) }) };
  stores.currentAuth.mockResolvedValue(auth);
  stores.hold.mockResolvedValue(undefined);
  stores.checkAccess.mockResolvedValue(new Set([id]));
  stores.originals.mockResolvedValue([source]);
  stores.sources.mockResolvedValue(
    new Map([[id, { assetId: id, ownerId, checksum: library.checksum, deleted: false, offline: false }]]),
  );
  stores.shared.mockResolvedValue(new Set());
  stores.imports.mockResolvedValue({ rows: [{ path: imported.path, checksum: imported.checksum, ownerId }] });
  return { sut: new StudioSourceResolutionRepository(db as never), admission, source, project, revision, tx };
}

describe('source publication authority orchestration (mocked stores, no SQL)', () => {
  afterEach(() => vi.useRealTimers());
  it('holds original source/session admission twice and separately checks actual AssetDownload', async () => {
    const f = setup();
    expect(await f.sut.guard(auth, f.admission)).toBe(auth);
    expect(stores.hold).toHaveBeenCalledTimes(2);
    expect(stores.currentAuth).toHaveBeenCalledTimes(2);
    expect(stores.checkAccess).toHaveBeenCalledWith(expect.anything(), {
      auth,
      permission: Permission.AssetDownload,
      ids: new Set([id]),
    });
    expect(stores.hold).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        kind: 'studio-preview',
        sourceEpochs: f.admission.manifest.sourceEpochs,
        interactiveAdmissionView: f.admission.manifest.interactiveAdmissionView,
      }),
      ownerId,
    );
  });
  it('refuses original permission withdrawal after source locks complete', async () => {
    const f = setup();
    stores.checkAccess.mockResolvedValue(new Set());
    await expect(f.sut.guard(auth, f.admission)).rejects.toThrow('Studio source unavailable');
  });
  it('refuses session withdrawal caused during the final original lookup await', async () => {
    const f = setup();
    stores.originals.mockImplementation(() => {
      stores.currentAuth.mockResolvedValue(undefined);
      return Promise.resolve([f.source]);
    });
    await expect(f.sut.guard(auth, f.admission)).rejects.toThrow('Studio source unavailable');
  });
  it('refuses a lock transition between the last two session authority awaits', async () => {
    const f = setup();
    stores.originals.mockImplementation(() => {
      stores.currentAuth.mockResolvedValue({ ...auth, session: { ...auth.session, hasElevatedPermission: false } });
      return Promise.resolve([f.source]);
    });
    await expect(f.sut.guard(auth, f.admission)).rejects.toThrow('Studio source unavailable');
  });
  it('refuses source epoch withdrawal during the final original await', async () => {
    const f = setup();
    stores.originals.mockImplementation(() => {
      stores.hold.mockRejectedValue(new ConflictException('epoch-changed'));
      return Promise.resolve([f.source]);
    });
    await expect(f.sut.guard(auth, f.admission)).rejects.toThrow('epoch-changed');
  });
  it.each(['originalPath', 'checksum'])('refuses changed original %s', async (field) => {
    const f = setup();
    stores.originals.mockResolvedValue([
      { ...f.source, [field]: field === 'checksum' ? Buffer.alloc(32) : '/private/replacement' },
    ]);
    await expect(f.sut.guard(auth, f.admission)).rejects.toThrow('Studio source unavailable');
  });
  it('refuses an unacknowledged head before source reads', async () => {
    const f = setup();
    f.project.currentRevision++;
    await expect(f.sut.guard(auth, f.admission)).rejects.toThrow('studio_source_superseded');
    expect(stores.hold).not.toHaveBeenCalled();
  });
  it('refuses a changed import declaration before original checks', async () => {
    const f = setup();
    stores.imports.mockResolvedValue({ rows: [] });
    await expect(f.sut.guard(auth, f.admission)).rejects.toThrow('studio_source_superseded');
    expect(stores.checkAccess).not.toHaveBeenCalled();
  });
  it('checks expiry after the final current-session await', async () => {
    vi.useFakeTimers();
    const f = setup();
    stores.currentAuth.mockResolvedValueOnce(auth).mockImplementation(() => {
      vi.advanceTimersByTime(5001);
      return Promise.resolve(auth);
    });
    await expect(f.sut.guard(auth, f.admission)).rejects.toThrow('studio_source_expired');
  });
});
