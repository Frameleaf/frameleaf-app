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
  it('only admits a design capture marker with a narrow upload metadata shape', () => {
    const metadata = {
      filename: 'capture.jpg',
      fileCreatedAt: '2026-10-28T12:00:00Z',
      fileModifiedAt: '2026-10-28T12:00:00Z',
      publication: 'capture',
      captureId: '10000000-0000-4000-8000-000000000001',
      libraryScope: 'design',
    };
    const headers = (extra: Record<string, unknown>) => ({
      'upload-draft-interop-version': '9',
      'upload-complete': '?0',
      'content-type': 'image/jpeg',
      'repr-digest': `sha-256=:${Buffer.alloc(32).toString('base64')}:`,
      'asset-metadata': Buffer.from(JSON.stringify({ ...metadata, ...extra })).toString('base64url'),
    });
    expect(parseAssetUploadHeaders(headers({})).metadata.publication).toBe('capture');
    for (const extra of [
      { libraryScope: 'personal' },
      { libraryScope: 'both' },
      { isFavorite: true },
      { visibility: 'locked' },
      { metadata: [] },
      { captureActor: 'key:other' },
    ]) {
      expect(() => parseAssetUploadHeaders(headers(extra))).toThrow('Invalid Asset-Metadata');
    }
  });
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

  it('bounds streamed authority reads by bytes and checks the final tail before retaining it', async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    await writeAssetUploadPart(
      folder,
      Readable.from(Array.from({ length: 256 }, () => Buffer.alloc(4096))),
      2 ** 20,
      check,
    );
    expect(check).toHaveBeenCalledTimes(2);
    const retained = await readdir(folder);
    check.mockReset().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('source revoked'));
    await expect(writeAssetUploadPart(folder, Readable.from([Buffer.from('tail')]), 4, check)).rejects.toThrow(
      'source revoked',
    );
    expect(await readdir(folder)).toEqual(retained);
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
  it.each(['personal', 'design', 'both'])('retains %s scope before upload publication', (libraryScope) => {
    const value = { ...JSON.parse(Buffer.from(metadata, 'base64url').toString()), libraryScope };
    const parsed = parseAssetUploadHeaders({
      ...headers,
      'asset-metadata': Buffer.from(JSON.stringify(value)).toString('base64url'),
    });
    expect(parsed.metadata.libraryScope).toBe(libraryScope);
  });

  it('rejects an unknown library scope at upload admission', () => {
    const value = { ...JSON.parse(Buffer.from(metadata, 'base64url').toString()), libraryScope: 'public' };
    expect(() =>
      parseAssetUploadHeaders({
        ...headers,
        'asset-metadata': Buffer.from(JSON.stringify(value)).toString('base64url'),
      }),
    ).toThrow('Invalid Asset-Metadata');
  });

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
  it('binds folder uploads to an opaque source, run and planned item without exposing local paths', () => {
    const source = {
      kind: 'folder',
      sourceId: '11111111-1111-4111-8111-111111111111',
      runId: '22222222-2222-4222-8222-222222222222',
      itemId: '33333333-3333-4333-8333-333333333333',
    };
    const parse = (sourceIdentity: unknown) =>
      parseAssetUploadHeaders({
        ...headers,
        'asset-metadata': Buffer.from(
          JSON.stringify({
            ...JSON.parse(Buffer.from(metadata, 'base64url').toString()),
            sourceIdentity,
          }),
        ).toString('base64url'),
      });
    expect(parse(source).metadata.sourceIdentity).toEqual(source);
    for (const invalid of [
      { ...source, runId: 'bad' },
      { ...source, root: '/local/photos' },
      { ...source, itemId: undefined },
      { ...source, role: 'original' },
    ]) {
      expect(() => parse(invalid)).toThrow();
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
