import { BadRequestException, Injectable } from '@nestjs/common';
import { LRUMap } from 'mnemonist';
import type { SystemConfig } from 'src/config.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  AssetSearchOptions,
  AssetSearchScope,
  SearchFacetOptions,
  SearchFacetResult,
} from 'src/repositories/search.repository.js';
import { AssetMapOptions, AssetResponseDto, MapAsset, mapAsset } from 'src/dtos/asset-response.dto.js';
import { PersonResponseDto, mapPerson } from 'src/dtos/person.dto.js';
import {
  AskSearchDto,
  AskSearchResponseDto,
  LargeAssetSearchDto,
  MetadataSearchDto,
  PlacesResponseDto,
  RandomSearchDto,
  SEARCH_FACET_DEFAULT_LIMIT,
  SearchCityCountResponseDto,
  SearchFacetField,
  SearchFacetsDto,
  SearchFacetsResponseDto,
  SearchFilter,
  SearchHistogramDto,
  SearchHistogramResponseDto,
  SearchPeopleDto,
  SearchPlacesDto,
  SearchResponseDto,
  SearchStatisticsResponseDto,
  SearchSuggestionRequestDto,
  SearchSuggestionType,
  SmartSearchDto,
  SmartSearchStatisticsResponseDto,
  StatisticsSearchDto,
  isFullyAlbumConfined,
  isNewShapeRequest,
  mapPlaces,
} from 'src/dtos/search.dto.js';
import { AssetOrder, AssetType, AssetVisibility, MlWorkload, Permission } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { isGranted, requireElevatedPermission } from 'src/utils/access.js';
import { getMyPartnerIds } from 'src/utils/asset.util.js';
import { getHiddenContentQueryOptions, getPrivacyQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedOwnerId, getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { isSmartSearchEnabled } from 'src/utils/misc.js';
import {
  applyAlbumLocationPolicy,
  applyPartnerLocationPolicy,
  getLocationHiddenOwnerIdsForView,
} from 'src/utils/partner-location.js';
import { fromChecksum } from 'src/utils/request.js';
import { decodeSearchCursor, encodeSearchCursor } from 'src/utils/search-cursor.js';
import {
  applyLockedVisibilityPolicy,
  collectFilterIds,
  filterUsesLocation,
  requirePetFilterAllowed,
  usesLocationFilter,
} from 'src/utils/search-filter.js';

@Injectable()
export class SearchService extends BaseService {
  private embeddingCache = new LRUMap<string, string>(100);

  async askSearch(auth: AuthDto, dto: AskSearchDto): Promise<AskSearchResponseDto> {
    const { localFeatures } = await this.getConfig({ withCache: false });
    if (!localFeatures.askSearch.enabled) {
      throw new BadRequestException('Ask Search is not enabled');
    }

    const plan = await this.buildAskSearchPlan(auth, dto.query, {
      page: dto.page,
      size: Math.min(dto.size ?? localFeatures.askSearch.maxResults, localFeatures.askSearch.maxResults),
    });
    const results =
      plan.mode === 'smart'
        ? await this.searchSmart(auth, { ...plan.filters, query: plan.normalizedQuery, language: dto.language })
        : await this.searchMetadata(auth, plan.filters);

    // FL-31: "Most answers shown" caps the whole answer, not each page: the page that reaches the
    // limit is trimmed and ends the answer, and nothing past it is ever returned.
    const maxResults = localFeatures.askSearch.maxResults;
    const offset = ((plan.filters.page ?? 1) - 1) * (plan.filters.size ?? maxResults);
    const items = results.assets.items.slice(0, Math.max(0, maxResults - offset));
    const reachedCap = offset + items.length >= maxResults;
    results.assets = {
      ...results.assets,
      items,
      count: items.length,
      total: Math.min(results.assets.total, maxResults),
      nextPage: reachedCap ? null : results.assets.nextPage,
      nextCursor: reachedCap ? null : results.assets.nextCursor,
    };

    return {
      query: dto.query,
      explanation: this.describeAskSearchPlan(plan),
      warnings: plan.warnings,
      plan: {
        mode: plan.mode,
        normalizedQuery: plan.normalizedQuery,
        filters: plan.filters,
      },
      results,
    };
  }

  async searchPerson(auth: AuthDto, dto: SearchPeopleDto): Promise<PersonResponseDto[]> {
    const people = await this.personRepository.getByName(auth.user.id, dto.name, {
      ...getHiddenContentQueryOptions(auth),
      withHidden: dto.withHidden,
    });
    return people.map((person) => mapPerson(person));
  }

  async searchPlaces(dto: SearchPlacesDto): Promise<PlacesResponseDto[]> {
    const places = await this.searchRepository.searchPlaces(dto.name);
    return places.map((place) => mapPlaces(place));
  }

  async getExploreData(auth: AuthDto) {
    const options = { ...getHiddenContentQueryOptions(auth), maxFields: 12, minAssetsPerField: 5 };

    const cities = await this.assetRepository.getAssetIdByCity(auth.user.id, options);
    const cityAssets = await this.assetRepository.getByIdsWithAllRelationsButStacks(
      cities.items.map(({ data }) => data),
      auth.user.id,
    );
    const cityItems = cityAssets.map((asset) => ({ value: asset.exifInfo!.city!, data: mapAsset(asset, { auth }) }));

    const recents = await this.assetRepository.getRecentlyCreatedAssetIds(auth.user.id, options);
    const recentAssets = await this.assetRepository.getByIdsWithAllRelationsButStacks(
      recents.items.map((item) => item.data),
      auth.user.id,
    );
    const recentItems = recentAssets.map((asset) => ({
      value: asset.createdAt.toISOString(),
      data: mapAsset(asset, { auth }),
    }));

    return [
      { fieldName: cities.fieldName, items: cityItems },
      { fieldName: recents.fieldName, items: recentItems },
    ];
  }

  async searchMetadata(auth: AuthDto, dto: MetadataSearchDto): Promise<SearchResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchMetadataV3(auth, dto);
    }

    const { suppressedOnly, ...searchDto } = dto;
    const privacyOptions = getPrivacyQueryOptions(auth, suppressedOnly);

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    requirePetFilterAllowed(auth, dto.petIds);

    let checksum: Buffer | undefined;
    if (dto.checksum) {
      // Supports SHA-1 (legacy) and SHA-256 (current) digests, both hex and base64.
      checksum = fromChecksum(dto.checksum);
    }

    let userIds: string[] | undefined;
    let locationHiddenOwnerIds: string[] | undefined;

    if (dto.albumIds && dto.albumIds.length > 0) {
      await this.requireAccess({ auth, ids: dto.albumIds, permission: Permission.AlbumRead });
      // FL-54: matching album items by place reveals it, so owners who hide their locations from the
      // viewer (for a link, its creator) or from an album's owner never match
      if (usesLocationFilter(dto)) {
        locationHiddenOwnerIds = await this.getAlbumLocationHiddenOwnerIds(auth, dto.albumIds);
      }
    } else if (auth.sharedLink) {
      throw new BadRequestException('Shared link access is only allowed in combination with an albumIds filter');
    } else {
      userIds = await this.getUserIdsToSearch(auth, dto.visibility, usesLocationFilter(dto));
    }

    const page = dto.page ?? 1;
    const size = dto.size || 250;
    const { hasNextPage, items } = await this.searchRepository.searchMetadata(
      { page, size },
      {
        ...searchDto,
        checksum,
        ...privacyOptions,
        visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
        // server derived and set after the request's own fields, so a request can never name another owner
        lockedOwnerId: getLockedOwnerId(auth),
        hideLockedMotion: true,
        userIds,
        locationHiddenOwnerIds,
        viewingUserId: auth.user.id,
        orderDirection: dto.order ?? AssetOrder.Desc,
      },
    );

    return this.mapResponse(items, { auth }, { nextPage: hasNextPage ? (page + 1).toString() : null });
  }

  async searchStatistics(auth: AuthDto, dto: StatisticsSearchDto): Promise<SearchStatisticsResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchStatisticsV3(auth, dto);
    }

    return await this.searchRepository.searchStatistics(await this.getLegacyStatisticsOptions(auth, dto));
  }

  /**
   * FL-49: facet counts for a search body. The body resolves exactly as POST /search/statistics does,
   * so the matched assets (and `total`) are the same; facets then only name the viewer's own people
   * and tags, never a suppressed one while the session is locked, and never a place of an owner who
   * hides their locations from the viewer.
   */
  async searchFacets(auth: AuthDto, dto: SearchFacetsDto): Promise<SearchFacetsResponseDto> {
    const { facets: requested, facetLimit, facetCovers, ...body } = dto;
    // FL-54 owner default: places of items reached through an album never count for owners who hide
    // their locations from that album's owner, just as they never count for owners who hide them from
    // the viewer (for a link, its creator)
    const albumIds = isNewShapeRequest(body)
      ? collectFilterIds(body.filter ?? {}, 'albumIds')
      : ((body as { albumIds?: string[] }).albumIds ?? []);
    const facetOptions: SearchFacetOptions = {
      viewerId: auth.user.id,
      // each facet once, in the order asked
      facets: [...new Set(requested ?? Object.values(SearchFacetField))],
      limit: facetLimit ?? SEARCH_FACET_DEFAULT_LIMIT,
      locationHiddenOwnerIds: [
        ...(await getLocationHiddenOwnerIdsForView({
          viewerId: auth.sharedLink?.userId ?? auth.user.id,
          albumIds,
          repository: this.partnerRepository,
        })),
      ],
      suppressedPersonIds: auth.hiddenContent?.personIds ?? [],
      suppressedTagIds: auth.hiddenContent?.tagIds ?? [],
      covers: facetCovers ?? false,
    };

    // the total comes from the facet statement itself: one scan of the matched assets, not two
    let result: SearchFacetResult;
    if (isNewShapeRequest(body)) {
      const { filter, scope } = await this.resolveSearchScopeV3(auth, body);
      result = await this.searchRepository.searchFacetsV3(
        { filter, ...getPrivacyQueryOptions(auth, body.suppressedOnly), imageEnrichment: body.imageEnrichment },
        scope,
        facetOptions,
      );
    } else {
      result = await this.searchRepository.searchFacets(
        await this.getLegacyStatisticsOptions(auth, body),
        facetOptions,
      );
    }
    const { total, rows } = result;

    return {
      total,
      facets: facetOptions.facets.map((fieldName) => ({
        fieldName,
        counts: rows
          .filter((row) => row.field === fieldName)
          .map(({ value, label, count, coverAssetId }) => ({
            ...(fieldName === SearchFacetField.People || fieldName === SearchFacetField.Tags
              ? { value, label, count }
              : { value, count }),
            // only when asked for (Explore's cards): the newest match, inside the same scope as the count
            ...(facetOptions.covers && { coverAssetId }),
          })),
      })),
    };
  }

  /** FL-49: the search body's matches per local capture day, month or year (the palette's date histogram) */
  async searchHistogram(auth: AuthDto, dto: SearchHistogramDto): Promise<SearchHistogramResponseDto> {
    const { granularity, ...body } = dto;
    let buckets: Array<{ date: string; count: number }>;
    if (isNewShapeRequest(body)) {
      const { filter, scope } = await this.resolveSearchScopeV3(auth, body);
      buckets = await this.searchRepository.searchHistogramV3(
        { filter, ...getPrivacyQueryOptions(auth, body.suppressedOnly), imageEnrichment: body.imageEnrichment },
        scope,
        granularity,
      );
    } else {
      buckets = await this.searchRepository.searchHistogram(
        await this.getLegacyStatisticsOptions(auth, body),
        granularity,
      );
    }

    return { granularity, total: buckets.reduce((sum, { count }) => sum + count, 0), buckets };
  }

  /**
   * FL-49: the palette's scope count for smart search. Smart search ranks every eligible asset that
   * has an embedding, so this counts those, stopping at the cap. Nothing is encoded: no request goes
   * to machine learning for a count.
   */
  async searchSmartStatistics(auth: AuthDto, dto: SmartSearchDto): Promise<SmartSearchStatisticsResponseDto> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }
    if (!dto.query && !dto.queryAssetId) {
      throw new BadRequestException('Either `query` or `queryAssetId` must be set');
    }
    if (dto.queryAssetId) {
      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.queryAssetId] });
    }

    if (isNewShapeRequest(dto)) {
      const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);
      return this.searchRepository.searchSmartCountV3(
        { filter, ...getPrivacyQueryOptions(auth, dto.suppressedOnly), imageEnrichment: dto.imageEnrichment },
        scope,
      );
    }

    const { query: _query, queryAssetId: _queryAssetId, language: _language, page: _page, size: _size, ...rest } = dto;
    return this.searchRepository.searchSmartCount(await this.getLegacyStatisticsOptions(auth, rest));
  }

  /** The options a legacy (flat) statistics body resolves to; shared with facets, histogram and smart counts. */
  private async getLegacyStatisticsOptions(
    auth: AuthDto,
    dto: Omit<StatisticsSearchDto, 'filter'>,
  ): Promise<AssetSearchOptions> {
    const { suppressedOnly, ...searchDto } = dto;
    const userIds = await this.getUserIdsToSearch(auth, dto.visibility, usesLocationFilter(dto));
    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    return {
      ...searchDto,
      ...getPrivacyQueryOptions(auth, suppressedOnly),
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      lockedOwnerId: getLockedOwnerId(auth),
      hideLockedMotion: true,
      userIds,
      viewingUserId: auth.user.id,
    };
  }

  async searchRandom(auth: AuthDto, dto: RandomSearchDto): Promise<AssetResponseDto[]> {
    if (isNewShapeRequest(dto)) {
      return this.searchRandomV3(auth, dto);
    }

    const { suppressedOnly, ...searchDto } = dto;

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const userIds = await this.getUserIdsToSearch(auth, dto.visibility, usesLocationFilter(dto));
    const items = await this.searchRepository.searchRandom(dto.size || 250, {
      ...searchDto,
      ...getPrivacyQueryOptions(auth, suppressedOnly),
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      lockedOwnerId: getLockedOwnerId(auth),
      hideLockedMotion: true,
      userIds,
      viewingUserId: auth.user.id,
    });
    return this.withLocationPolicy(
      auth,
      items.map((item) => mapAsset(item, { auth })),
    );
  }

  async searchLargeAssets(auth: AuthDto, dto: LargeAssetSearchDto): Promise<AssetResponseDto[]> {
    const { suppressedOnly, ...searchDto } = dto;

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const userIds = await this.getUserIdsToSearch(auth, dto.visibility);
    const items = await this.searchRepository.searchLargeAssets(dto.size || 250, {
      ...searchDto,
      ...getPrivacyQueryOptions(auth, suppressedOnly),
      visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
      lockedOwnerId: getLockedOwnerId(auth),
      hideLockedMotion: true,
      userIds,
      viewingUserId: auth.user.id,
    });
    return this.withLocationPolicy(
      auth,
      items.map((item) => mapAsset(item, { auth })),
    );
  }

  async searchSmart(auth: AuthDto, dto: SmartSearchDto): Promise<SearchResponseDto> {
    if (isNewShapeRequest(dto)) {
      return this.searchSmartV3(auth, dto);
    }

    const { suppressedOnly, ...searchDto } = dto;

    if (dto.visibility === AssetVisibility.Locked) {
      requireElevatedPermission(auth);
    }

    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }

    const userIds = this.getUserIdsToSearch(auth, dto.visibility, usesLocationFilter(dto));
    const embedding = await this.resolveEmbedding(auth, dto, machineLearning);
    const page = dto.page ?? 1;
    const size = dto.size || 100;
    const { hasNextPage, items } = await this.searchRepository.searchSmart(
      { page, size },
      {
        ...searchDto,
        ...getPrivacyQueryOptions(auth, suppressedOnly),
        userIds: await userIds,
        viewingUserId: auth.user.id,
        embedding,
        query: dto.query,
        visibility: dto.visibility ?? (auth.session?.hasElevatedPermission ? undefined : 'not-locked'),
        lockedOwnerId: getLockedOwnerId(auth),
        hideLockedMotion: true,
      },
    );

    return this.mapResponse(items, { auth }, { nextPage: hasNextPage ? (page + 1).toString() : null });
  }

  async getAssetsByCity(auth: AuthDto): Promise<AssetResponseDto[]> {
    // grouped by place, so partners who hide their locations contribute nothing here
    const userIds = await this.getUserIdsToSearch(auth, undefined, true);
    const assets = await this.searchRepository.getAssetsByCity(userIds, getHiddenContentQueryOptions(auth));
    return assets.map((asset) => mapAsset(asset));
  }

  async getCityAssetCounts(auth: AuthDto): Promise<SearchCityCountResponseDto[]> {
    // same owners as getAssetsByCity: partners who hide their locations contribute nothing
    const userIds = await this.getUserIdsToSearch(auth, undefined, true);
    const rows = await this.searchRepository.getCityAssetCounts(userIds, getHiddenContentQueryOptions(auth));
    return rows.map(({ city, count }) => ({ city, count: Number(count) }));
  }

  async getSearchSuggestions(auth: AuthDto, dto: SearchSuggestionRequestDto) {
    const isLocationSuggestion = [
      SearchSuggestionType.COUNTRY,
      SearchSuggestionType.STATE,
      SearchSuggestionType.CITY,
    ].includes(dto.type);
    const userIds = await this.getUserIdsToSearch(auth, undefined, isLocationSuggestion);
    const suggestions = await this.getSuggestions(userIds, dto, auth);
    if (dto.includeNull) {
      suggestions.push(null);
    }
    return suggestions;
  }

  private getSuggestions(
    userIds: string[],
    dto: SearchSuggestionRequestDto,
    auth: AuthDto,
  ): Promise<Array<string | null>> {
    const nsfwOptions = getHiddenContentQueryOptions(auth);

    switch (dto.type) {
      case SearchSuggestionType.COUNTRY: {
        return this.searchRepository.getCountries(userIds, nsfwOptions);
      }
      case SearchSuggestionType.STATE: {
        return this.searchRepository.getStates(userIds, { country: dto.country, ...nsfwOptions });
      }
      case SearchSuggestionType.CITY: {
        return this.searchRepository.getCities(userIds, { country: dto.country, state: dto.state, ...nsfwOptions });
      }
      case SearchSuggestionType.CAMERA_MAKE: {
        return this.searchRepository.getCameraMakes(userIds, {
          model: dto.model,
          lensModel: dto.lensModel,
          ...nsfwOptions,
        });
      }
      case SearchSuggestionType.CAMERA_MODEL: {
        return this.searchRepository.getCameraModels(userIds, {
          make: dto.make,
          lensModel: dto.lensModel,
          ...nsfwOptions,
        });
      }
      case SearchSuggestionType.CAMERA_LENS_MODEL: {
        return this.searchRepository.getCameraLensModels(userIds, { make: dto.make, model: dto.model, ...nsfwOptions });
      }
      default: {
        return Promise.resolve([]);
      }
    }
  }

  private async searchMetadataV3(auth: AuthDto, dto: MetadataSearchDto): Promise<SearchResponseDto> {
    const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);

    const { offset } = decodeSearchCursor(dto.cursor);
    const size = dto.size ?? 250;
    const { hasNextPage, items } = await this.searchRepository.searchMetadataV3(
      { take: size, skip: offset },
      {
        filter,
        ...getPrivacyQueryOptions(auth, dto.suppressedOnly),
        imageEnrichment: dto.imageEnrichment,
        withExif: dto.withExif,
        withPeople: dto.withPeople,
        withStacked: dto.withStacked,
        order: dto.orderBy,
      },
      scope,
    );

    return this.mapResponse(items, { auth }, { nextCursor: hasNextPage ? encodeSearchCursor(offset + size) : null });
  }

  private async searchStatisticsV3(auth: AuthDto, dto: StatisticsSearchDto): Promise<SearchStatisticsResponseDto> {
    const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);
    return this.searchRepository.searchStatisticsV3(
      { filter, ...getPrivacyQueryOptions(auth, dto.suppressedOnly), imageEnrichment: dto.imageEnrichment },
      scope,
    );
  }

  private async searchRandomV3(auth: AuthDto, dto: RandomSearchDto): Promise<AssetResponseDto[]> {
    const { filter, scope } = await this.resolveSearchScopeV3(auth, dto);
    const items = await this.searchRepository.searchRandomV3(
      dto.size ?? 250,
      {
        filter,
        ...getPrivacyQueryOptions(auth, dto.suppressedOnly),
        imageEnrichment: dto.imageEnrichment,
        withExif: dto.withExif,
        withPeople: dto.withPeople,
        withStacked: dto.withStacked,
      },
      scope,
    );
    return this.withLocationPolicy(
      auth,
      items.map((item) => mapAsset(item, { auth })),
    );
  }

  private async searchSmartV3(auth: AuthDto, dto: SmartSearchDto): Promise<SearchResponseDto> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }

    const [{ filter, scope }, embedding] = await Promise.all([
      this.resolveSearchScopeV3(auth, dto),
      this.resolveEmbedding(auth, dto, machineLearning),
    ]);

    // no cursor until a rank-aware pagination strategy for smart search is decided
    const { items } = await this.searchRepository.searchSmartV3(
      { take: dto.size ?? 100 },
      {
        filter,
        withExif: dto.withExif,
        embedding,
        query: dto.query,
        ...getPrivacyQueryOptions(auth, dto.suppressedOnly),
        imageEnrichment: dto.imageEnrichment,
      },
      scope,
    );

    return this.mapResponse(items, { auth });
  }

  private async resolveSearchScopeV3(
    auth: AuthDto,
    dto: { filter?: SearchFilter },
  ): Promise<{ filter: SearchFilter; scope: AssetSearchScope }> {
    const filter = dto.filter ?? {};
    const effectiveFilter = applyLockedVisibilityPolicy(auth, filter);

    const fullyConfined = isFullyAlbumConfined(filter);
    // a shared link visitor does not have a universe, so there every branch must be confined
    if (auth.sharedLink && !fullyConfined) {
      throw new BadRequestException('Shared link access is only allowed in combination with an albumIds filter');
    }

    requirePetFilterAllowed(auth, collectFilterIds(filter, 'petIds'));

    const albumIds = collectFilterIds(filter, 'albumIds');
    const usesLocation = filterUsesLocation(filter);
    const [userIds] = await Promise.all([
      // a fully confined filter searches albums only, so the unused universe can skip the partner lookup
      fullyConfined ? [auth.user.id] : this.getUserIdsToSearch(auth, undefined, usesLocation),
      albumIds.length > 0 ? this.requireAccess({ auth, ids: albumIds, permission: Permission.AlbumRead }) : undefined,
    ]);

    return {
      filter: effectiveFilter,
      scope: {
        userIds,
        lockedOwnerId: auth.user.id,
        viewingUserId: auth.user.id,
        // live-photo motion parts of Locked stills: only the still's owner, when elevated (FL-34)
        lockedMotion: getLockedVisibilityOptions(auth),
        // FL-54: album branches search other people's items; a place filter must not match owners who
        // hide their locations from the viewer (for a link, its creator) or from an album's owner
        ...(usesLocation &&
          albumIds.length > 0 && {
            locationHiddenOwnerIds: await this.getAlbumLocationHiddenOwnerIds(auth, albumIds),
          }),
      },
    };
  }

  private async getAlbumLocationHiddenOwnerIds(auth: AuthDto, albumIds: string[]): Promise<string[]> {
    return [
      ...(await getLocationHiddenOwnerIdsForView({
        viewerId: auth.sharedLink?.userId ?? auth.user.id,
        albumIds,
        repository: this.partnerRepository,
      })),
    ];
  }

  private async resolveEmbedding(
    auth: AuthDto,
    dto: SmartSearchDto,
    machineLearning: SystemConfig['machineLearning'],
  ): Promise<string> {
    if (dto.query) {
      const key = machineLearning.clip.modelName + dto.query + dto.language;
      let embedding = this.embeddingCache.get(key);
      if (!embedding) {
        const selection = await this.selectRoutedMlDestination({ workload: MlWorkload.Clip });
        embedding = await this.machineLearningRepository.encodeText(selection, dto.query, {
          modelName: machineLearning.clip.modelName,
          language: dto.language,
        });
        this.embeddingCache.set(key, embedding);
      }
      return embedding;
    }

    if (dto.queryAssetId) {
      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.queryAssetId] });
      const getEmbeddingResponse = await this.searchRepository.getEmbedding(dto.queryAssetId);
      const assetEmbedding = getEmbeddingResponse?.embedding;
      if (!assetEmbedding) {
        throw new BadRequestException(`Asset ${dto.queryAssetId} has no embedding`);
      }
      return assetEmbedding;
    }

    throw new BadRequestException('Either `query` or `queryAssetId` must be set');
  }

  /**
   * The owners whose assets a search may return. `locationSharedOnly` leaves out partners who hide their
   * locations from this user whenever the request itself is about places (FL-54): matching, counting or
   * suggesting by place would reveal what the sharer chose to hide.
   */
  private async getUserIdsToSearch(
    auth: AuthDto,
    visibility?: AssetVisibility,
    locationSharedOnly = false,
  ): Promise<string[]> {
    // Locked assets are personal. Never include partner IDs, regardless of A's elevated session.
    if (visibility === AssetVisibility.Locked) {
      return [auth.user.id];
    }
    const partnerIds = await getMyPartnerIds({
      userId: auth.user.id,
      repository: this.partnerRepository,
      timelineEnabled: true,
      locationSharedOnly,
    });
    return [auth.user.id, ...partnerIds];
  }

  /**
   * Strips location EXIF from assets whose owner hides it from the viewer (FL-54), directly or from the
   * owner of an album the viewer reaches the asset through (owner default, privacy first).
   */
  private async withLocationPolicy(auth: AuthDto | undefined, assets: AssetResponseDto[]): Promise<AssetResponseDto[]> {
    if (!auth) {
      return assets;
    }

    const options = { userId: auth.user.id, repository: this.partnerRepository };
    return applyAlbumLocationPolicy(await applyPartnerLocationPolicy(assets, options), options);
  }

  private async mapResponse(
    assets: MapAsset[],
    options: AssetMapOptions,
    page: { nextPage?: string | null; nextCursor?: string | null } = {},
  ): Promise<SearchResponseDto> {
    const items = await this.withLocationPolicy(
      options.auth,
      assets.map((asset) => mapAsset(asset, options)),
    );
    return {
      albums: { total: 0, count: 0, items: [], facets: [] },
      assets: {
        total: assets.length,
        count: assets.length,
        items,
        facets: [],
        nextPage: page.nextPage ?? null,
        nextCursor: page.nextCursor ?? null,
      },
    };
  }

  private async buildAskSearchPlan(auth: AuthDto, query: string, pagination: { page?: number; size: number }) {
    const normalizedQuery = query.trim().replaceAll(/\s+/g, ' ');
    const lower = normalizedQuery.toLowerCase();
    const filters: MetadataSearchDto = { page: pagination.page ?? 1, size: pagination.size, withExif: true };
    const warnings: string[] = [];
    let mode: 'smart' | 'metadata' = 'smart';

    const relativeDateRange = this.getAskSearchRelativeDateRange(lower);
    if (relativeDateRange) {
      filters.takenAfter = relativeDateRange.after;
      filters.takenBefore = relativeDateRange.before;
    }

    const year = lower.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
    if (year && !relativeDateRange) {
      filters.takenAfter = new Date(`${year}-01-01T00:00:00.000Z`);
      filters.takenBefore = new Date(`${year}-12-31T23:59:59.999Z`);
    }

    if (/\blast summer\b/.test(lower) && !relativeDateRange) {
      const lastYear = new Date().getUTCFullYear() - 1;
      filters.takenAfter = new Date(`${lastYear}-06-01T00:00:00.000Z`);
      filters.takenBefore = new Date(`${lastYear}-08-31T23:59:59.999Z`);
    }

    const monthRange = this.getAskSearchMonthRange(lower);
    const openEndedMonthRange = this.getAskSearchOpenEndedMonthRange(lower);
    if (openEndedMonthRange && !relativeDateRange) {
      filters.takenAfter = openEndedMonthRange.after;
      filters.takenBefore = openEndedMonthRange.before;
    } else if (monthRange && !relativeDateRange) {
      filters.takenAfter = monthRange.after;
      filters.takenBefore = monthRange.before;
    }

    const afterYear = lower.match(/\b(?:after|since)\s+(19\d{2}|20\d{2})\b/)?.[1];
    if (afterYear) {
      filters.takenAfter = new Date(`${afterYear}-01-01T00:00:00.000Z`);
      filters.takenBefore = undefined;
    }

    const beforeYear = lower.match(/\bbefore\s+(19\d{2}|20\d{2})\b/)?.[1];
    if (beforeYear) {
      filters.takenAfter = undefined;
      filters.takenBefore = new Date(`${beforeYear}-01-01T00:00:00.000Z`);
    }

    if (/\b(favorites?|starred)\b/.test(lower)) {
      filters.isFavorite = true;
    }

    if (/\b(videos?|movies?)\b/.test(lower)) {
      filters.type = AssetType.Video;
    } else if (/\b(photos?|pictures?|images?)\b/.test(lower)) {
      filters.type = AssetType.Image;
    }

    const locationMatch = lower.match(
      /\b(?:in|near|around|at)\s+([a-z][a-z\s.'-]{2,}?)(?=\s+(?:last|this|from|during|with|of|in)\b|$)/,
    );
    if (locationMatch?.[1]) {
      const phrase = locationMatch[1].trim();
      // Possessive / generic referents ("my hometown", "the beach", "our place")
      // are not real city names. Forcing them through a strict city filter just
      // returns zero results with no signal to the user. Skip and warn instead.
      const firstWord = phrase.split(/\s+/, 1)[0];
      const LOCATION_STOP_WORDS = new Set(['my', 'the', 'our', 'a', 'an', 'this', 'that', 'some', 'any']);
      if (LOCATION_STOP_WORDS.has(firstWord)) {
        warnings.push(`Couldn't resolve "${phrase}" to a known location — showing results without a location filter.`);
      } else {
        filters.city = this.toTitleCase(phrase);
      }
    }

    if (/\b(receipts?|invoices?)\b/.test(lower)) {
      mode = 'metadata';
      filters.ocr = 'receipt invoice total tax';
    } else if (/\bscreenshots?\b/.test(lower)) {
      mode = 'metadata';
      filters.originalFileName = 'Screenshot';
    } else if (/\b(documents?|paperwork|forms?)\b/.test(lower)) {
      mode = 'metadata';
      filters.ocr = 'document form';
    } else if (/\b(ids?|passports?|license|medical|legal)\b/.test(lower)) {
      mode = 'metadata';
      filters.ocr = lower;
      warnings.push('Document categories are approximated with OCR until Document Intelligence is enabled.');
    }

    const { personIds, petIds } = await this.resolveAskSearchNames(auth, normalizedQuery);
    if (personIds.length > 0) {
      filters.personIds = personIds;
    }
    if (petIds.length > 0) {
      filters.petIds = petIds;
    }
    if (personIds.length === 0 && petIds.length === 0 && this.hasAskSearchPeoplePhrase(normalizedQuery)) {
      warnings.push('People names are searched semantically until Ask Search can resolve names to person IDs.');
    }

    return { mode, normalizedQuery, filters, warnings };
  }

  private describeAskSearchPlan(plan: Awaited<ReturnType<SearchService['buildAskSearchPlan']>>): string {
    const filters = Object.keys(plan.filters).filter((key) => !['page', 'size', 'withExif'].includes(key));
    const filterText = filters.length > 0 ? ` with ${filters.join(', ')} filters` : '';
    return plan.mode === 'smart'
      ? `Used local smart search${filterText}.`
      : `Used metadata and OCR search${filterText}.`;
  }

  private toTitleCase(value: string): string {
    return value
      .split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private getAskSearchRelativeDateRange(query: string): { after: Date; before: Date } | null {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const endOfDay = (date: Date) =>
      new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));

    if (/\btoday\b/.test(query)) {
      return { after: today, before: endOfDay(today) };
    }

    if (/\byesterday\b/.test(query)) {
      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      return { after: yesterday, before: endOfDay(yesterday) };
    }

    if (/\bthis week\b/.test(query)) {
      const start = new Date(today);
      start.setUTCDate(start.getUTCDate() - start.getUTCDay());
      return { after: start, before: endOfDay(today) };
    }

    if (/\blast week\b/.test(query)) {
      const start = new Date(today);
      start.setUTCDate(start.getUTCDate() - start.getUTCDay() - 7);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 6);
      return { after: start, before: endOfDay(end) };
    }

    if (/\bthis month\b/.test(query)) {
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      return { after: start, before: endOfDay(today) };
    }

    if (/\blast month\b/.test(query)) {
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
      const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
      return { after: start, before: endOfDay(end) };
    }

    if (/\bthis year\b/.test(query)) {
      const start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
      return { after: start, before: endOfDay(today) };
    }

    if (/\blast year\b/.test(query)) {
      const year = today.getUTCFullYear() - 1;
      return {
        after: new Date(`${year}-01-01T00:00:00.000Z`),
        before: new Date(`${year}-12-31T23:59:59.999Z`),
      };
    }

    return null;
  }

  private getAskSearchMonthRange(query: string): { after: Date; before: Date } | null {
    const monthNames = [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
    ];
    const monthPattern = monthNames.join('|');
    const match = query.match(new RegExp(String.raw`\b(${monthPattern})\b(?:\s+(19\d{2}|20\d{2}))?`));
    if (!match) {
      return null;
    }

    const now = new Date();
    const month = monthNames.indexOf(match[1]);
    const year = match[2] ? Number(match[2]) : now.getUTCFullYear();
    const after = new Date(Date.UTC(year, month, 1));
    const before = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));

    return { after, before };
  }

  private getAskSearchOpenEndedMonthRange(query: string): { after?: Date; before?: Date } | null {
    const monthNames = [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
    ];
    const monthPattern = monthNames.join('|');
    const match = query.match(new RegExp(String.raw`\b(before|after|since)\s+(${monthPattern})\s+(19\d{2}|20\d{2})\b`));
    if (!match) {
      return null;
    }

    const month = monthNames.indexOf(match[2]);
    const year = Number(match[3]);
    const startOfMonth = new Date(Date.UTC(year, month, 1));

    return match[1] === 'before' ? { before: startOfMonth } : { after: startOfMonth };
  }

  private hasAskSearchPeoplePhrase(query: string) {
    return /\b(?:with|of)\s+[A-Za-z][\w'-]*/.test(query);
  }

  private canResolveAskSearchPeople(auth: AuthDto) {
    return !auth.apiKey || isGranted({ requested: [Permission.PersonRead], current: auth.apiKey.permissions });
  }

  /**
   * FL-58 pets: pets are the caller's own, so no API-key person permission is involved, but a shared
   * link may never filter by the owner's pet (see `requirePetFilterAllowed`).
   */
  private canResolveAskSearchPets(auth: AuthDto) {
    return !auth.sharedLink;
  }

  /**
   * Resolve the names after "with" / "of" to people and, since FL-49 follows FL-58, to the caller's
   * own pets. Both lookups use the same fuzzy rule and the same session privacy (hidden people and
   * pets never match, and in a session that is not unlocked neither do suppressed ones). For each
   * name an exact, case-insensitive name wins, a person before a pet; otherwise the closest person,
   * then the closest pet.
   */
  private async resolveAskSearchNames(
    auth: AuthDto,
    query: string,
  ): Promise<{ personIds: string[]; petIds: string[] }> {
    const canResolvePeople = this.canResolveAskSearchPeople(auth);
    const canResolvePets = this.canResolveAskSearchPets(auth);
    if (!canResolvePeople && !canResolvePets) {
      return { personIds: [], petIds: [] };
    }

    const match = query.match(
      /\b(?:with|of)\s+([A-Za-z][\w'-]*(?:\s+(?:and\s+)?[A-Za-z][\w'-]*)*?)(?=\s+(?:in|near|around|at|last|this|from|during|before|after|since)\b|$)/,
    );
    if (!match?.[1]) {
      return { personIds: [], petIds: [] };
    }

    const names = match[1]
      .split(/\s+(?:and|&)\s+|,\s*/)
      .map((name) => name.trim())
      .filter(Boolean);
    const privacy = getHiddenContentQueryOptions(auth);
    const resolved = await Promise.all(
      names.map(async (name): Promise<{ personId?: string; petId?: string }> => {
        const [people, pets] = await Promise.all([
          canResolvePeople
            ? this.personRepository.getByName(auth.user.id, name, { ...privacy, withHidden: false })
            : Promise.resolve([]),
          canResolvePets ? this.searchRepository.searchPetsByName(auth.user.id, name, privacy) : Promise.resolve([]),
        ]);
        const isExact = (candidate: { name: string }) => candidate.name.toLowerCase() === name.toLowerCase();
        const exactPerson = people.find((person) => isExact(person));
        const exactPet = pets.find((pet) => isExact(pet));
        if (exactPerson) {
          return { personId: exactPerson.personGroupId };
        }
        if (exactPet) {
          return { petId: exactPet.id };
        }
        if (people[0]) {
          return { personId: people[0].personGroupId };
        }
        return pets[0] ? { petId: pets[0].id } : {};
      }),
    );

    return {
      personIds: resolved.flatMap(({ personId }) => (personId ? [personId] : [])),
      petIds: [...new Set(resolved.flatMap(({ petId }) => (petId ? [petId] : [])))],
    };
  }
}
