import {
  MediaHealthCategory,
  MediaHealthOperationMode,
  MediaHealthRootKind,
  MediaHealthSeverity,
  MediaHealthStatus,
  MediaOperationStatus,
  type MediaHealthCandidateDto,
  type MediaHealthItemDto,
  type MediaHealthListResponseDto,
  type MediaHealthOperationDto,
  type MediaHealthSummaryResponseDto,
} from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  accountOptions,
  canRecover,
  canRelink,
  candidatesIn,
  evidenceKey,
  filterRows,
  formatBytes,
  initialOwner,
  isActiveOperation,
  isRawName,
  locatable,
  ownerScope,
  recoveryChoicesValid,
  relinkCandidate,
  scanState,
  statusTone,
  toRows,
  trashable,
  trashUndoable,
  type LibraryCareRow,
} from '$lib/frameleaf/library-care';

const candidate = (overrides: Partial<MediaHealthCandidateDto> = {}): MediaHealthCandidateDto => ({
  id: 'candidate-1',
  healthId: 'health-1',
  candidatePath: '/data/upload/taylor/found.jpg',
  status: MediaHealthStatus.Found,
  visualMatchScore: 1,
  evidence: { reason: 'checksum_match', algorithms: ['sha1'] },
  resolution: { autoRelinkable: true },
  checkedAt: '2026-09-23T00:00:00.000Z',
  rootId: 'managed',
  rootKind: MediaHealthRootKind.Managed,
  checksumMatch: true,
  checksums: [],
  decodeValid: true,
  chosen: false,
  ...overrides,
});

const item = (overrides: Partial<MediaHealthItemDto> = {}): MediaHealthItemDto =>
  ({
    id: 'health-1',
    assetId: 'asset-1',
    category: MediaHealthCategory.Missing,
    status: MediaHealthStatus.Found,
    severity: MediaHealthSeverity.Warning,
    originalPath: '/data/upload/taylor/missing.jpg',
    originalFileName: 'Forest trail.ARW',
    evidence: { reason: 'source_file_missing_or_unreadable' },
    resolution: {},
    checkedAt: '2026-09-23T00:00:00.000Z',
    dismissedAt: null,
    resolvedAt: null,
    asset: { ownerId: 'taylor', thumbhash: null, exifInfo: { fileSizeInByte: 42_100_000 } },
    candidates: [candidate()],
    ...overrides,
  }) as unknown as MediaHealthItemDto;

const list = (items: MediaHealthItemDto[]): MediaHealthListResponseDto => ({
  buckets: [{ timeBucket: '2026-09-19', count: items.length, items }],
  total: items.length,
  run: null,
});

const row = (overrides: Partial<MediaHealthItemDto> = {}): LibraryCareRow => toRows(list([item(overrides)]))[0];

const operation = (overrides: Partial<MediaHealthOperationDto> = {}): MediaHealthOperationDto => ({
  id: '0195e2a0-0000-7000-8000-0000000000b1',
  mode: MediaHealthOperationMode.Scan,
  status: MediaOperationStatus.Rendering,
  progress: 40,
  processedUnits: 40,
  totalUnits: 100,
  pauseRequestedAt: null,
  cancelRequestedAt: null,
  autoRetries: 0,
  error: null,
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
  finishedAt: null,
  ...overrides,
});

describe('toRows', () => {
  it('flattens buckets into rows with the owner, size and evidence', () => {
    expect(row()).toMatchObject({
      id: 'health-1',
      assetId: 'asset-1',
      ownerId: 'taylor',
      name: 'Forest trail.ARW',
      sizeInBytes: 42_100_000,
      evidence: 'source_file_missing_or_unreadable',
    });
  });
});

describe('relinkCandidate', () => {
  it('uses the only verified copy', () => {
    expect(relinkCandidate(row())?.id).toBe('candidate-1');
  });

  it('refuses a choice among several copies until the reviewer chose one', () => {
    const copies = [candidate({ id: 'a' }), candidate({ id: 'b' })];
    expect(relinkCandidate(row({ candidates: copies }))).toBeUndefined();
    expect(relinkCandidate(row({ candidates: [copies[0], { ...copies[1], chosen: true }] }))?.id).toBe('b');
  });

  it('never relinks from an incomplete search or a copy with a different checksum', () => {
    const incomplete = candidate({ resolution: { autoRelinkable: false } });
    expect(relinkCandidate(row({ candidates: [incomplete] }))).toBeUndefined();
    expect(relinkCandidate(row({ candidates: [candidate({ checksumMatch: false })] }))).toBeUndefined();
    expect(relinkCandidate(row({ status: MediaHealthStatus.Candidate }))).toBeUndefined();
  });

  it('is only for missing originals', () => {
    expect(
      relinkCandidate(row({ category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.CorruptConfirmed })),
    ).toBeUndefined();
  });
});

