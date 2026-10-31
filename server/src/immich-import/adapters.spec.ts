import {
  CONTENT_TABLES,
  clusterId,
  frozenSource,
  newestContainedRelease,
  transformRow,
  vectorCompatible,
  withForkContent,
} from 'src/immich-import/adapters.js';
import { EmbeddingTransferEvidence } from 'src/immich-import/embeddings.js';

describe('frozen Immich adapters', () => {
  it.each([
    '2.0.0',
    '2.2.3',
    '2.3.1',
    '2.4.1',
    '2.5.6',
    '2.6.3',
    '2.7.5',
    '3.0.0',
    '3.0.1',
    '3.0.2',
    '3.0.3',
    '3.1.0',
    '3.2.0',
    '3.2.1',
    '3.2.2',
    '3.2.3',
    '3.2.4',
  ])('pins %s to a complete immutable snapshot', (version) => {
    const source = frozenSource(version);
    expect(source.commit).toMatch(/^[a-f\d]{40}$/u);
    expect(source.migrations.length).toBeGreaterThan(30);
    for (const table of CONTENT_TABLES) {
      const shape = source.tables[table];
      if (shape) {
        expect(shape.key.length).toBeGreaterThan(0);
        expect(new Set(shape.columns).size).toBe(shape.columns.length);
        expect(Object.keys(shape.types)).toEqual(shape.columns);
      }
    }
  });

  it.each(['2.0.0-rc.1', '1.144.1', 'latest', '__proto__'])('rejects unsupported %s', (version) => {
    expect(() => frozenSource(version)).toThrow('UNSUPPORTED_SOURCE_VERSION');
  });

  it.each([
    ['2.9.0', '2.7.5'],
    ['3.2.0-rc.0', '3.1.0'],
    ['3.2.5', '3.2.4'],
    ['3.3.3', '3.2.4'],
    ['4.0.0', '3.2.4'],
  ])('reads %s through the newest frozen shape at or below it (%s)', (version, frozen) => {
    expect(frozenSource(version)).toEqual(frozenSource(frozen));
  });

  it('finds the newest frozen release a source ledger fully contains', () => {
    expect(newestContainedRelease([...frozenSource('3.2.4').migrations, 'future-migration'])).toBe('3.2.4');
    expect(newestContainedRelease(frozenSource('3.1.0').migrations)).toBe('3.1.0');
    expect(newestContainedRelease(['unrelated'])).toBeUndefined();
  });

  it('maps Immich 3.3 GeoNames country names back to the names Frameleaf geocodes', () => {
    const country = (value: string | null) => transformRow('asset_exif', { country: value }, false).country;
    expect(country('United States')).toBe('United States of America');
    expect(country('Ivory Coast')).toBe("Cote d'Ivoire");
    expect(country('Germany')).toBe('Germany');
    expect(country(null)).toBeNull();
  });

  it('converts legacy people into deterministic per-owner groups without changing identities or credentials', () => {
    const ownerId = 'e2730c2a-8387-4d40-886f-582858ab7a65';
    const user = transformRow(
      'user',
      { id: ownerId, password: '$2b$12$preserved', pinCode: 'pin-hash', updateId: 'old' },
      true,
    );
    expect(user).toEqual({
      id: ownerId,
      password: '$2b$12$preserved',
      pinCode: 'pin-hash',
      clusterGroupId: clusterId(ownerId),
    });
    expect(clusterId(ownerId)).not.toBe(clusterId('another-owner'));
    expect(transformRow('person', { id: 'person', ownerId, faceAssetId: 'face' }, true)).toEqual({
      personGroupId: 'person',
      ownerId,
      faceAssetId: 'face',
    });
    expect(transformRow('asset_face', { id: 'face', personId: 'person' }, true)).toEqual({
      id: 'face',
      personGroupId: 'person',
    });
  });

  it('keeps modern shared clusters and privacy fields intact', () => {
    const row = { id: 'asset', visibility: 'locked', ownerId: 'owner', deletedAt: null, checksum: String.raw`\x1234` };
    expect(transformRow('asset', row, false)).toEqual(row);
    expect(frozenSource('3.0.0').tables.person.columns).toContain('id');
    expect(frozenSource('3.2.4').tables.person.columns).toContain('personGroupId');
    expect(CONTENT_TABLES).toContain('album_user');
    expect(CONTENT_TABLES).toContain('partner');
    expect(CONTENT_TABLES).not.toContain('session');
    expect(CONTENT_TABLES).not.toContain('api_key');
    expect(CONTENT_TABLES).not.toContain('system_metadata');
  });

  it('requires producer evidence, selected models, destination dimensions and finite vector values', () => {
    const evidence: EmbeddingTransferEvidence = {
      sourceDimensions: 768,
      destinationDimensions: 768,
      sourceConfiguredModel: 'clip-a',
      destinationConfiguredModel: 'clip-a',
      producingModel: 'clip-a',
    };
    const vector = JSON.stringify(Array.from({ length: 768 }, () => 0.1));
    expect(vectorCompatible(vector, evidence)).toBe(true);
    expect(vectorCompatible(vector, { ...evidence, producingModel: null })).toBe(false);
    expect(vectorCompatible(vector, { ...evidence, destinationDimensions: 512 })).toBe(false);
    expect(vectorCompatible(vector, { ...evidence, destinationConfiguredModel: 'clip-b' })).toBe(false);
    expect(vectorCompatible('[0,1]', evidence)).toBe(false);
    expect(vectorCompatible(vector)).toBe(false);
  });

  it('reads pre-Frameleaf fork album nesting and smart albums only when the source has them', () => {
    const upstream = frozenSource('2.7.5');
    const column = (type: string) => ({ type, not_null: false, default: null, identity: '', generated: '' });
    const structure = (tables: Record<string, Record<string, ReturnType<typeof column>>>) => ({
      tables,
      constraints: [],
      uniqueIndexes: [],
      enums: [],
    });
    const plain = withForkContent(upstream, structure({}));
    expect(plain.tables.album.columns).not.toContain('parentId');
    expect(plain.tables.smart_album).toBeUndefined();

    const fork = withForkContent(
      upstream,
      structure({
        album: { parentId: column('uuid'), icon: column('character varying'), sortOrder: column('double precision') },
        smart_album_exclusion: { smartAlbumId: column('uuid'), assetId: column('uuid') },
      }),
    );
    expect(fork.tables.album.columns).toEqual([...upstream.tables.album.columns, 'parentId', 'icon', 'sortOrder']);
    expect(Object.keys(fork.tables.album.types)).toEqual(fork.tables.album.columns);
    expect(fork.tables.smart_album_exclusion.key).toEqual(['smartAlbumId', 'assetId']);
    // A partial or retyped fork table is not read.
    expect(fork.tables.smart_album).toBeUndefined();
    // The frozen shape is never mutated.
    expect(upstream.tables.album.columns).not.toContain('parentId');
    // 2.x views select the fork columns too.
    if (fork.views.album) expect(fork.views.album).toContain('"parentId"');
  });
});
