import {
  TakeoutItemKind,
  TakeoutItemState,
  TakeoutPhase,
  TakeoutSourceKind,
  TakeoutState,
  TakeoutWarning,
  type TakeoutItemResponseDto,
  type TakeoutResponseDto,
  type TakeoutSourceResponseDto,
} from '@immich/sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import {
  canRetryScan,
  canReviewTakeout,
  collectPages,
  findStagedArchive,
  isTakeoutBusy,
  isTakeoutMoving,
  resumeTakeoutArchive,
  TAKEOUT_UPLOAD_CHUNK_SIZE,
  takeoutBytesRemaining,
  takeoutImportOptions,
  takeoutProgress,
  takeoutReportCsv,
  takeoutReportJson,
  takeoutSourcesStaged,
  takeoutStage,
} from '$lib/frameleaf/takeout';

const source = (overrides: Partial<TakeoutSourceResponseDto> = {}): TakeoutSourceResponseDto => ({
  id: 'archive',
  name: 'takeout.zip',
  kind: TakeoutSourceKind.Zip,
  size: 100,
  received: 100,
  scanned: false,
  rejected: 0,
  ...overrides,
});

const file = (bytes: Uint8Array) => ({
  name: 'takeout.zip',
  size: bytes.length,
  slice: (start?: number, end?: number) =>
    ({
      arrayBuffer: () => Promise.resolve(bytes.slice(start, end).buffer),
      size: (end ?? bytes.length) - (start ?? 0),
    }) as Blob,
});

const item = (overrides: Partial<TakeoutItemResponseDto> = {}): TakeoutItemResponseDto => ({
  id: 'item',
  path: 'Trip/IMG_1.jpg',
  folder: 'Trip',
  source: 'takeout-001.zip',
  kind: TakeoutItemKind.Image,
  size: 10,
  state: TakeoutItemState.Imported,
  assetId: 'asset',
  metadata: { title: 'IMG_1.jpg' },
  candidates: [],
  sidecarId: null,
  albums: ['Trip'],
  warnings: [],
  locked: false,
  error: null,
  ...overrides,
});

describe('takeout stages', () => {
  it('maps the import phase to the prototype’s Stage, Scan and Reconcile', () => {
    expect(takeoutStage()).toBe('stage');
    expect(takeoutStage({ phase: TakeoutPhase.Sources })).toBe('stage');
    expect(takeoutStage({ phase: TakeoutPhase.Scanning })).toBe('scan');
    expect(takeoutStage({ phase: TakeoutPhase.Review })).toBe('reconcile');
    expect(takeoutStage({ phase: TakeoutPhase.Importing })).toBe('reconcile');
    expect(takeoutStage({ phase: TakeoutPhase.Completed })).toBe('reconcile');
  });

  it('keeps watching while the server is moving, and not while it waits for the owner', () => {
    expect(isTakeoutMoving(TakeoutState.Scanning)).toBe(true);
    expect(isTakeoutMoving(TakeoutState.Queued)).toBe(true);
    expect(isTakeoutMoving(TakeoutState.Paused)).toBe(false);
    expect(isTakeoutBusy(TakeoutState.Paused)).toBe(true);
    expect(isTakeoutBusy(TakeoutState.Review)).toBe(false);
  });

  it('allows review only after the scan and while no job is working', () => {
    expect(canReviewTakeout({ phase: TakeoutPhase.Review, state: TakeoutState.Review })).toBe(true);
    expect(canReviewTakeout({ phase: TakeoutPhase.Importing, state: TakeoutState.Failed })).toBe(true);
    expect(canReviewTakeout({ phase: TakeoutPhase.Importing, state: TakeoutState.Importing })).toBe(false);
    expect(canReviewTakeout({ phase: TakeoutPhase.Scanning, state: TakeoutState.Failed })).toBe(false);
    expect(canRetryScan({ phase: TakeoutPhase.Scanning, state: TakeoutState.Cancelled })).toBe(true);
  });

  it('knows when every archive is on the server', () => {
    expect(takeoutSourcesStaged([])).toBe(false);
    expect(takeoutSourcesStaged([source(), source({ kind: TakeoutSourceKind.Directory, size: 0, received: 0 })])).toBe(
      true,
    );
    expect(takeoutSourcesStaged([source({ received: 40 })])).toBe(false);
    expect(takeoutBytesRemaining([source({ received: 40 }), source()])).toBe(60);
  });

  it('shows no percentage until something is counted, and follows a growing total', () => {
    expect(takeoutProgress({ processed: 0, total: null }).percent).toBeNull();
    expect(takeoutProgress({ processed: 5, total: 10 }).percent).toBe(50);
    expect(takeoutProgress({ processed: 5, total: 40 }).percent).toBe(13);
  });

  it('sends the albums the owner picked with the current choices', () => {
    const options = {
      descriptions: true,
      dates: true,
      locations: false,
      favorites: true,
      archive: true,
      albums: true,
      sidecarReview: true,
      updateMatchedMetadata: false,
    };
    expect(
      takeoutImportOptions(options, [
        { folder: 'Trip', selected: true },
        { folder: 'Photos from 2020', selected: false },
      ]),
    ).toEqual({ ...options, selectedAlbums: ['Trip'] });
  });
});

