import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('native upload schema and ownership read boundary', () => {
  it('refuses the optional stream when its schema is absent without reading any private resource', async () => {
    const { db, queries } = scriptedKysely(() => ({ rows: [{ ready: false }] }));
    await expect(new AssetUploadResourceRepository(db).get('resource', 'owner')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("to_regclass('public.asset_upload_part')");
  });

  it('uses the same non-disclosing not-found boundary for foreign and expired resources', async () => {
    const { db, queries } = scriptedKysely((query) =>
      query.sql.includes('to_regclass') ? { rows: [{ ready: true }] } : { rows: [] },
    );
    await expect(new AssetUploadResourceRepository(db).get('resource', 'other-owner')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const lookup = queries[1];
    expect(lookup.sql).toContain('"ownerId" =');
    expect(lookup.sql).toContain('"expiresAt" >');
    expect(lookup.parameters).toContain('other-owner');
  });
  it('stores declared pair resources in a receiving state that an older standalone writer cannot complete', async () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const { db, queries } = scriptedKysely((query) => {
      if (query.sql.includes('to_regclass')) {
        return { rows: [{ ready: true }] };
      }
      if (query.sql.includes('count(*)')) {
        return { rows: [{ count: 0 }] };
      }
      return { rows: [{ id: ownerId }] };
    });
    await new AssetUploadResourceRepository(db).create(ownerId, ownerId, {
      checksum: Buffer.alloc(32),
      contentType: 'image/jpeg',
      size: 4,
      maxSize: 10,
      metadata: {
        filename: 'still.jpg',
        fileCreatedAt: new Date(),
        fileModifiedAt: new Date(),
        publication: 'live-photo',
      },
    });
    const insert = queries.find((query) => query.sql.startsWith('insert into "asset_upload_resource"'))!;
    expect(insert.parameters).toContain('pair-receiving');
    expect(insert.parameters.filter((value) => value === 10)).toHaveLength(2);
  });
});
