import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/piwigo/16.4.0-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/piwigo/16.4.0-mariadb.json' with { type: 'json' };
import { type ImportManifest } from 'src/library-import/manifest.js';
import { piwigoProjections } from 'src/library-import/piwigo-projections.js';
import * as piwigo from 'src/library-import/piwigo-source.js';
import { type SourceArchiveRecord } from 'src/library-import/source-archive-codec.js';

type Result = { manifest: ImportManifest; archive: SourceArchiveRecord[] };
const input = () => ({
  source: {
    kind: 'piwigo' as const,
    version: '16.4.0',
    identity: 'synthetic-restore',
    revision: 'frozen-1',
    schemaSha256: fixture.schemaSha256,
  },
  inventory: {
    complete: true,
    ownershipComplete: true,
    privacyComplete: true,
    writersStopped: true,
    revisionBefore: 'frozen-1',
    revisionAfter: 'frozen-1',
  },
  photoOwners: Object.fromEntries(content.rows.images.map((row) => [String(row.id), '3'])),
  albumOwners: Object.fromEntries(content.rows.categories.map((row) => [String(row.id), '3'])),
  reviewedCaptureOffsets: Object.fromEntries(content.rows.images.map((row) => [String(row.id), 0])),
  reviewedMissingImageIds: ['1', '2'],
  files: content.originals.map((row) => ({
    id: 'image:' + row.id + ':original',
    path: row.path.replace(/^\.\//u, ''),
    bytes: row.bytes,
    sha256: row.sha256,
    role: 'original' as const,
    modifiedAt: '2026-11-01T21:59:22Z',
  })),
});
const rows = () =>
  Object.fromEntries(
    Object.entries(content.rows).map(([table, records]) => [
      table,
      records.map((record) =>
        Object.fromEntries(
          Object.entries(record).map(([name, value]) => [
            name,
            typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value,
          ]),
        ),
      ),
    ]),
  ) as Record<piwigo.PiwigoTable, piwigo.PiwigoRow[]>;
const read = async (value = input(), records = rows()): Promise<Result> => {
  const adapter = Reflect.get(piwigo, 'readPiwigoManifest') as
    | ((
        source: AsyncIterable<{ table: piwigo.PiwigoTable; rows: piwigo.PiwigoRow[] }>,
        value: unknown,
      ) => Promise<Result>)
    | undefined;
  expect(adapter).toBeTypeOf('function');
  async function* source() {
    for (const table of Object.keys(piwigoProjections) as piwigo.PiwigoTable[])
      yield { table, rows: await Promise.resolve(records[table]) };
  }
  return adapter!(source(), value);
};
describe('Piwigo common manifest mapping', () => {
  it('preserves native originals, manual metadata, album membership and owner favourites', async () => {
    const { manifest, archive } = await read();
    expect(manifest.assets).toHaveLength(4);
    expect(manifest.files).toHaveLength(4);
    expect(manifest.users.map((user) => user.id)).toEqual(['1', '3', '4', '5']);
    expect(manifest.assets.find((asset) => asset.id === '4')).toMatchObject({
      ownerId: '3',
      primaryFileId: 'image:4:original',
      localDateTime: '2019-03-17T14:15:16',
      metadata: {
        title: 'Manually edited title',
        description: 'Manually edited caption',
        takenAt: '2019-03-17T14:15:16.000Z',
        latitude: null,
        longitude: null,
      },
    });
    expect(manifest.assets.find((asset) => asset.id === '6')?.metadata.favorite).toBe(true);
    expect(manifest.albums.find((album) => album.id === '2:owner:3')?.assetIds).toEqual(['4']);
    for (const album of manifest.albums) expect(album.members).toEqual([]);
    expect(archive.length).toBeGreaterThan(30);
    for (const original of content.originals)
      expect(manifest.files.find((file) => file.path === original.path.slice(2))?.sha256).toBe(
        createHash('sha256').update(Buffer.from(original.originalBase64, 'base64')).digest('hex'),
      );
  });
  it.each(Object.entries(content.expected.visibleImageIds))(
    'matches independently captured visibility for %s',
    async (name, ids) => {
      const owner = { alice: '3', bob: '4', mallory: '5' }[name]!;
      for (const photo of content.rows.images) {
        const value = input();
        value.photoOwners[String(photo.id)] = owner;
        if (ids.includes(photo.id)) await expect(read(value)).resolves.toBeDefined();
        else await expect(read(value)).rejects.toThrow('PIWIGO_OWNER_REVIEW_REQUIRED');
      }
    },
  );
  it('does not infer ownership from uploader, displayed author or matching email', async () => {
    const value = input();
    delete value.photoOwners['4'];
    await expect(read(value)).rejects.toThrow('PIWIGO_OWNER_REVIEW_REQUIRED');
  });
  it('keeps each owner favourite separate when changing an explicitly accessible owner', async () => {
    const value = input();
    value.photoOwners['6'] = '4';
    const { manifest } = await read(value);
    expect(manifest.assets.find((asset) => asset.id === '6')?.metadata.favorite).toBe(false);
    expect(manifest.albums.find((album) => album.id === '3:owner:4')?.assetIds).toEqual(['6']);
  });
  it('rejects owners restricted from downloading originals', async () => {
    const records = rows();
    records.user_infos.find((row) => row.user_id === 3n)!.enabled_high = 'false';
    await expect(read(input(), records)).rejects.toThrow('PIWIGO_OWNER_REVIEW_REQUIRED');
  });
  it('does not treat admin status as a private-category grant', async () => {
    const value = input();
    value.photoOwners['4'] = '1';
    const records = rows();
    records.user_access = records.user_access.filter((row) => !(row.user_id === 1n && row.cat_id === 2n));
    await expect(read(value, records)).rejects.toThrow('PIWIGO_OWNER_REVIEW_REQUIRED');
  });
  it('preserves exact SQL wall-clock precision with an explicitly reviewed offset', async () => {
    const records = rows();
    records.images.find((row) => row.id === 4n)!.date_creation = '2019-03-17 14:15:16.123456';
    const value = input();
    value.reviewedCaptureOffsets['4'] = 120;
    expect((await read(value, records)).manifest.assets.find((asset) => asset.id === '4')).toMatchObject({
      localDateTime: '2019-03-17T14:15:16.123456',
      metadata: { takenAt: '2019-03-17T12:15:16.123456Z' },
    });
  });
  it('retains additional original formats instead of representatives', async () => {
    const records = rows();
    records.image_format.push({ format_id: 10n, image_id: 4n, ext: 'dng', filesize: 1n });
    const value = input();
    value.files.push({
      ...value.files[1],
      id: 'image:4:format:10',
      path: value.files[1].path.replace(/([^/]+)\.png$/u, 'pwg_format/$1.dng'),
      sha256: 'b'.repeat(64),
    });
    const { manifest } = await read(value, records);
    expect(manifest.assets.find((asset) => asset.id === '4')?.fileIds).toEqual([
      'image:4:original',
      'image:4:format:10',
    ]);
  });
  it('preserves manual tags, GPS and category descriptions', async () => {
    const records = rows();
    records.tags.push({ id: 10n, name: 'Manual tag', url_name: 'manual-tag' });
    records.image_tag.push({ image_id: 4n, tag_id: 10n });
    Object.assign(
      records.images.find((row) => row.id === 4n)!,
      { latitude: '52.123456', longitude: '-113.123456' },
    );
    records.categories.find((row) => row.id === 2n)!.comment = 'Manual album caption';
    const { manifest } = await read(input(), records);
    expect(manifest.assets.find((asset) => asset.id === '4')?.metadata).toMatchObject({
      latitude: 52.123456,
      longitude: -113.123456,
      tags: ['Manual tag'],
    });
    expect(manifest.albums.find((album) => album.id === '2:owner:3')?.description).toBe('Manual album caption');
  });
  it.each([
    'schema',
    'revision',
    'complete',
    'owners',
    'offset',
    'offset-range',
    'missing-review',
    'extra-review',
    'file',
    'path',
  ] as const)('refuses %s before destination writes', async (kind) => {
    const value = input();
    if (kind === 'schema') value.source.schemaSha256 = '0'.repeat(64);
    else if (kind === 'revision') value.inventory.revisionAfter = 'changed';
    else if (kind === 'complete') value.inventory.complete = false;
    else if (kind === 'owners') value.photoOwners.stale = '3';
    else if (kind === 'offset') delete value.reviewedCaptureOffsets['4'];
    else if (kind === 'offset-range') value.reviewedCaptureOffsets['4'] = 900;
    else if (kind === 'missing-review') value.reviewedMissingImageIds = [];
    else if (kind === 'extra-review') value.reviewedMissingImageIds.push('999');
    else if (kind === 'file') value.files.pop();
    else value.files[0].path = '../escape.png';
    await expect(read(value)).rejects.toThrow(/PIWIGO_/);
  });
  it('refuses a category cycle and unknown dangling tag references', async () => {
    const records = rows();
    records.categories[0].id_uppercat = 1n;
    await expect(read(input(), records)).rejects.toThrow('PIWIGO_CATEGORY_GRAPH_INVALID');
    const other = rows();
    other.image_tag.push({ image_id: 4n, tag_id: 999n });
    await expect(read(input(), other)).rejects.toThrow('PIWIGO_RELATIONSHIPS_INVALID');
  });
});
