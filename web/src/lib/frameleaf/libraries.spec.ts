import {
  LibraryScanPhase,
  LibraryScanStopReason,
  MediaOperationStatus,
  UserStatus,
  type LibraryResponseDto,
  type LibraryScanResponseDto,
  type UserAdminResponseDto,
} from '@immich/sdk';
import {
  buildLibraryRows,
  canScanLibrary,
  checkPathList,
  filterLibraryRows,
  foldersChanged,
  isImportPathFormatValid,
  isScanActive,
  scanMessage,
  scanStatusKey,
  scannableLibraries,
  sortLibraryRows,
} from '$lib/frameleaf/libraries';

const user = (overrides: Partial<UserAdminResponseDto> = {}) =>
  ({
    id: 'owner-1',
    name: 'Taylor',
    status: UserStatus.Active,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as UserAdminResponseDto;

const scanOf = (overrides: Partial<LibraryScanResponseDto> = {}): LibraryScanResponseDto => ({
  operationId: 'op-1',
  status: MediaOperationStatus.Rendering,
  phase: LibraryScanPhase.Check,
  progress: 40,
  processedUnits: 60,
  totalUnits: 120,
  added: 2,
  checked: 40,
  updated: 0,
  offlined: 1,
  onlined: 0,
  pauseRequested: false,
  retrying: false,
  stopReason: null,
  errorCode: null,
  error: null,
  createdAt: '2026-09-23T10:00:00.000Z',
  startedAt: '2026-09-23T10:00:01.000Z',
  finishedAt: null,
  ...overrides,
});

const library = (overrides: Partial<LibraryResponseDto> = {}): LibraryResponseDto => ({
  id: 'lib-1',
  name: 'Family photo archive',
  ownerId: 'owner-1',
  importPaths: ['/mnt/photos/taylor'],
  exclusionPatterns: ['**/.DS_Store'],
  assetCount: 0,
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  refreshedAt: null,
  deletedAt: null,
  scan: null,
  ...overrides,
});

const rowsOf = (libraries: LibraryResponseDto[], users = [user()]) =>
  buildLibraryRows({
    libraries,
    users,
    uploads: users.map((owner) => ({
      ownerId: owner.id,
      photos: 10,
      videos: 1,
      total: 11,
      usage: 5000,
      usagePhysical: 4000,
    })),
    statistics: Object.fromEntries(
      libraries.map((item) => [item.id, { photos: 3, videos: 2, total: 5, usage: 900, usagePhysical: 900 }]),
    ),
    uploadsName: (name) => `${name}’s uploads`,
  });

describe('buildLibraryRows', () => {
  it("lists each account's managed uploads before its external libraries", () => {
    const rows = rowsOf([library()]);

    expect(rows.map((row) => [row.key, row.kind, row.name])).toEqual([
      ['uploads:owner-1', 'upload', 'Taylor’s uploads'],
      ['library:lib-1', 'external', 'Family photo archive'],
    ]);
    expect(rows[1].stats).toEqual({ items: 5, photos: 3, videos: 2, logical: 900, physical: 900 });
  });

  it('marks a library whose removal is in progress', () => {
    const [, row] = rowsOf([library({ deletedAt: '2026-09-23T10:00:00.000Z' })]);
    expect(row.lifecycle).toBe('removing');
  });
});

describe('filter and sort', () => {
  const rows = rowsOf([
    library({ id: 'a', name: 'Beta' }),
    library({ id: 'b', name: 'Alpha', deletedAt: '2026-09-23T10:00:00.000Z' }),
  ]);

  it('filters by lifecycle and kind, and searches names and owners', () => {
    expect(filterLibraryRows(rows, { filter: 'active' }).map(({ name }) => name)).toEqual(['Taylor’s uploads', 'Beta']);
    expect(filterLibraryRows(rows, { filter: 'deleted' }).map(({ name }) => name)).toEqual(['Alpha']);
    expect(filterLibraryRows(rows, { filter: 'upload' }).map(({ kind }) => kind)).toEqual(['upload']);
    expect(filterLibraryRows(rows, { filter: 'all', query: 'tay' })).toHaveLength(3);
  });

  it('sorts by name without reordering the input', () => {
    expect(sortLibraryRows(rows, 'name').map(({ name }) => name)).toEqual(['Alpha', 'Beta', 'Taylor’s uploads']);
    expect(rows[0].name).toBe('Taylor’s uploads');
  });
});

describe('scans', () => {
  it('offers a scan only for an active external library with folders, a live owner and no scan going', () => {
    const [upload, idle] = rowsOf([library()]);
    expect(canScanLibrary(upload)).toBe(false);
    expect(canScanLibrary(idle)).toBe(true);

    const [, running] = rowsOf([library({ scan: scanOf() })]);
    expect(canScanLibrary(running)).toBe(false);

    const [, noFolders] = rowsOf([library({ importPaths: [] })]);
    expect(canScanLibrary(noFolders)).toBe(false);

    const [, orphaned] = rowsOf([library()], [user({ status: UserStatus.Deleted, deletedAt: '2026-09-01T00:00:00Z' })]);
    expect(canScanLibrary(orphaned)).toBe(false);
  });

  it('counts only the libraries a scan-all would start', () => {
    const rows = rowsOf([library({ id: 'a' }), library({ id: 'b', scan: scanOf() })]);
    expect(scannableLibraries(rows).map(({ id }) => id)).toEqual(['a']);
  });

  it('treats paused and stopping scans as still active', () => {
    expect(isScanActive(scanOf({ status: MediaOperationStatus.Paused }))).toBe(true);
    expect(isScanActive(scanOf({ status: MediaOperationStatus.Cancelling }))).toBe(true);
    expect(isScanActive(scanOf({ status: MediaOperationStatus.Failed }))).toBe(false);
  });

  it('names the status the server reports', () => {
    expect(scanStatusKey(scanOf())).toBe('running');
    expect(scanStatusKey(scanOf({ pauseRequested: true }))).toBe('pausing');
    expect(scanStatusKey(scanOf({ status: MediaOperationStatus.Queued, retrying: true }))).toBe('retrying');
    expect(scanStatusKey(scanOf({ status: MediaOperationStatus.Failed }))).toBe('failed');
  });

  it('never presents an unreachable folder as a finished scan', () => {
    expect(
      scanMessage(
        scanOf({
          status: MediaOperationStatus.Failed,
          errorCode: 'library_source_unavailable',
          error: '/mnt/photos: Path does not exist (ENOENT)',
        }),
      ),
    ).toEqual({
      key: 'frameleaf_libraries_scan_failed_unavailable',
      values: { error: '/mnt/photos: Path does not exist (ENOENT)' },
    });
    expect(
      scanMessage(scanOf({ status: MediaOperationStatus.Queued, retrying: true, errorCode: 'library_source_empty' }))
        .key,
    ).toBe('frameleaf_libraries_scan_failed_empty_retrying');
  });

  it('says why the server stopped a scan', () => {
    expect(
      scanMessage(scanOf({ status: MediaOperationStatus.Cancelled, stopReason: LibraryScanStopReason.PathsChanged }))
        .key,
    ).toBe('frameleaf_libraries_scan_stopped_paths');
    expect(scanMessage(scanOf({ status: MediaOperationStatus.Cancelled })).key).toBe(
      'frameleaf_libraries_scan_cancelled',
    );
  });

  it('reports a finished scan in the template’s words', () => {
    expect(scanMessage(scanOf({ status: MediaOperationStatus.Completed, checked: 10, offlined: 2, added: 3 }))).toEqual(
      {
        key: 'frameleaf_libraries_scan_completed',
        values: { matched: 8, added: 3, missing: 2 },
      },
    );
  });
});

describe('folders', () => {
  it('checks the template’s path format', () => {
    expect(isImportPathFormatValid('/mnt/photos')).toBe(true);
    expect(isImportPathFormatValid('mnt/photos')).toBe(false);
    expect(isImportPathFormatValid('/mnt/../etc')).toBe(false);
  });

  it('refuses empty and repeated rows', () => {
    expect(checkPathList(['/a', ''])).toBe('empty');
    expect(checkPathList(['/a', '/a/'])).toBe('duplicate');
    expect(checkPathList(['/a', '/b'])).toBeNull();
  });

  it('knows when saving changes what the library scans', () => {
    const current = { importPaths: ['/a', '/b'], exclusionPatterns: ['x'] };
    expect(foldersChanged(current, { importPaths: ['/b', '/a/'], exclusionPatterns: ['x'] })).toBe(false);
    expect(foldersChanged(current, { importPaths: ['/a'], exclusionPatterns: ['x'] })).toBe(true);
  });
});
