import { ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  StudioSourceResolutionRequestSchema,
  StudioSourceResolutionSchema,
} from 'src/dtos/studio-source-resolution.dto.js';
import { StudioSourceResolutionService } from 'src/services/studio-source-resolution.service.js';
import { canonicalJson } from 'src/utils/studio-project.js';
import { ownedLottieArchive } from 'test/fixtures/studio-lottie.js';

vi.mock('src/repositories/studio-source-resolution.repository.js', () => ({
  StudioSourceResolutionRepository: class {},
}));
vi.mock('src/repositories/storage.repository.js', () => ({ StorageRepository: class {} }));
vi.mock('src/services/asset-media.service.js', () => ({ AssetMediaService: class {} }));
vi.mock('src/services/studio-project.service.js', () => ({ StudioProjectService: class {} }));
vi.mock('src/services/studio-resource.service.js', () => ({ StudioResourceService: class {} }));

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const projectId = '019a0000-0000-7000-8000-000000000001';
const parentId = '10000000-0000-4000-8000-000000000001';
const childId = '10000000-0000-4000-8000-000000000002';
const auth = {
  user: { id: '10000000-0000-4000-8000-000000000003' },
  session: { id: '10000000-0000-4000-8000-000000000004' },
} as AuthDto;

function setup({ dependency = false, archive = false } = {}) {
  const document = {
    v: '5.7.4',
    w: 32,
    h: 16,
    fr: 30,
    ip: 0,
    op: 30,
    layers: [],
    ...(dependency && { assets: [{ id: 'image', p: 'image.png', u: '', w: 1, h: 1 }] }),
  };
  const parent = archive ? ownedLottieArchive('2') : Buffer.from(JSON.stringify(document));
  const child = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  const item = {
    type: 'lottie',
    mediaId: parentId,
    sourceWidth: 32,
    sourceHeight: archive ? 64 : 16,
    frameRate: 30,
    totalFrames: archive ? 90 : 30,
    animationId: undefined as string | undefined,
    themeId: undefined as string | undefined,
  };
  const graph = {
    timeline: { items: [item], compositions: [{ id: 'nested', items: [{ ...item }] }] },
    ...(dependency && {
      studioVectorDependencies: {
        version: 1,
        bindings: [
          {
            parent: { kind: 'project-import', id: parentId, checksum: sha(parent) },
            location: { format: 'lottie-json', entry: null, pointer: '/assets/0/p', role: 'image' },
            child: { kind: 'library-asset', id: childId, checksum: sha(child) },
          },
        ],
      },
    }),
  };
  const envelope = { schemaVersion: 1, engineRevision: 'test', graph };
  const entries = [
    {
      key: `project-import:${parentId}`,
      kind: 'project-import',
      id: parentId,
      path: '/private/parent',
      checksum: sha(parent),
      sourceAccess: 'project',
    },
    ...(dependency
      ? [
          {
            key: `library-asset:${childId}`,
            kind: 'library-asset',
            id: childId,
            path: '/private/original',
            checksum: sha(child),
            sourceAccess: 'owner',
          },
        ]
      : []),
  ];
  const manifest = { entries, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const projects = {
    authorizeRevision: vi.fn(async () => ({
      revision: { revision: 2, digest: sha(canonicalJson(envelope)) },
      envelope,
      manifest,
    })),
  };
  const resources = {
    assertAuthorizedManifest: vi.fn(),
    issueReadGrants: vi.fn(() =>
      entries.map((entry) => ({ ...entry, token: entry.key, expiresAt: new Date(Date.now() + 5000).toISOString() })),
    ),
    verifyReadGrant: vi.fn(async () => ({ valid: true, path: '' })),
  };
  let state = 'current';
  let boundary = '';
  const guard = vi.fn(async () => {
    if (state !== 'current') throw new ConflictException(state);
    return auth;
  });
  const snapshots: Buffer[] = [];
  const storage = {
    stat: vi.fn(async (path: string) => ({
      isFile: () => true,
      dev: 1,
      ino: path === '/private/parent' ? 1 : 2,
      size: path === '/private/parent' ? parent.length : child.length,
      mtimeMs: 1,
      ctimeMs: 1,
    })),
    openForRandomRead: vi.fn(async (path: string) => ({
      size: path === '/private/parent' ? parent.length : child.length,
      read: vi.fn(async () => {
        const bytes = Buffer.from(path === '/private/parent' ? parent : child);
        snapshots.push(bytes);
        if (boundary === 'read') state = 'revoked';
        return bytes;
      }),
      close: vi.fn(async () => {
        if (boundary === 'close') state = 'locked';
      }),
    })),
  };
  const media = {
    downloadOriginal: vi.fn(async () => {
      if (boundary === 'final-original' && media.downloadOriginal.mock.calls.length === 2) state = 'download-revoked';
      return { path: '/private/original' };
    }),
  };
  const sut = new StudioSourceResolutionService(
    projects as never,
    resources as never,
    { guard } as never,
    storage as never,
    media as never,
  );
  const request = () => ({
    revision: 2,
    graphDigest: sha(canonicalJson(envelope)),
    parent: { kind: 'project-import' as const, id: parentId, checksum: sha(parent) },
    selection: {},
  });
  return {
    sut,
    request,
    graph,
    envelope,
    projects,
    resources,
    storage,
    media,
    guard,
    snapshots,
    parent,
    revoke: (reason: string) => {
      state = reason;
    },
    race: (value: string) => {
      boundary = value;
    },
  };
}

const zeroed = (buffers: Buffer[]) => expect(buffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);

describe('canonical Studio source resolution', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the exact raw JSON with a canonical public binding digest and wipes owned snapshots', async () => {
    const f = setup();
    const result = await f.sut.resolve(auth, projectId, f.request());
    expect(Buffer.from(result.files[0].base64, 'base64')).toEqual(f.parent);
    expect(result.files[0].path).toBe('animation.json');
    expect(result.files[0].sha256).toBe(sha(f.parent));
    const { manifestDigest, ...bound } = result;
    expect(manifestDigest).toBe(
      sha(canonicalJson({ ...bound, files: result.files.map(({ path, sha256 }) => ({ path, sha256 })) })),
    );
    expect(Date.parse(result.expiresAt) - Date.now()).toBeLessThanOrEqual(5000);
    expect(JSON.stringify(result)).not.toContain('/private');
    zeroed(f.snapshots);
  });

  it('retains the complete authored archive and validates differing composition selections independently', async () => {
    const f = setup({ archive: true });
    Object.assign(f.graph.timeline.compositions[0].items[0], {
      animationId: 'first',
      sourceWidth: 64,
      sourceHeight: 32,
      frameRate: 24,
      totalFrames: 48,
    });
    const result = await f.sut.resolve(auth, projectId, f.request());
    expect(result.archive).toBe(true);
    expect(result.files.map((file) => file.path)).toEqual(['a/first.json', 'a/selected.json', 'manifest.json']);
    for (const file of result.files) expect(sha(Buffer.from(file.base64, 'base64'))).toBe(file.sha256);
    zeroed(f.snapshots);
  });

  it('refuses a differing nested archive theme after a valid first use', async () => {
    const f = setup({ archive: true });
    f.graph.timeline.compositions[0].items[0].themeId = 'missing';
    await expect(f.sut.resolve(auth, projectId, f.request())).rejects.toThrow('studio_source_invalid');
    zeroed(f.snapshots);
  });

  it('refuses source-file identity replacement at the final boundary', async () => {
    const f = setup();
    const stat = f.storage.stat.getMockImplementation()!;
    f.storage.stat.mockImplementation(async (path) => ({
      ...(await stat(path)),
      ino: f.storage.stat.mock.calls.length > 1 ? 9 : 1,
    }));
    await expect(f.sut.resolve(auth, projectId, f.request())).rejects.toThrow('studio_source_superseded');
    zeroed(f.snapshots);
  });

  it('refuses oversize input before allocating a snapshot', async () => {
    const f = setup();
    f.storage.openForRandomRead.mockImplementation(async () => ({
      size: 16 * 1024 * 1024 + 1,
      read: vi.fn(async () => Buffer.alloc(0)),
      close: vi.fn(async () => {}),
    }));
    await expect(f.sut.resolve(auth, projectId, f.request())).rejects.toThrow('studio_source_allocation_limit');
    expect(f.snapshots).toHaveLength(0);
  });

  it.each(['read', 'close'])(
    'refuses causal revocation after the asynchronous %s, with no returned bytes',
    async (boundary) => {
      const f = setup();
      f.race(boundary);
      await expect(f.sut.resolve(auth, projectId, f.request())).rejects.toBeInstanceOf(ConflictException);
      expect(f.snapshots).toHaveLength(1);
      zeroed(f.snapshots);
    },
  );

  it('refuses an independently changed nested use before deduplicating a shared source', async () => {
    const f = setup();
    f.graph.timeline.compositions[0].items[0].sourceWidth = 64;
    await expect(f.sut.resolve(auth, projectId, f.request())).rejects.toThrow('studio_source_invalid');
    zeroed(f.snapshots);
  });

  it('refuses stale revision and uncertain digest before opening source bytes', async () => {
    const f = setup();
    await expect(f.sut.resolve(auth, projectId, { ...f.request(), revision: 1 })).rejects.toThrow(
      'studio_source_superseded',
    );
    await expect(f.sut.resolve(auth, projectId, { ...f.request(), graphDigest: '0'.repeat(64) })).rejects.toThrow(
      'studio_source_superseded',
    );
    expect(f.storage.openForRandomRead).not.toHaveBeenCalled();
  });

  it.each(['session-revoked', 'owner-epoch-changed', 'revision-changed', 'source-changed', 'locked'])(
    'refuses %s between final authority awaits',
    async (reason) => {
      const f = setup();
      f.resources.verifyReadGrant.mockImplementationOnce(async () => {
        f.revoke(reason);
        return { valid: true, path: '' };
      });
      await expect(f.sut.resolve(auth, projectId, f.request())).rejects.toThrow(reason);
      expect(f.storage.openForRandomRead).not.toHaveBeenCalled();
    },
  );

  it('rechecks expiry after the final repository await', async () => {
    vi.useFakeTimers();
    const f = setup({ dependency: true });
    const original = f.guard.getMockImplementation()!;
    f.guard.mockImplementation(async () => {
      const live = await original();
      if (f.media.downloadOriginal.mock.calls.length === 2) vi.advanceTimersByTime(5001);
      return live;
    });
    await expect(f.sut.resolve(auth, projectId, f.request())).rejects.toThrow('studio_source_expired');
    expect(f.media.downloadOriginal).toHaveBeenCalledTimes(2);
    zeroed(f.snapshots);
  });

  it('rejects extra grants, paths, malformed checksums and noncanonical base64 at the canonical boundary', () => {
    const f = setup();
    expect(StudioSourceResolutionRequestSchema.safeParse({ ...f.request(), grant: 'client-grant' }).success).toBe(
      false,
    );
    expect(
      StudioSourceResolutionRequestSchema.safeParse({
        ...f.request(),
        parent: { ...f.request().parent, path: '/private/parent' },
      }).success,
    ).toBe(false);
    expect(StudioSourceResolutionRequestSchema.safeParse({ ...f.request(), graphDigest: 'abc' }).success).toBe(false);
    expect(
      StudioSourceResolutionSchema.safeParse({
        projectId,
        revision: 2,
        graphDigest: 'a'.repeat(64),
        manifestDigest: 'b'.repeat(64),
        parent: f.request().parent,
        expiresAt: new Date().toISOString(),
        archive: false,
        selection: {},
        files: [{ path: '../private', sha256: 'c'.repeat(64), base64: 'AA=' }],
      }).success,
    ).toBe(false);
  });

  it('requires an actual acting session before querying or reading', async () => {
    const f = setup();
    await expect(f.sut.resolve({ user: auth.user }, projectId, f.request())).rejects.toBeInstanceOf(NotFoundException);
    expect(f.projects.authorizeRevision).not.toHaveBeenCalled();
  });

  it('repeats actual original-download authority after encoding and refuses a final revocation', async () => {
    const f = setup({ dependency: true });
    f.race('final-original');
    await expect(f.sut.resolve(auth, projectId, f.request())).rejects.toThrow('download-revoked');
    expect(f.media.downloadOriginal).toHaveBeenCalledTimes(2);
    zeroed(f.snapshots);
  });
});
