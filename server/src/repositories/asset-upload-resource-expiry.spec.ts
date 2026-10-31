import { NotFoundException } from '@nestjs/common';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

afterEach(() => vi.useRealTimers());

describe.each(['resource', 'owner'] as const)('expiry after the %s lock', (phase) => {
  it.each([
    ['receiving', false, false],
    ['receiving', true, false],
    ['published', false, false],
    ['published', true, true],
  ] as const)('state=%s recovery=%s permits callback=%s', async (state, allowExpiredPublished, permitted) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-16T00:00:00Z');
    vi.setSystemTime(start);
    const resource = { id: 'upload', ownerId: 'owner', state, expiresAt: new Date(+start + 1000), metadata: {} };
    const { db } = scriptedKysely((query) => {
      if (query.sql.includes('to_regclass')) return { rows: [{ ready: true }] };
      if (query.sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
      if (query.sql.startsWith('select') && query.sql.includes('from "asset_upload_resource"')) {
        if (phase === 'resource' && query.sql.endsWith('for update')) vi.setSystemTime(+start + 1001);
        return { rows: [resource] };
      }
      if (query.sql.startsWith('select') && query.sql.includes('from "user"')) {
        if (phase === 'owner') vi.setSystemTime(+start + 1001);
        return { rows: [{ id: 'owner' }] };
      }
      return { rows: [] };
    });
    const write = vi.fn().mockResolvedValue('written');
    const operation = new AssetUploadResourceRepository(db).locked('upload', 'owner', write, allowExpiredPublished);
    if (permitted) {
      await expect(operation).resolves.toBe('written');
      expect(write).toHaveBeenCalledOnce();
    } else {
      await expect(operation).rejects.toBeInstanceOf(NotFoundException);
      expect(write).not.toHaveBeenCalled();
    }
    await db.destroy();
  });
});
