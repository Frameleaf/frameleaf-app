import { ConflictException } from '@nestjs/common';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('native upload physical alias fence', () => {
  const physical = { id: 'physical-id', path: '/data/master.jpg' };
  const expected = {
    masterOwnerId: 'master',
    checksum: Buffer.from('sha256'),
    size: 8,
    ingestion: { resourceId: 'resource', token: 'token', ownerId: 'owner' },
  };
  it.each(['expired claim', 'changed canonical target', 'removed destination'])(
    'refuses %s before completing an alias',
    async (failure) => {
      const { db, queries } = scriptedKysely((query) => {
        if (query.sql.includes('from "asset_upload_resource"')) {
          return { rows: failure === 'expired claim' ? [] : [{ id: 'resource' }] };
        }
        if (query.sql.includes('from "physical_file"')) {
          return { rows: failure === 'changed canonical target' ? [] : [{ id: 'physical-id' }] };
        }
        if (query.sql.startsWith('update "asset"')) {
          return { numAffectedRows: 0n };
        }
      });
      await expect(
        new PhysicalFileRepository(db).linkAssetToOriginalPhysicalFile('destination', physical, expected),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(queries.some((query) => query.sql === 'commit')).toBe(false);
      expect(queries.some((query) => query.sql.startsWith('update "asset"'))).toBe(failure === 'removed destination');
    },
  );

  it('commits only one currently owned matching destination after the live claim and target checks', async () => {
    const { db, queries } = scriptedKysely((query) => {
      if (query.sql.includes('from "asset_upload_resource"')) {
        return { rows: [{ id: 'resource' }] };
      }
      if (query.sql.includes('from "physical_file"')) {
        return { rows: [{ id: 'physical-id' }] };
      }
      if (query.sql.startsWith('update "asset"')) {
        return { numAffectedRows: 1n };
      }
    });
    await new PhysicalFileRepository(db).linkAssetToOriginalPhysicalFile('destination', physical, expected);
    expect(queries.find((query) => query.sql.includes('from "asset_upload_resource"'))?.sql).toContain(
      'clock_timestamp()',
    );
    expect(queries.find((query) => query.sql.startsWith('update "asset"'))?.parameters).toContain('owner');
    expect(queries.at(-1)?.sql).toBe('commit');
  });

  it('preserves the legacy two argument path without requiring a native resource', async () => {
    const { db, queries } = scriptedKysely();
    await new PhysicalFileRepository(db).linkAssetToOriginalPhysicalFile('destination', physical);
    expect(queries.some((query) => query.sql.includes('asset_upload_resource'))).toBe(false);
    expect(queries.at(-1)?.sql).toBe('commit');
  });
});
