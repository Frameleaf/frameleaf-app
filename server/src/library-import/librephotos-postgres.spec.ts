import { describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/librephotos/1.5.1-postgres-content.json' with { type: 'json' };
import inherited from 'src/library-import/fixtures/librephotos/1.5.1-postgres-inheritance.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/librephotos/1.5.1-postgres18.json' with { type: 'json' };
import { createLibrephotosPostgresDecoder } from 'src/library-import/librephotos-postgres.js';
import { LibrephotosTable } from 'src/library-import/librephotos.js';
import { PostgresSourceSchema, postgresSchemaFingerprint } from 'src/library-import/postgres-schema.js';

const create = (schema: PostgresSourceSchema = fixture.structure) =>
  createLibrephotosPostgresDecoder(schema, fixture.source.version, fixture.source.database.version);

describe('LibrePhotos qualified PostgreSQL values', () => {
  it('refuses the native inheritance change that broadens membership SELECT results', () => {
    const schema: PostgresSourceSchema = structuredClone(fixture.structure);
    schema.inheritance = inherited.patch.inheritance;
    for (const name of ['columns', 'constraints'] as const) {
      for (const changed of inherited.patch[name]) {
        const index = schema[name].findIndex(
          (row) => row.table_name === changed.table_name && row.name === changed.name,
        );
        expect(index).toBeGreaterThanOrEqual(0);
        schema[name][index] = changed;
      }
    }
    expect(inherited.rowCounts).toEqual({ before: 1, after: 2 });
    expect(() => create(schema)).toThrow('LIBREPHOTOS_POSTGRES_SCHEMA_UNQUALIFIED');
  });

  it('matches the actual read-only catalog and rejects changed privacy structure', () => {
    expect(postgresSchemaFingerprint(fixture.structure)).toBe(fixture.schemaSha256);
    const schema = structuredClone(fixture.structure);
    schema.relations.find((row) => row.name === 'api_photo')!.row_security = true;
    expect(() => create(schema)).toThrow('LIBREPHOTOS_POSTGRES_SCHEMA_UNQUALIFIED');
  });

  it('requires the pinned source and database versions before accepting rows', () => {
    expect(() => createLibrephotosPostgresDecoder(fixture.structure, 'unknown', '18.6')).toThrow(
      'LIBREPHOTOS_VERSION_UNQUALIFIED',
    );
    expect(() => createLibrephotosPostgresDecoder(fixture.structure, fixture.source.version, '19beta4')).toThrow(
      'LIBREPHOTOS_POSTGRES_ENGINE_UNQUALIFIED',
    );
  });

  it('decodes all captured records using actual column types, including UUID and JSONB relationships', () => {
    const decoder = create();
    let total = 0;
    for (const [table, rows] of Object.entries(content.rows)) {
      for (const row of rows) {
        const decoded = decoder.decode(table as LibrephotosTable, row);
        expect(Object.keys(decoded).sort()).toEqual(Object.keys(row).sort());
        total++;
      }
    }
    expect(total).toBe(56);
    const aliceId = content.expected.photos.alice.replaceAll('-', '');
    const photos = content.rows.api_photo.map((row) => decoder.decode('api_photo', row));
    const alice = photos.find((row) => row.id === aliceId)!;
    expect(alice.owner_id).toBe(BigInt(content.expected.actors.alice));
    expect(alice.hidden).toBe(0n);
    expect(alice.exif_timestamp).toBe('2020-06-10 12:30:00');
    expect(alice.exif_timestamp_offset).toBe(-360n);
    const bob = photos.find((row) => row.owner_id === BigInt(content.expected.actors.bob))!;
    expect(bob.main_file_id).toBe(alice.main_file_id);
    expect(bob.timestamp).toBe('2021-02-04 08:09:10');
    expect(bob.exif_timestamp_offset).toBeNull();
    const metadata = content.rows.api_photometadata.map((row) => decoder.decode('api_photometadata', row));
    expect(JSON.parse(String(metadata.find((row) => row.photo_id === aliceId)!.edited_keywords))).toEqual([
      'family',
      'summer',
    ]);
  });

  it('preserves exact large integers, nullable values, fractional timestamps and zero coordinates', () => {
    const row = {
      ...content.rows.api_photo[0],
      size: '9007199254740993',
      exif_timestamp: '2020-06-10 12:30:00.123456+00',
      exif_gps_lat: '0',
      exif_gps_lon: '0',
    };
    const decoded = create().decode('api_photo', row);
    expect(decoded.size).toBe(9_007_199_254_740_993n);
    expect(decoded.exif_timestamp).toBe('2020-06-10 12:30:00.123456');
    expect(decoded.exif_gps_lat).toBe(0);
    expect(decoded.exif_gps_lon).toBe(0);
    expect(decoded.exif_json).toBeNull();
  });

  it('rejects missing or additional columns rather than exporting credentials or dropping values', () => {
    const decoder = create();
    expect(() =>
      decoder.decode('api_user', { ...content.rows.api_user[0], password: 'private-password-hash' }),
    ).toThrow('LIBREPHOTOS_POSTGRES_ROW_INVALID');
    const { share_people_names: _missing, ...row } = content.rows.api_user[0];
    expect(() => decoder.decode('api_user', row)).toThrow('LIBREPHOTOS_POSTGRES_ROW_INVALID');
    expect(() => decoder.decode('django_session' as never, {})).toThrow('LIBREPHOTOS_TABLE_NOT_ALLOWED');
    expect(() => decoder.decode('__proto__' as never, {})).toThrow('LIBREPHOTOS_TABLE_NOT_ALLOWED');
  });

  it.each([
    ['hidden', '2'],
    ['owner_id', '1.5'],
    ['exif_gps_lat', 'NaN'],
    ['exif_gps_lon', 'Infinity'],
    ['id', 'not-a-uuid'],
    ['exif_timestamp', '2020-06-10 12:30:00-06'],
    ['exif_json', '{malformed'],
    ['owner_id', null],
    ['hidden', true],
    ['exif_gps_lat', '0x10'],
    ['exif_gps_lat', ' '],
  ])('rejects invalid %s value %s without including it in an error', (field, value) => {
    expect(() => create().decode('api_photo', { ...content.rows.api_photo[0], [field]: value } as never)).toThrow(
      'LIBREPHOTOS_POSTGRES_ROW_INVALID',
    );
  });

  it('fingerprints structural object keys consistently without ignoring additional source structure', () => {
    const { schemas, ...rest } = fixture.structure;
    const reordered = { ...rest, schemas };
    expect(postgresSchemaFingerprint(reordered)).toBe(fixture.schemaSha256);
    const changed = structuredClone(fixture.structure);
    changed.schemas.push({ name: 'unexpected_tenant' });
    expect(() => create(changed)).toThrow('LIBREPHOTOS_POSTGRES_SCHEMA_UNQUALIFIED');
  });
});
