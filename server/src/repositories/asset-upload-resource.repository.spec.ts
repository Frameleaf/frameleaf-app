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
});
