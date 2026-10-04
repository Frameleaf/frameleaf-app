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
