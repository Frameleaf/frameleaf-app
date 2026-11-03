import { LibraryItemSearchDto } from 'src/dtos/library-search.dto.js';

it('bounds a shared mixed-item query and preserves the ordinary structured filter', () => {
  expect(LibraryItemSearchDto.schema.parse({ filter: { libraryScope: 'design', color: { hex: '#609060' } } })).toEqual({
    filter: { libraryScope: 'design', color: { hex: '#609060', tolerance: 'normal', minWeight: 0.05 } },
    query: '',
    mode: 'text',
    limit: 100,
  });
  expect(
    LibraryItemSearchDto.schema.safeParse({
      mode: 'smart',
      query: 'green',
      queryAssetId: '955d572e-4fc7-4e66-9684-386c8b335c46',
    }).success,
  ).toBe(false);
  expect(LibraryItemSearchDto.schema.safeParse({ limit: 201 }).success).toBe(false);
  expect(LibraryItemSearchDto.schema.safeParse({ mode: 'smart' }).success).toBe(false);
  expect(LibraryItemSearchDto.schema.safeParse({ sort: 'color' }).success).toBe(false);
  expect(
    LibraryItemSearchDto.schema.safeParse({ mode: 'smart', query: 'green packaging', sort: 'added' }).success,
  ).toBe(false);
});
