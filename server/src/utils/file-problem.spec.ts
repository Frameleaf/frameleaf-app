import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileCause,
  FileShape,
  REPAIRABLE_CAUSES,
  classifyFileProblem,
  findJpegMarker,
  nextFixAction,
  readFileShape,
} from 'src/utils/file-problem.js';

const shape = (overrides: Partial<FileShape> = {}): FileShape => ({
  jpegMarkerAt: null,
  blank: false,
  extension: '.jpg',
  ...overrides,
});

const tga =
  "Input buffer has corrupt header: magickload_buffer: Magick: improper image header `' @ error/tga.c/ReadTGAImage/222 (null)";

describe('classifyFileProblem', () => {
  it.each<[string, string, Partial<FileShape>, boolean | null, FileCause]>([
    ['cut short', 'VipsJpeg: premature end of JPEG image', {}, null, 'cut-short'],
    ['truncated', 'File is Truncated', {}, null, 'cut-short'],
    ['incomplete', 'incomplete data', {}, null, 'cut-short'],
    ['png read error', 'vipspng: libpng read error', { extension: '.png' }, null, 'unreadable'],
    [
      'junk in front (unsupported)',
      'Input buffer contains unsupported image format',
      { jpegMarkerAt: 128 },
      null,
      'junk-in-front',
    ],
    ['blank tga message', tga, { jpegMarkerAt: null, blank: true }, null, 'blank'],
    ['junk in front (tga message)', tga, { jpegMarkerAt: 512 }, null, 'junk-in-front'],
    ['marker at start, header message', tga, { jpegMarkerAt: 0 }, null, 'junk-in-front'],
    ['marker offset on any message', 'something odd', { jpegMarkerAt: 7 }, null, 'junk-in-front'],
    ['huffman', 'Bogus Huffman table definition', {}, null, 'broken-details'],
    ['marker', 'Unsupported marker type 0x12', {}, null, 'broken-details'],
    ['app segment', 'Corrupt JPEG data: bad APP segment', {}, null, 'broken-details'],
    ['psd unsupported', 'unsupported image format', { extension: '.psd' }, null, 'not-supported'],
    ['indd unsupported', 'Unsupported', { extension: '.indd' }, null, 'not-supported'],
    ['raw unsupported', 'unsupported', { extension: '.nef' }, null, 'not-supported'],
    ['unsupported jpg without marker', 'unsupported image format', { extension: '.jpg' }, null, 'unreadable'],
    ['unsupported psd with marker at start', 'unsupported', { extension: '.psd', jpegMarkerAt: 0 }, null, 'unreadable'],
    ['timeout', 'Timeout', {}, null, 'busy'],
    ['timed out', 'operation timed out', {}, null, 'busy'],
    ['busy', 'validation_busy', {}, null, 'busy'],
    ['EIO', 'read EIO', {}, null, 'busy'],
    ['EAGAIN', 'EAGAIN: try again', {}, null, 'busy'],
    ['worker exit', 'Worker exited unexpectedly', {}, null, 'busy'],
    ['changed beats everything', 'VipsJpeg: premature end of JPEG image', { blank: true }, false, 'changed'],
    ['matching checksum is no verdict', 'vipspng: libpng read error', { extension: '.png' }, true, 'unreadable'],
    ['blank beats busy', 'Timeout', { blank: true }, null, 'blank'],
    ['busy beats cut short', 'Timeout: premature end', {}, null, 'busy'],
    ['unknown', 'who knows', {}, null, 'unreadable'],
  ])('%s', (_name, message, overrides, matchesStoredChecksum, expected) => {
    expect(classifyFileProblem({ message, shape: shape(overrides), matchesStoredChecksum })).toBe(expected);
  });
});

describe('REPAIRABLE_CAUSES', () => {
  it('holds only the three repairable causes', () => {
    expect([...REPAIRABLE_CAUSES].toSorted()).toEqual(['broken-details', 'cut-short', 'junk-in-front']);
  });
});