describe('the actions the page offers', () => {
  const confirmed = row({ category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.CorruptConfirmed });
  const raw = row({ id: 'raw', category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.UnsupportedRaw });
  const suspect = row({
    id: 'suspect',
    category: MediaHealthCategory.Corrupt,
    status: MediaHealthStatus.CorruptSuspect,
  });

  it('relinks only when every chosen row has a verified copy', () => {
    expect(canRelink([row()])).toBe(true);
    expect(canRelink([row(), row({ id: 'health-2', status: MediaHealthStatus.Missing, candidates: [] })])).toBe(false);
    expect(canRelink([])).toBe(false);
  });

  it('keeps unsupported RAW and suspected damage apart from confirmed damage', () => {
    expect(canRecover([confirmed])).toBe(true);
    expect(canRecover([confirmed, raw])).toBe(false);
    expect(canRecover([suspect])).toBe(false);
    expect(trashable([confirmed, raw, suspect]).map(({ status }) => status)).toEqual([
      MediaHealthStatus.CorruptConfirmed,
    ]);
  });

  it('lets a finding left queued by a cancelled trash job be confirmed again', () => {
    const queued = row({ category: MediaHealthCategory.Corrupt, status: MediaHealthStatus.TrashQueued });
    expect(trashable([queued])).toHaveLength(1);
  });

  it('searches for missing originals that still need attention and for confirmed damage', () => {
    const relinked = row({ id: 'done', status: MediaHealthStatus.Relinked });
    expect(locatable([row(), relinked, confirmed, raw]).map(({ id }) => id)).toEqual(['health-1', 'health-1']);
  });

  it('leaves RAW originals out of a search while RAW source suggestions are off (FL-69)', () => {
    const jpeg = row({ id: 'jpeg', originalFileName: 'Lake.jpg' });
    const arw = row({ id: 'arw', originalFileName: 'Forest trail.ARW' });
    expect(locatable([jpeg, arw], { rawRecovery: false }).map(({ id }) => id)).toEqual(['jpeg']);
    expect(locatable([jpeg, arw], { rawRecovery: true }).map(({ id }) => id)).toEqual(['jpeg', 'arw']);
    expect(isRawName('Summit.CR3')).toBe(true);
    expect(isRawName('scan.tiff')).toBe(false);
  });
});

describe('whose findings (UT-13)', () => {
  const users = [
    { id: 'admin', name: 'Taylor' },
    { id: 'jamie', name: 'Jamie' },
    { id: 'emma', name: 'Emma' },
  ];

  it('offers All accounts and then every account by name, the administrator included', () => {
    expect(accountOptions(users, { id: 'admin', name: 'Taylor' }, true)).toEqual([
      { value: 'all', name: null },
      { value: 'admin', name: 'Taylor' },
      { value: 'jamie', name: 'Jamie' },
      { value: 'emma', name: 'Emma' },
    ]);
  });

  it('offers somebody who is not an administrator only themselves', () => {
    expect(accountOptions(users, { id: 'jamie', name: 'Jamie' }, false)).toEqual([{ value: 'jamie', name: 'Jamie' }]);
    expect(initialOwner('user:emma', users, 'jamie', false)).toBe('jamie');
  });

  it('opens on the viewed account or on all accounts', () => {
    expect(initialOwner('user:emma', users, 'admin', true)).toBe('emma');
    expect(initialOwner('user:nobody', users, 'admin', true)).toBe('all');
    expect(initialOwner('library:1', users, 'admin', true)).toBe('all');
    expect(initialOwner(null, users, 'admin', true)).toBe('all');
  });

  it('asks the server for exactly that scope', () => {
    expect(ownerScope('all', 'admin')).toEqual({ allAccounts: true });
    expect(ownerScope('admin', 'admin')).toEqual({});
    expect(ownerScope('emma', 'admin')).toEqual({ ownerId: 'emma' });
  });
});

describe('undo (UT-2)', () => {
  it('offers to take a trash move back only when every item is the viewer’s own', () => {
    expect(trashUndoable([{ ownerId: 'me' }, { ownerId: 'me' }], 'me')).toBe(true);
    expect(trashUndoable([{ ownerId: 'me' }, { ownerId: 'jamie' }], 'me')).toBe(false);
    expect(trashUndoable([], 'me')).toBe(false);
  });
});

describe('recoveryChoicesValid', () => {
  const damaged = row({
    category: MediaHealthCategory.Corrupt,
    status: MediaHealthStatus.CorruptConfirmed,
    candidates: [
      candidate({ id: 'backup', rootId: 'recovery:abc', rootKind: MediaHealthRootKind.Recovery }),
      candidate({ id: 'preview', rootId: 'recovery:abc', checksumMatch: false, decodeValid: true }),
      candidate({ id: 'undecoded', rootId: 'recovery:abc', decodeValid: null }),
    ],
  });

  it('needs a candidate inside a selected location for every row', () => {
    expect(recoveryChoicesValid([damaged], { [damaged.id]: 'backup' }, ['recovery:abc'], 'replace')).toBe(true);
    expect(recoveryChoicesValid([damaged], { [damaged.id]: 'backup' }, ['managed'], 'replace')).toBe(false);
    expect(recoveryChoicesValid([damaged], {}, ['recovery:abc'], 'replace')).toBe(false);
  });

  it('replaces damage only with an exact checksum and a successful decode', () => {
    expect(recoveryChoicesValid([damaged], { [damaged.id]: 'preview' }, ['recovery:abc'], 'replace')).toBe(false);
    expect(recoveryChoicesValid([damaged], { [damaged.id]: 'undecoded' }, ['recovery:abc'], 'replace')).toBe(false);
  });

  it('filters candidates by the selected locations', () => {
    expect(candidatesIn(damaged, ['managed'])).toEqual([]);
    expect(candidatesIn(damaged, ['recovery:abc'])).toHaveLength(3);
  });
});

