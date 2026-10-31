import { DownloadArchiveDto } from 'src/dtos/download.dto.js';

const id = '11111111-1111-4111-8111-111111111111';
it('accepts a bookmark-only portable export and POST-form booleans', () => {
  expect(
    DownloadArchiveDto.schema.parse({
      assetIds: [],
      bookmarkIds: id,
      includeLibraryMetadata: 'true',
      includeSources: 'false',
    }),
  ).toEqual({ assetIds: [], bookmarkIds: [id], includeLibraryMetadata: true, includeSources: false });
});
it('keeps existing original download requests unchanged', () => {
  expect(DownloadArchiveDto.schema.parse({ assetIds: [id] })).toEqual({ assetIds: [id] });
});
it.each([
  { assetIds: [], bookmarkIds: [id] },
  { assetIds: [], includeSources: true },
  { assetIds: [id], includeLibraryMetadata: true, edited: true },
  { assetIds: [id, id], includeLibraryMetadata: true },
])('refuses incomplete or ambiguous portable export options: %j', (input) => {
  expect(DownloadArchiveDto.schema.safeParse(input).success).toBe(false);
});
