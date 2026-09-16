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
});