describe(resumeTakeoutArchive.name, () => {
  it('checks every staged range before uploading the rest', async () => {
    const bytes = new Uint8Array(TAKEOUT_UPLOAD_CHUNK_SIZE * 2 + 27);
    bytes[TAKEOUT_UPLOAD_CHUNK_SIZE + 3] = 17;
    const staged = source({ size: bytes.length, received: TAKEOUT_UPLOAD_CHUNK_SIZE + 11 });
    const events: string[] = [];
    const api = {
      verify: vi.fn(({ offset, size, sha256: digest }: { offset: number; size: number; sha256: string }) => {
        expect(digest).toBe(bytesToHex(sha256(bytes.slice(offset, offset + size))));
        events.push(`verify:${offset}:${size}`);
        return Promise.resolve();
      }),
      upload: vi.fn((offset: number, part: Blob) => {
        events.push(`upload:${offset}`);
        return Promise.resolve({ ...staged, received: offset + part.size });
      }),
    };

    const result = await resumeTakeoutArchive(file(bytes), staged, api, new AbortController().signal, vi.fn());

    expect(events).toEqual([
      `verify:0:${TAKEOUT_UPLOAD_CHUNK_SIZE}`,
      `verify:${TAKEOUT_UPLOAD_CHUNK_SIZE}:11`,
      `upload:${TAKEOUT_UPLOAD_CHUNK_SIZE + 11}`,
      `upload:${TAKEOUT_UPLOAD_CHUNK_SIZE * 2 + 11}`,
    ]);
    expect(result.received).toBe(bytes.length);
  });

  it('never appends to a same-name, same-size archive whose staged bytes differ', async () => {
    const input = file(new Uint8Array(12));
    const upload = vi.fn();
    await expect(
      resumeTakeoutArchive(
        input,
        source({ size: 12, received: 8 }),
        { verify: vi.fn().mockRejectedValue(new Error('Archive differs')), upload },
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow('Archive differs');
    expect(upload).not.toHaveBeenCalled();
  });

  it('refuses a file that is not the archive being resumed', async () => {
    await expect(
      resumeTakeoutArchive(
        file(new Uint8Array(12)),
        source({ size: 13, received: 0 }),
        { verify: vi.fn(), upload: vi.fn() },
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow('frameleaf_takeout_error_wrong_archive');
  });

  it('stops when paused and on an acknowledgement that does not match', async () => {
    const input = file(new Uint8Array(12));
    const staged = source({ size: 12, received: 0 });
    const controller = new AbortController();
    controller.abort();
    const upload = vi.fn().mockResolvedValue(staged);
    await expect(
      resumeTakeoutArchive(input, staged, { verify: vi.fn(), upload }, controller.signal, vi.fn()),
    ).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
    await expect(
      resumeTakeoutArchive(input, staged, { verify: vi.fn(), upload }, new AbortController().signal, vi.fn()),
    ).rejects.toThrow('frameleaf_takeout_error_acknowledgement');
  });

  it('finds the staged archive a chosen file resumes', () => {
    expect(findStagedArchive([source()], { name: 'takeout.zip', size: 100 })?.id).toBe('archive');
    expect(findStagedArchive([source()], { name: 'takeout.zip', size: 99 })).toBeUndefined();
  });
});

describe('reconciliation report', () => {
  it('writes one CSV row per item and neutralises spreadsheet formulas', () => {
    const csv = takeoutReportCsv([
      item(),
      item({
        path: '=HYPERLINK("x")',
        state: TakeoutItemState.Failed,
        assetId: null,
        warnings: [TakeoutWarning.NoSidecar],
        error: 'Album, membership',
      }),
    ]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('path,source,kind,state,assetId,albums,warnings,error');
    expect(lines[1]).toBe('Trip/IMG_1.jpg,takeout-001.zip,image,imported,asset,Trip,,');
    expect(lines[2]).toBe(`"'=HYPERLINK(""x"")",takeout-001.zip,image,failed,,Trip,no_sidecar,"Album, membership"`);
  });

  it('says how many Locked items a report from a locked session leaves out', () => {
    const takeout = {
      id: 'import',
      name: 'Import',
      state: TakeoutState.Completed,
      counts: {},
      sources: [source()],
      options: {},
    } as unknown as TakeoutResponseDto;
    const report = JSON.parse(takeoutReportJson(takeout, [item()], [], 3));
    expect(report.lockedItemsOmitted).toBe(3);
    expect(report.items).toHaveLength(1);
    expect(report.import.sources[0]).toEqual({ name: 'takeout.zip', kind: 'zip', size: 100, rejected: 0 });
  });

  it('collects every page of a listing', async () => {
    const all = Array.from({ length: 450 }, (_, index) => index);
    const load = vi.fn((offset: number, limit: number) =>
      Promise.resolve({ entries: all.slice(offset, offset + limit), total: all.length }),
    );
    expect(await collectPages(load)).toEqual(all);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
