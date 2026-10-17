import {
  TakeoutItemKind,
  TakeoutItemState,
  TakeoutPhase,
  TakeoutSourceKind,
  TakeoutState,
  TakeoutWarning,
  type TakeoutCountsDto,
  type TakeoutItemResponseDto,
  type TakeoutSourceResponseDto,
} from '@frameleaf/sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import {
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
  takeoutSourcesStaged,
  takeoutStep,
  takeoutView,
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

const counts = (review = 0) => ({ review }) as TakeoutCountsDto;
const at = (
  phase: TakeoutPhase,
  state: TakeoutState,
  extra: { sources?: TakeoutSourceResponseDto[]; review?: number } = {},
) => ({
  phase,
  state,
  sources: extra.sources ?? [source()],
  counts: counts(extra.review),
});

describe('takeout screens', () => {
  it('opens on the start screen, then uploads, checks and imports', () => {
    expect(takeoutView(undefined)).toBe('start');
    expect(takeoutView(at(TakeoutPhase.Sources, TakeoutState.Sources, { sources: [] }))).toBe('upload');
    expect(takeoutView(at(TakeoutPhase.Scanning, TakeoutState.Scanning))).toBe('checking');
    expect(takeoutView(at(TakeoutPhase.Scanning, TakeoutState.Queued))).toBe('checking');
    expect(takeoutView(at(TakeoutPhase.Review, TakeoutState.Review))).toBe('ready');
    expect(takeoutView(at(TakeoutPhase.Importing, TakeoutState.Paused))).toBe('importing');
    expect(takeoutView(at(TakeoutPhase.Completed, TakeoutState.Completed))).toBe('done');
    expect(takeoutView(at(TakeoutPhase.Importing, TakeoutState.Failed))).toBe('done');
  });

  it('says an upload left part-way stopped, unless this page is sending it now', () => {
    const partial = at(TakeoutPhase.Sources, TakeoutState.Sources, { sources: [source({ received: 40 })] });
    expect(takeoutView(partial)).toBe('stopped');
    expect(takeoutView(partial, true)).toBe('upload');
  });

  it('asks again after a check that stopped, and holds back photos the owner wanted to choose for', () => {
    expect(takeoutView(at(TakeoutPhase.Scanning, TakeoutState.Failed))).toBe('check-failed');
    expect(takeoutView(at(TakeoutPhase.Completed, TakeoutState.Completed, { review: 3 }))).toBe('unclear');
  });

  it('places each screen under Upload, Check or Import', () => {
    expect(takeoutStep('stopped')).toBe(0);
    expect(takeoutStep('check-failed')).toBe(1);
    expect(takeoutStep('unclear')).toBe(2);
    expect(takeoutStep('done')).toBe(3);
  });

  it('keeps watching while the server is moving, and not while it waits for the owner', () => {
    expect(isTakeoutMoving(TakeoutState.Scanning)).toBe(true);
    expect(isTakeoutMoving(TakeoutState.Queued)).toBe(true);
    expect(isTakeoutMoving(TakeoutState.Paused)).toBe(false);
    expect(isTakeoutBusy(TakeoutState.Paused)).toBe(true);
    expect(isTakeoutBusy(TakeoutState.Review)).toBe(false);
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
      includeTrashed: true,
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

describe('import report', () => {
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

  it('collects every page of a listing', async () => {
    const all = Array.from({ length: 450 }, (_, index) => index);
    const load = vi.fn((offset: number, limit: number) =>
      Promise.resolve({ entries: all.slice(offset, offset + limit), total: all.length }),
    );
    expect(await collectPages(load)).toEqual(all);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