describe('nextFixAction', () => {
  const base = { attempt: 0, autoRepair: true, declined: false, repairableType: true, writable: true };
  it.each<[string, Parameters<typeof nextFixAction>[0], string]>([
    ['busy first try', { ...base, cause: 'busy' }, 'retry-later'],
    ['busy second try', { ...base, cause: 'busy', attempt: 2 }, 'retry-later'],
    ['busy third try', { ...base, cause: 'busy', attempt: 3 }, 'needs-you'],
    ['not supported', { ...base, cause: 'not-supported' }, 'leave-as-is'],
    ['changed', { ...base, cause: 'changed' }, 'find-original'],
    ['cut short repairs', { ...base, cause: 'cut-short' }, 'repair'],
    ['junk repairs', { ...base, cause: 'junk-in-front' }, 'repair'],
    ['broken details repairs', { ...base, cause: 'broken-details' }, 'repair'],
    ['auto repair off', { ...base, cause: 'cut-short', autoRepair: false }, 'needs-you'],
    ['declined', { ...base, cause: 'cut-short', declined: true }, 'needs-you'],
    ['not a repairable type', { ...base, cause: 'cut-short', repairableType: false }, 'needs-you'],
    ['not writable', { ...base, cause: 'cut-short', writable: false }, 'needs-you'],
    ['blank', { ...base, cause: 'blank' }, 'needs-you'],
    ['unreadable', { ...base, cause: 'unreadable' }, 'needs-you'],
  ])('%s', (_name, input, expected) => {
    expect(nextFixAction(input)).toBe(expected);
  });
});

describe('findJpegMarker', () => {
  it('finds the marker at an offset and ignores one past the window', () => {
    expect(findJpegMarker(Buffer.from([0xff, 0xd8, 0xff, 1]))).toBe(0);
    expect(findJpegMarker(Buffer.from([1, 2, 0xff, 0xd8, 0xff]))).toBe(2);
    expect(findJpegMarker(Buffer.from([1, 2, 3]))).toBeNull();
    const late = Buffer.alloc(70_000, 1);
    late.set([0xff, 0xd8, 0xff], 65_536);
    expect(findJpegMarker(late)).toBeNull();
    late.set([0xff, 0xd8, 0xff], 65_533);
    expect(findJpegMarker(late)).toBe(65_533);
  });
});

describe('readFileShape', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'file-shape-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const shapeOf = async (name: string, bytes: Buffer) => {
    const path = join(directory, name);
    await writeFile(path, bytes);
    return readFileShape(path);
  };

  it('reports a marker at the start', async () => {
    expect(await shapeOf('a.JPG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toEqual({
      jpegMarkerAt: 0,
      blank: false,
      extension: '.jpg',
    });
  });
  it('reports the offset of a marker behind junk', async () => {
    const bytes = Buffer.concat([Buffer.alloc(128, 7), Buffer.from([0xff, 0xd8, 0xff, 0xe0])]);
    expect(await shapeOf('b.jpg', bytes)).toMatchObject({ jpegMarkerAt: 128, blank: false });
  });
  it('finds no marker past 64 KiB', async () => {
    const bytes = Buffer.concat([Buffer.alloc(70_000, 7), Buffer.from([0xff, 0xd8, 0xff, 0xe0])]);
    expect(await shapeOf('c.jpg', bytes)).toMatchObject({ jpegMarkerAt: null, blank: false });
  });
  it('is blank when every byte is 0x00, or every byte is 0xFF, across chunks', async () => {
    expect(await shapeOf('d.jpg', Buffer.alloc(200_000, 0))).toMatchObject({ jpegMarkerAt: null, blank: true });
    expect(await shapeOf('e.jpg', Buffer.alloc(200_000, 0xff))).toMatchObject({ jpegMarkerAt: null, blank: true });
  });
  it('is not blank when a late byte differs, or the bytes mix 0x00 and 0xFF', async () => {
    const late = Buffer.alloc(200_000, 0);
    late[199_999] = 1;
    expect((await shapeOf('f.jpg', late)).blank).toBe(false);
    expect((await shapeOf('g.jpg', Buffer.from([0, 0xff]))).blank).toBe(false);
  });
  it('treats an empty file as blank', async () => {
    expect(await shapeOf('h.jpg', Buffer.alloc(0))).toEqual({ jpegMarkerAt: null, blank: true, extension: '.jpg' });
  });
});