describe('scanState', () => {
  const runs = { missing: null, corrupt: null };

  it('reports a running scan with its counts', () => {
    expect(scanState({ operation: operation(), runs }, MediaHealthCategory.Missing)).toMatchObject({
      kind: 'running',
      done: 40,
      total: 100,
    });
  });

  it('tells queued, pausing, paused and retrying apart', () => {
    const at = (overrides: Partial<MediaHealthOperationDto>) =>
      scanState({ operation: operation(overrides), runs }, MediaHealthCategory.Missing).kind;
    expect(at({ status: MediaOperationStatus.Queued })).toBe('queued');
    expect(at({ pauseRequestedAt: '2026-09-23T00:00:01.000Z' })).toBe('pausing');
    expect(at({ status: MediaOperationStatus.Paused })).toBe('paused');
    expect(at({ status: MediaOperationStatus.Queued, autoRetries: 1, error: 'disk busy' })).toBe('retrying');
  });

  it('falls back to how the last run of the category ended', () => {
    const finished = operation({ status: MediaOperationStatus.Completed, finishedAt: '2026-09-23T00:10:00.000Z' });
    const run = {
      id: 'run-1',
      category: 'missing',
      status: 'failed',
      startedAt: '2026-09-23T00:00:00.000Z',
      finishedAt: '2026-09-23T00:05:00.000Z',
      totalAssets: 1,
      checkedAssets: 1,
      foundAssets: 0,
      error: 'disk offline',
    } as unknown as MediaHealthSummaryResponseDto['runs']['missing'];
    expect(
      scanState({ operation: finished, runs: { missing: run, corrupt: null } }, MediaHealthCategory.Missing),
    ).toEqual({ kind: 'failed', at: '2026-09-23T00:05:00.000Z', error: 'disk offline' });
    expect(scanState({ operation: null, runs }, MediaHealthCategory.Corrupt)).toEqual({ kind: 'never' });
  });

  it('reports a run left open with no job to finish it as interrupted, never as completed', () => {
    const open = (status: string) =>
      ({
        id: 'run-1',
        category: 'missing',
        status,
        startedAt: '2026-09-23T00:00:00.000Z',
        finishedAt: null,
        totalAssets: 0,
        checkedAssets: 0,
        foundAssets: 0,
        error: null,
      }) as unknown as MediaHealthSummaryResponseDto['runs']['missing'];
    for (const status of ['running', 'paused', 'retrying', 'something-new']) {
      expect(
        scanState({ operation: null, runs: { missing: open(status), corrupt: null } }, MediaHealthCategory.Missing),
      ).toMatchObject({ kind: 'interrupted' });
    }
    expect(
      scanState({ operation: null, runs: { missing: open('completed'), corrupt: null } }, MediaHealthCategory.Missing),
    ).toMatchObject({ kind: 'completed' });
  });

  it('holds Scan again back while a job is queued, running or paused', () => {
    expect(isActiveOperation(operation({ status: MediaOperationStatus.Paused }))).toBe(true);
    expect(isActiveOperation(operation({ status: MediaOperationStatus.Failed }))).toBe(false);
    expect(isActiveOperation(null)).toBe(false);
  });
});

describe('helpers', () => {
  it('filters by filename, account or status', () => {
    const rows = [row(), row({ id: 'health-2', originalFileName: 'Cabin at dusk.jpg' })];
    expect(filterRows(rows, 'cabin', (item) => item.name).map(({ id }) => id)).toEqual(['health-2']);
    expect(filterRows(rows, '  ', (item) => item.name)).toHaveLength(2);
  });

  it('explains stable reasons and nothing else', () => {
    expect(evidenceKey({ evidence: { reason: 'raw_decode_unsupported' } })).toBe(
      'library_care_evidence_raw_unsupported',
    );
    expect(evidenceKey({ evidence: { reason: 'something new' } })).toBeNull();
  });

  it('keeps damage and RAW visually distinct', () => {
    expect(statusTone(MediaHealthStatus.CorruptConfirmed)).toBe('danger');
    expect(statusTone(MediaHealthStatus.UnsupportedRaw)).toBe('info');
    expect(statusTone(MediaHealthStatus.CorruptSuspect)).toBe('warning');
  });

  it('formats bytes like the prototype', () => {
    expect(formatBytes(42_100_000)).toBe('42.1 MB');
    expect(formatBytes(null)).toBe('');
  });
});
