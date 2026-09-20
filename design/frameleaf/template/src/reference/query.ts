import type { DiscoveryQuery as ApiDiscoveryQuery, MetadataSearchDto, SearchFilter, SmartSearchDto } from '@immich/sdk';

export type DiscoveryQuery = Required<Omit<ApiDiscoveryQuery, 'spaceId' | 'petIds'>> & Pick<ApiDiscoveryQuery, 'spaceId' | 'petIds'>;

export const emptyDiscoveryQuery = (): DiscoveryQuery => ({
  version: 1,
  text: '',
  mode: 'text' as DiscoveryQuery['mode'],
  filter: {},
  grouping: 'all' as DiscoveryQuery['grouping'],
  view: 'photos' as DiscoveryQuery['view'],
});

export const readDiscoveryQuery = (url: URL): DiscoveryQuery => {
  const raw = url.searchParams.get('dq');
  if (!raw) {
    return emptyDiscoveryQuery();
  }
  try {
    const query = JSON.parse(raw);
    if (query.version !== 1 || typeof query.filter !== 'object' || Array.isArray(query.filter) || !query.filter) {
      return emptyDiscoveryQuery();
    }
    return { ...emptyDiscoveryQuery(), ...query };
  } catch {
    return emptyDiscoveryQuery();
  }
};

export const discoveryUrl = (query: DiscoveryQuery) =>
  `/discover?${new URLSearchParams({ dq: JSON.stringify(query) })}`;

export const contextDiscoveryQuery = (url: URL): DiscoveryQuery => {
  if (url.pathname === '/discover') {
    return readDiscoveryQuery(url);
  }
  const result = emptyDiscoveryQuery();
  const albumId = url.pathname.match(/^\/albums\/([\da-f-]{36})(?:\/|$)/i)?.[1];
  const spaceId = url.pathname.match(/^\/spaces\/([\da-f-]{36})(?:\/|$)/i)?.[1];
  if (albumId) {
    result.filter = { albumIds: { any: [albumId] } };
  }
  if (spaceId) {
    result.spaceId = spaceId;
  }
  if (url.pathname.startsWith('/map')) {
    result.view = 'map' as DiscoveryQuery['view'];
  }
  return result;
};

export const fromLegacySearch = (dto: MetadataSearchDto & Pick<SmartSearchDto, 'query'>): DiscoveryQuery => {
  const result = emptyDiscoveryQuery();
  if (dto.filter) {
    result.filter = structuredClone(dto.filter);
  } else {
    const filter: SearchFilter = {};
    for (const field of [
      'city',
      'country',
      'state',
      'make',
      'model',
      'lensModel',
      'type',
      'visibility',
      'rating',
      'isFavorite',
      'isMotion',
      'isOffline',
      'isEncoded',
    ] as const) {
      if (dto[field] !== undefined) {
        Object.assign(filter, { [field]: { eq: dto[field] } });
      }
    }
    for (const field of ['personIds', 'albumIds', 'tagIds'] as const) {
      if (dto[field]?.length) {
        Object.assign(filter, { [field]: { all: dto[field] } });
      }
    }
    if (dto.tagIds === null) {
      filter.hasTags = { eq: false };
    }
    if (dto.isNotInAlbum) {
      filter.hasAlbums = { eq: false };
    }
    if (dto.takenAfter || dto.takenBefore) {
      filter.takenAt = { gte: dto.takenAfter, lte: dto.takenBefore };
    }
    if (dto.originalFileName) {
      filter.originalFileName = { like: `%${dto.originalFileName}%` };
    }
    if (dto.description) {
      filter.description = { like: `%${dto.description}%` };
    }
    if (dto.originalPath) {
      filter.originalPath = { startsWith: dto.originalPath };
    }
    if (dto.ocr) {
      filter.ocr = { matches: dto.ocr };
    }
    result.filter = filter;
  }
  result.text = dto.query ?? '';
  result.mode = (result.text ? 'smart' : 'text') as DiscoveryQuery['mode'];
  return result;
};

export const withDiscoveryFacet = (query: DiscoveryQuery, field: string, value: string): DiscoveryQuery => {
  const result = structuredClone(query);
  if (['personIds', 'tagIds', 'albumIds'].includes(field)) {
    const key = field as 'personIds' | 'tagIds' | 'albumIds';
    const selected = result.filter[key]?.any ?? [];
    result.filter[key] = { any: [...new Set([...selected, value])] };
  } else {
    Object.assign(result.filter, { [field]: { eq: value } });
  }
  return result;
};

export const withoutDiscoveryFilter = (query: DiscoveryQuery, field: string): DiscoveryQuery => {
  const result = structuredClone(query);
  delete result.filter[field as keyof SearchFilter];
  return result;
};

export const formatMomentTime = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
