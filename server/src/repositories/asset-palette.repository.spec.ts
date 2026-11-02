import { AssetPaletteRepository } from 'src/repositories/asset-palette.repository.js';
import { rgbToOklab } from 'src/utils/asset-palette.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

const ready = {
  version: 1 as const,
  sourceRevision: 'old',
  status: 'ready' as const,
  representative: 'image' as const,
  hasTransparency: false,
  swatches: [{ hex: '#ff0000', weight: 1, oklab: rgbToOklab(1, 0, 0) }],
};

describe('revision-bound palette publication', () => {
  it.each([undefined, { id: 'asset', sourceRevision: 'new' }])(
    'refuses stale or removed sources before any palette mutation',
    async (source) => {
      const { db, queries } = scriptedKysely(({ sql }) =>
        sql.includes('from "asset"') ? { rows: source ? [source] : [] } : { rows: [] },
      );
      try {
        expect(await new AssetPaletteRepository(db).publish('asset', 'old', ready)).toBe(false);
        expect(queries.some(({ sql }) => /^(insert|delete|update)/.test(sql))).toBe(false);
      } finally {
        await db.destroy();
      }
    },
  );
  it('stores result state and searchable coordinates together only for the current revision', async () => {
    const { db, queries } = scriptedKysely(({ sql }) =>
      sql.includes('from "asset"') ? { rows: [{ id: 'asset', sourceRevision: 'old' }] } : { rows: [] },
    );
    try {
      expect(await new AssetPaletteRepository(db).publish('asset', 'old', ready)).toBe(true);
      expect(queries.map(({ sql }) => sql)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('insert into "asset_palette"'),
          expect.stringContaining('delete from "asset_palette_swatch"'),
          expect.stringContaining('insert into "asset_palette_swatch"'),
          'commit',
        ]),
      );
    } finally {
      await db.destroy();
    }
  });
  it('does not expose old swatches while the current source is pending', async () => {
    const { db } = scriptedKysely(({ sql }) =>
      sql.includes('from "asset"')
        ? { rows: [{ id: 'asset', sourceRevision: 'new', type: 'IMAGE', originalFileName: 'logo.png' }] }
        : { rows: [{ assetId: 'asset', ...ready }] },
    );
    try {
      expect(await new AssetPaletteRepository(db).get('asset')).toEqual(
        expect.objectContaining({ status: 'pending', sourceRevision: 'new', swatches: [] }),
      );
    } finally {
      await db.destroy();
    }
  });
  it('does not reveal private current Develop colors to another viewer or a shared link', async () => {
    const { db } = scriptedKysely(({ sql }) =>
      sql.includes('from "asset"')
        ? {
            rows: [
              {
                id: 'asset',
                ownerId: 'owner',
                sourceRevision: 'old',
                type: 'IMAGE',
                originalFileName: 'logo.png',
                develop: { id: 'private-render' },
              },
            ],
          }
        : { rows: [{ assetId: 'asset', ...ready }] },
    );
    try {
      expect(await new AssetPaletteRepository(db).get('asset', 'viewer')).toEqual(
        expect.objectContaining({ status: 'unavailable', sourceRevision: '', swatches: [] }),
      );
      expect(await new AssetPaletteRepository(db).get('asset', null)).toEqual(
        expect.objectContaining({ status: 'unavailable', swatches: [] }),
      );
      expect(await new AssetPaletteRepository(db).get('asset', 'owner')).toEqual(ready);
    } finally {
      await db.destroy();
    }
  });
  it('validates swatch count and finite coordinates before writing', async () => {
    const { db, queries } = scriptedKysely(() => ({ rows: [] }));
    try {
      await expect(
        new AssetPaletteRepository(db).publish('asset', 'old', {
          ...ready,
          swatches: Array.from({ length: 9 }, () => ready.swatches[0]),
        }),
      ).rejects.toThrow();
      for (const swatch of [
        { ...ready.swatches[0], oklab: [NaN, 0, 0] },
        { ...ready.swatches[0], weight: -1 },
        { ...ready.swatches[0], hex: 'red' },
      ]) {
        await expect(
          new AssetPaletteRepository(db).publish('asset', 'old', { ...ready, swatches: [swatch] } as never),
        ).rejects.toThrow();
      }
      expect(queries).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});
