import {
  getAllAlbums,
  getAllPeople,
  getAllPets,
  getAllTags,
  getSearchSuggestions,
  searchAssetStatistics,
  SearchSuggestionType,
  type PersonResponseDto,
  type PetResponseDto,
} from '@immich/sdk';
import { toSearchDto, type DiscoveryQuery, type DiscoverySearchDto } from '$lib/components/discovery/query';
import { sortPets } from '$lib/frameleaf/pets';

export type FilterPanelOptions = {
  people: PersonResponseDto[];
  pets: PetResponseDto[];
  tags: { value: string; label: string }[];
  albums: { value: string; label: string }[];
  cities: string[];
  states: string[];
  countries: string[];
  makes: string[];
  models: string[];
  lenses: string[];
};

/**
 * Option lists and the live matching count for the Frameleaf filter panel (FL-49).
 *
 * The prototype computes facets locally over its sample assets. Production has no facet
 * endpoint — `SearchFacetResponseDto` is declared but the search service always answers with
 * an empty `facets` array — so the panel offers the vocabularies the server really does
 * publish and shows no fabricated counts:
 *
 * - people from `/people`, pets from `/pets` (FL-58, the account's own), tags from `/tags`,
 *   albums from `/albums`
 * - cities, states, countries, camera makes, models and lenses from `/search/suggestions`,
 *   which returns the distinct values in the signed-in account's own library
 *
 * The count comes from `/search/statistics`, a real access-scoped aggregate. It is a count of
 * the *structured* filter only: `StatisticsSearchDto` carries `filter`, `imageEnrichment`,
 * `ocr` and `description`, but no smart-search text, filename or path term, so the dialog
 * labels it as the filter count rather than implying it includes the typed query.
 */

export const emptyFilterPanelOptions = (): FilterPanelOptions => ({
  people: [],
  pets: [],
  tags: [],
  albums: [],
  cities: [],
  states: [],
  countries: [],
  makes: [],
  models: [],
  lenses: [],
});

/**
 * Every visible person, page by page. `/people` pages rather than returning the whole set, and
 * the panel needs the complete list to resolve an id that arrives in a shared URL. Hidden people
 * are excluded: hiding is the account's own display choice and the filter list honours it.
 */
const loadAllPeople = async (signal?: AbortSignal): Promise<PersonResponseDto[]> => {
  const people: PersonResponseDto[] = [];
  for (let page = 1; ; page++) {
    signal?.throwIfAborted();
    const response = await getAllPeople({ withHidden: false, page }, { signal });
    people.push(...response.people);
    if (!response.hasNextPage) {
      return people;
    }
  }
};

const settle = async <T>(work: Promise<T>, fallback: T, signal?: AbortSignal): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw error;
    }
    // One unavailable vocabulary must not empty the whole panel.
    return fallback;
  }
};

export const loadFilterPanelOptions = async (signal?: AbortSignal): Promise<FilterPanelOptions> => {
  const [people, pets, tags, albums, cities, states, countries, makes, models, lenses] = await Promise.all([
    settle<PersonResponseDto[]>(loadAllPeople(signal), [], signal),
    // Hidden pets are left out for the same reason hidden people are: hiding is a display choice
    settle<PetResponseDto[]>(getAllPets({ withHidden: false }, { signal }), [], signal),
    settle(getAllTags({ signal }), [], signal),
    settle(getAllAlbums({}, { signal }), [], signal),
    settle(getSearchSuggestions({ $type: SearchSuggestionType.City }, { signal }), [], signal),
    settle(getSearchSuggestions({ $type: SearchSuggestionType.State }, { signal }), [], signal),
    settle(getSearchSuggestions({ $type: SearchSuggestionType.Country }, { signal }), [], signal),
    settle(getSearchSuggestions({ $type: SearchSuggestionType.CameraMake }, { signal }), [], signal),
    settle(getSearchSuggestions({ $type: SearchSuggestionType.CameraModel }, { signal }), [], signal),
    settle(getSearchSuggestions({ $type: SearchSuggestionType.CameraLensModel }, { signal }), [], signal),
  ]);

  return {
    people,
    // Favorites first, then by name, as the Pets page lists them
    pets: sortPets(pets),
    tags: tags.map((tag) => ({ value: tag.id, label: tag.value })),
    albums: albums.map((album) => ({ value: album.id, label: album.albumName })),
    cities: cities.filter(Boolean),
    states: states.filter(Boolean),
    countries: countries.filter(Boolean),
    makes: makes.filter(Boolean),
    models: models.filter(Boolean),
    lenses: lenses.filter(Boolean),
  };
};

/** The statistics DTO only ever carries what the endpoint accepts; free text is dropped. */
export const statisticsDtoFor = (query: DiscoveryQuery): DiscoverySearchDto => {
  const dto = toSearchDto(query);
  const { filter, imageEnrichment } = dto;
  return { ...(filter && { filter }), ...(imageEnrichment && { imageEnrichment }) };
};

/**
 * The live "n matching" count. The caller passes a signal from the controller it abandons on
 * the next keystroke, so a superseded request can never overwrite a newer answer.
 */
export const loadMatchingCount = async (query: DiscoveryQuery, signal?: AbortSignal): Promise<number | null> => {
  try {
    const result = await searchAssetStatistics({ statisticsSearchDto: statisticsDtoFor(query) }, { signal });
    return result.total;
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw error;
    }
    return null;
  }
};
