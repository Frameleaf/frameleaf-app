import {
  MediaOperationStatus,
  StudioBundleSourceMode,
  StudioBundleSourceResolution,
  StudioProjectAccess,
  StudioProjectShelf,
  type StudioBundleSourceDto,
  type StudioProjectDto,
} from '@immich/sdk';
import {
  isStudioBundleSettled,
  recentStudioProjects,
  reviewStudioBundle,
  studioBundleErrorCode,
  studioBundleErrorKey,
  studioBundleJobStatusKey,
  studioBundleMapping,
  studioBundlePollMs,
  studioDaysUntilPurge,
  studioProjectActions,
} from './project-library';

const project = (overrides: Partial<StudioProjectDto> = {}): StudioProjectDto =>
  ({
    id: 'p1',
    ownerId: 'u1',
    name: 'Lake trip',
    spaceId: null,
    revision: 3,
    access: StudioProjectAccess.Owner,
    shelf: StudioProjectShelf.Active,
    archivedAt: null,
    deletedAt: null,
    purgeAfter: null,
    lastOpenedAt: null,
    thumbnailAssetId: null,
    duplicatedFromId: null,
    importedFromBundle: false,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-21T10:00:00.000Z',
    ...overrides,
  }) as StudioProjectDto;

const source = (overrides: Partial<StudioBundleSourceDto>): StudioBundleSourceDto =>
  ({
    key: 'library-asset:a',
    kind: 'library-asset',
    id: 'a',
    mode: StudioBundleSourceMode.Reference,
    fileName: null,
    contentType: null,
    sizeBytes: null,
    resolution: StudioBundleSourceResolution.Missing,
    suggestedAssetId: null,
    ...overrides,
  }) as StudioBundleSourceDto;

describe('recentStudioProjects', () => {
  it('lists the owner’s own active projects by when they were last opened', () => {
    const recent = recentStudioProjects([
      project({ id: 'old', lastOpenedAt: '2026-09-01T10:00:00.000Z' }),
      project({ id: 'new', lastOpenedAt: '2026-09-21T10:00:00.000Z' }),
      project({ id: 'never' }),
      project({ id: 'review', access: StudioProjectAccess.Reviewer, lastOpenedAt: '2026-09-22T10:00:00.000Z' }),
      project({ id: 'archived', shelf: StudioProjectShelf.Archived, lastOpenedAt: '2026-09-22T10:00:00.000Z' }),
    ]);
    expect(recent.map((item) => item.id)).toEqual(['new', 'old']);
  });
});

describe('studioProjectActions', () => {
  it('offers a reviewer nothing but opening', () => {
    expect(studioProjectActions(project({ access: StudioProjectAccess.Reviewer }))).toEqual(['open']);
  });

  it('offers restore and permanent deletion in the trash, and never opening', () => {
    expect(studioProjectActions(project({ shelf: StudioProjectShelf.Trashed }))).toEqual([
      'restore',
      'delete-permanently',
    ]);
  });

  it('offers export only once there is a saved version', () => {
    expect(studioProjectActions(project({ revision: 0 }))).not.toContain('export');
    expect(studioProjectActions(project())).toContain('export');
    expect(studioProjectActions(project({ shelf: StudioProjectShelf.Archived }))).toEqual([
      'open',
      'unarchive',
      'export',
      'duplicate',
      'trash',
    ]);
  });
});

describe('studioDaysUntilPurge', () => {
  it('counts whole days left and never goes below zero', () => {
    const now = new Date('2026-09-22T12:00:00.000Z');
    expect(studioDaysUntilPurge({ purgeAfter: '2026-10-22T12:00:00.000Z' }, now)).toBe(30);
    expect(studioDaysUntilPurge({ purgeAfter: '2026-09-22T13:00:00.000Z' }, now)).toBe(1);
    expect(studioDaysUntilPurge({ purgeAfter: '2026-09-01T00:00:00.000Z' }, now)).toBe(0);
    expect(studioDaysUntilPurge({ purgeAfter: null }, now)).toBeNull();
  });
});

describe('bundle review', () => {
  const sources = [
    source({ key: 'library-asset:a', resolution: StudioBundleSourceResolution.Kept }),
    source({ key: 'library-asset:b', resolution: StudioBundleSourceResolution.Suggested, suggestedAssetId: 'mine-b' }),
    source({
      key: 'library-asset:c',
      resolution: StudioBundleSourceResolution.Missing,
      mode: StudioBundleSourceMode.Embedded,
    }),
    source({ key: 'library-asset:d', resolution: StudioBundleSourceResolution.Missing }),
  ];

  it('counts what will be kept, suggested and missing', () => {
    expect(reviewStudioBundle({ sources })).toEqual({ kept: 1, suggested: 1, missing: 2, missingWithCopy: 1 });
  });

  it('sends every accepted suggestion and nothing the person declined', () => {
    expect(studioBundleMapping(sources)).toEqual({ 'library-asset:b': 'mine-b' });
    expect(studioBundleMapping(sources, new Set(['library-asset:b']))).toEqual({});
  });
});

describe('bundle errors and polling', () => {
  it('turns known codes into messages a person can act on', () => {
    expect(studioBundleErrorKey('bundle_entry_name')).toBe('frameleaf_studio_bundle_error_unsafe');
    expect(studioBundleErrorKey('bundle_upload_expired')).toBe('frameleaf_studio_bundle_error_expired');
    expect(studioBundleErrorKey('something_new')).toBe('frameleaf_studio_bundle_error_generic');
    expect(studioBundleErrorKey(null)).toBe('frameleaf_studio_bundle_error_generic');
  });

  it('reads the code from a refused request', () => {
    expect(studioBundleErrorCode({ status: 400, data: { code: 'bundle_ratio', message: 'x' } })).toBe('bundle_ratio');
    expect(studioBundleErrorCode({ status: 400, data: { message: { code: 'bundle_zip64' } } })).toBe('bundle_zip64');
    expect(studioBundleErrorCode(new Error('offline'))).toBeNull();
  });

  it('settles on a finished job and backs off while one runs', () => {
    expect(isStudioBundleSettled({ status: MediaOperationStatus.Completed })).toBe(true);
    expect(isStudioBundleSettled({ status: MediaOperationStatus.Rendering })).toBe(false);
    expect(studioBundlePollMs(0)).toBe(1000);
    expect(studioBundlePollMs(3)).toBe(8000);
    expect(studioBundlePollMs(10)).toBe(10_000);
  });

  it('reads a job waiting for its automatic retry as retrying, the way Activity does', () => {
    const key = (status: MediaOperationStatus, autoRetries: number, retryAt: string | null = null) =>
      studioBundleJobStatusKey({ status, autoRetries, retryAt });

    expect(key(MediaOperationStatus.Queued, 0)).toBe('frameleaf_activity_status_queued');
    expect(key(MediaOperationStatus.Queued, 1)).toBe('frameleaf_activity_status_retrying');
    expect(key(MediaOperationStatus.Queued, 0, '2026-09-22T12:00:00.000Z')).toBe('frameleaf_activity_status_retrying');
    // Once the retry runs it reads as running, and a spent retry reads as failed.
    expect(key(MediaOperationStatus.Rendering, 1)).toBe('frameleaf_activity_status_rendering');
    expect(key(MediaOperationStatus.Failed, 1)).toBe('frameleaf_activity_status_failed');
  });
});
