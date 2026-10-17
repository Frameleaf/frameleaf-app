import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  assembleAssetUploadParts,
  parseAssetUploadHeaders,
  writeAssetUploadPart,
} from 'src/utils/asset-upload-resource.js';

describe('durable upload bytes', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'fl225-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('retains only the actual contiguous prefix on a disconnected body', async () => {
    const input = Readable.from(
      (function* () {
        yield Buffer.from('first');
        throw new Error('disconnect');
      })(),
    );
    const part = await writeAssetUploadPart(folder, input, 20);
    expect(part.interrupted).toBe(true);
    expect(part.size).toBe(5);
    expect(await readFile(part.path)).toEqual(Buffer.from('first'));
  });

  it('rejects observed oversize without leaving bytes', async () => {
    await expect(writeAssetUploadPart(folder, Readable.from([Buffer.from('12345')]), 4)).rejects.toThrow();
    expect(await readdir(folder)).toEqual([]);
  });

  it('hashes all ordered parts and creates no output on a whole digest mismatch', async () => {
    const first = await writeAssetUploadPart(folder, Readable.from([Buffer.from('abc')]), 20);
    const second = await writeAssetUploadPart(folder, Readable.from([Buffer.from('def')]), 20);
    const parts = [
      { ...first, offset: 0 },
      { ...second, offset: 3 },
    ];
    const expected = createHash('sha256').update('abcdef').digest();
    const result = await assembleAssetUploadParts(folder, parts, 6, expected, '.jpg');
    expect(await readFile(result.path)).toEqual(Buffer.from('abcdef'));
    expect(result.sha256).toEqual(expected);
    expect(result.sha1).toEqual(createHash('sha1').update('abcdef').digest());
    const before = await readdir(folder);
    await expect(assembleAssetUploadParts(folder, parts, 6, Buffer.alloc(32), '.jpg')).rejects.toThrow();
    expect(await readdir(folder)).toEqual(before);
    await expect(assembleAssetUploadParts(folder, [{ ...first, offset: 1 }], 5, expected, '.jpg')).rejects.toThrow();
  });
});

describe('native upload headers', () => {
  const digest = `sha-256=:${Buffer.alloc(32).toString('base64')}:`;
  const metadata = Buffer.from(
    JSON.stringify({
      filename: 'image.jpg',
      fileCreatedAt: '2026-09-30T00:00:00Z',
      fileModifiedAt: '2026-09-30T00:00:00Z',
    }),
  ).toString('base64url');
  const headers = {
    'upload-draft-interop-version': '9',
    'upload-complete': '?0',
    'repr-digest': digest,
    'asset-metadata': metadata,
    'content-type': 'image/jpeg',
  };
  it('requires an unambiguous real SHA256 and typed metadata', () => {
    expect(parseAssetUploadHeaders(headers).checksum).toEqual(Buffer.alloc(32));
    for (const value of [undefined, digest + ', ' + digest, 'sha-256=:YWJj:', 'sha-256=:!!!:']) {
      expect(() => parseAssetUploadHeaders({ ...headers, 'repr-digest': value })).toThrow();
    }
    expect(() => parseAssetUploadHeaders({ ...headers, 'asset-metadata': 'garbage' })).toThrow();
    expect(() => parseAssetUploadHeaders({ ...headers, 'upload-draft-interop-version': '12' })).toThrow();
    expect(() => parseAssetUploadHeaders({ ...headers, 'content-encoding': 'gzip' })).toThrow();
  });
  it('retains only the explicit live-photo deferral declaration in typed JSON metadata', () => {
    const encode = (publication: string) =>
      Buffer.from(
        JSON.stringify({
          filename: 'image.jpg',
          fileCreatedAt: '2026-09-30T00:00:00Z',
          fileModifiedAt: '2026-09-30T00:00:00Z',
          publication,
        }),
      ).toString('base64url');
    expect(parseAssetUploadHeaders({ ...headers, 'asset-metadata': encode('live-photo') }).metadata).toHaveProperty(
      'publication',
      'live-photo',
    );
    expect(() => parseAssetUploadHeaders({ ...headers, 'asset-metadata': encode('auto') })).toThrow();
    const unknown = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(metadata, 'base64url').toString()), unknown: true }),
    ).toString('base64url');
    expect(() => parseAssetUploadHeaders({ ...headers, 'asset-metadata': unknown })).toThrow();
  });
  it('accepts JSON booleans and the legacy strings for isFavorite, and a numeric duration (FL-218)', () => {
    const encode = (extra: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(metadata, 'base64url').toString()), ...extra })).toString(
        'base64url',
      );
    const parse = (extra: Record<string, unknown>) =>
      parseAssetUploadHeaders({ ...headers, 'asset-metadata': encode(extra) }).metadata;

    expect(parse({ isFavorite: true }).isFavorite).toBe(true);
    expect(parse({ isFavorite: false }).isFavorite).toBe(false);
    expect(parse({ isFavorite: 'true' }).isFavorite).toBe(true);
    expect(parse({ isFavorite: 'false' }).isFavorite).toBe(false);
    expect(parse({}).isFavorite).toBeUndefined();
    expect(parse({ duration: 4250, isFavorite: true })).toMatchObject({ duration: 4250, isFavorite: true });
    for (const isFavorite of [1, 0, null, 'yes', 'TRUE', {}]) {
      expect(() => parse({ isFavorite })).toThrow();
    }
  });
  it('carries an iCloud source identity, strictly typed (FL-296)', () => {
    const encode = (sourceIdentity: unknown) =>
      Buffer.from(
        JSON.stringify({ ...JSON.parse(Buffer.from(metadata, 'base64url').toString()), sourceIdentity }),
      ).toString('base64url');
    const cloudIdentifier = '32A01DD9-75DF-41B2-8773-80C153D73A5A:001:AQohY6yKZR0+tXlMi9FUQ82zySGo';
    const source = { kind: 'icloud', cloudIdentifier, role: 'original' };
    expect(parseAssetUploadHeaders({ ...headers, 'asset-metadata': encode(source) }).metadata.sourceIdentity).toEqual(
      source,
    );
    const edit = { ...source, role: 'edit-render', editVersion: 'v1' };
    expect(parseAssetUploadHeaders({ ...headers, 'asset-metadata': encode(edit) }).metadata.sourceIdentity).toEqual(
      edit,
    );
    for (const invalid of [
      { ...source, role: 'edit-render' },
      { ...source, editVersion: 'v1' },
      { ...source, kind: 'google' },
      { ...source, title: 'x' },
      { ...source, claimId: 'not-a-uuid' },
    ]) {
      expect(() => parseAssetUploadHeaders({ ...headers, 'asset-metadata': encode(invalid) })).toThrow();
    }
  });
});
