import { MetadataSearchDto, SmartSearchDto, StatisticsSearchDto } from 'src/dtos/search.dto.js';
import { AssetOrder, AssetType, ImageEnrichmentFilter, SearchOrderField } from 'src/enum.js';

describe('search request shapes', () => {
  it('retains structured filters, sort and cursor with fork enrichment options', () => {
    const request = {
      filter: { type: { eq: AssetType.Video } },
      orderBy: { field: SearchOrderField.FileSizeInBytes, direction: AssetOrder.Asc },
      cursor: 'cursor',
      size: 1,
      imageEnrichment: ImageEnrichmentFilter.Nsfw,
      suppressedOnly: true,
    };
    expect(MetadataSearchDto.schema.parse(request)).toEqual(request);
    expect(StatisticsSearchDto.schema.parse({ filter: request.filter })).toEqual({ filter: request.filter });
    expect(SmartSearchDto.schema.parse({ filter: request.filter, query: 'video' })).toEqual({
      filter: request.filter,
      query: 'video',
    });
  });

  it('accepts pet ids as a structured filter condition and as the flat field, like person ids', () => {
    const petId = '00000000-0000-4000-8000-00000000000a';
    const filter = { petIds: { all: [petId] }, or: [{ petIds: { none: [petId] } }] };
    expect(MetadataSearchDto.schema.parse({ filter })).toEqual({ filter });
    expect(StatisticsSearchDto.schema.parse({ filter })).toEqual({ filter });
    expect(MetadataSearchDto.schema.parse({ petIds: [petId] })).toEqual({ petIds: [petId] });
    expect(SmartSearchDto.schema.parse({ petIds: [petId], query: 'dog' })).toEqual({ petIds: [petId], query: 'dog' });
  });

  it('rejects the flat pet ids next to a structured filter, like every other flat field', () => {
    const petId = '00000000-0000-4000-8000-00000000000a';
    const result = MetadataSearchDto.schema.safeParse({ petIds: [petId], filter: { isFavorite: { eq: true } } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['petIds']]);
  });

  it('rejects a pet id that is not a uuid', () => {
    expect(MetadataSearchDto.schema.safeParse({ filter: { petIds: { any: ['biscuit'] } } }).success).toBe(false);
  });
});

describe('shared designer search predicates', () => {
  it('accepts and normalizes color, subtree and transparency in the ordinary structured filter', () => {
    const id = '00000000-0000-4000-8000-00000000000a';
    const result = MetadataSearchDto.schema.parse({
      filter: {
        libraryScope: 'design',
        color: { hex: '#A0B0C0' },
        albumSubtreeIds: { any: [id] },
        hasTransparency: { eq: true },
      },
    });
    expect(result.filter).toEqual({
      libraryScope: 'design',
      color: { hex: '#a0b0c0', tolerance: 'normal', minWeight: 0.05 },
      albumSubtreeIds: { any: [id] },
      hasTransparency: { eq: true },
    });
  });
  it.each([
    { hex: 'red' },
    { hex: '#abcd' },
    { hex: '#000000', tolerance: 'unlimited' },
    { hex: '#000000', minWeight: -0.1 },
    { hex: '#000000', minWeight: Infinity },
  ])('rejects invalid color predicates %j', (color) => {
    expect(MetadataSearchDto.schema.safeParse({ filter: { color } }).success).toBe(false);
  });
});

it('preserves dimension, aspect ratio and millisecond duration predicates in the shared filter', () => {
  const filter = {
    width: { gte: 1920 },
    height: { gte: 1080 },
    aspectRatio: { gte: 1.7, lte: 1.8 },
    durationMs: { lte: 30_000 },
  };
  expect(MetadataSearchDto.schema.parse({ filter }).filter).toEqual(filter);
});

it('accepts a shared mixed-item text predicate without converting bookmark searches into filename searches', () => {
  expect(MetadataSearchDto.schema.parse({ filter: { text: { contains: 'packaging' } } }).filter).toEqual({
    text: { contains: 'packaging' },
  });
});
