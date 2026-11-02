import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { LibraryItemSchema, LibraryItemsQueryDto } from 'src/dtos/library-item.dto.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getForAsset } from 'test/mappers.js';

it('requires a complete typed cursor and bounds album item pages', () => {
  expect(LibraryItemsQueryDto.schema.parse({})).toEqual({ limit: 100 });
  expect(LibraryItemsQueryDto.schema.safeParse({ afterKind: 'bookmark' }).success).toBe(false);
  expect(LibraryItemsQueryDto.schema.safeParse({ afterId: '10000000-0000-4000-8000-000000000001' }).success).toBe(
    false,
  );
  expect(LibraryItemsQueryDto.schema.safeParse({ limit: '1000000' }).success).toBe(false);
});

it('represents the existing sanitized media response without claiming owner metadata is present', () => {
  const asset = mapAsset(getForAsset(AssetFactory.create()), { stripMetadata: true });
  expect(asset).not.toHaveProperty('originalPath');
  expect(LibraryItemSchema.safeParse({ kind: 'asset', asset }).success).toBe(true);
});
