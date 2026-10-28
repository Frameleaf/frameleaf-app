import { LibraryItemsQueryDto } from 'src/dtos/library-item.dto.js';

it('requires a complete typed cursor and bounds album item pages', () => {
  expect(LibraryItemsQueryDto.schema.parse({})).toEqual({ limit: 100 });
  expect(LibraryItemsQueryDto.schema.safeParse({ afterKind: 'bookmark' }).success).toBe(false);
  expect(LibraryItemsQueryDto.schema.safeParse({ afterId: '10000000-0000-4000-8000-000000000001' }).success).toBe(
    false,
  );
  expect(LibraryItemsQueryDto.schema.safeParse({ limit: '1000000' }).success).toBe(false);
});
