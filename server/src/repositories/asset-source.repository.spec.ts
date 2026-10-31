import { AssetSourceRepository } from 'src/repositories/asset-source.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

const input = {
  assetId: '10000000-0000-4000-8000-000000000001',
  captureId: '10000000-0000-4000-8000-000000000002',
  pageUrl: 'https://example.org/page',
  mediaUrl: 'https://example.org/a.png',
  title: 'Reference',
  capturedAt: '2026-10-28T10:00:00Z',
};

describe('asset capture provenance', () => {
  it('retries one capture without overwriting the existing source', async () => {
    const existing = { ...input, id: 'source', note: 'Original note' };
    const { db, queries } = scriptedKysely(({ sql }) => ({ rows: sql.startsWith('select') ? [existing] : [] }));
    try {
      const sources = new AssetSourceRepository(db);
      await expect(
        db.transaction().execute((tx) => sources.upsertCapture(tx, { ...input, note: 'Changed retry' })),
      ).resolves.toEqual(existing);
      expect(queries.find(({ sql }) => sql.startsWith('insert'))?.sql).toContain(
        'on conflict ("captureId") do nothing',
      );
      expect(queries.some(({ sql }) => sql.startsWith('update'))).toBe(false);
    } finally {
      await db.destroy();
    }
  });

  it('refuses to reuse a capture ID for another asset', async () => {
    const { db } = scriptedKysely(() => ({ rows: [] }));
    try {
      const sources = new AssetSourceRepository(db);
      await expect(db.transaction().execute((tx) => sources.upsertCapture(tx, input))).rejects.toThrow(
        'Capture ID already used',
      );
    } finally {
      await db.destroy();
    }
  });
});
