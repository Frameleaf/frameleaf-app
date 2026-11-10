import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import {
  AssistantAskDto,
  AssistantAskResponseDto,
  AssistantPlanFilters,
  AssistantPlanFiltersSchema,
  AssistantReasonItem,
  assistantPlanFiltersShape,
} from 'src/dtos/assistant.dto.js';
import { assistantSettings } from 'src/dtos/config.dto.js';
import { SearchFilter, SearchResponseDto, SearchSuggestionType } from 'src/dtos/search.dto.js';
import { AssetType, AssetVisibility, MlWorkload, Permission } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssistantPlanRequest, MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { PersonService } from 'src/services/person.service.js';
import { PetService } from 'src/services/pet.service.js';
import { SearchService } from 'src/services/search.service.js';
import { SpeechService } from 'src/services/speech.service.js';
import { TagService } from 'src/services/tag.service.js';
import { isGranted } from 'src/utils/access.js';
import { isSmartSearchEnabled } from 'src/utils/misc.js';
import { clipTextDestinationId, selectMlDestination } from 'src/utils/ml-destination.js';

/** FL-885: how long a planner may take before the rules answer instead. */
export const ASSISTANT_PLANNER_TIMEOUT_MS = 8000;
/** A planner answer less sure than this is not used; the rules answer instead. */
export const ASSISTANT_PLANNER_CONFIDENCE_FLOOR = 0.5;
/** The most names of each kind sent to a planner. */
const CATALOG_CAP = 200;

/** The JSON schema of the `search_library` arguments, as the planner is told them. */
// Inline only: the planner's validator takes no references, so the media type is restated without its
// registered id (which would turn into `$defs`).
export const ASSISTANT_TOOL_SCHEMA = z.toJSONSchema(
  z.strictObject({
    ...assistantPlanFiltersShape,
    type: z.enum(['IMAGE', 'VIDEO']).optional().describe('Photos or videos only'),
  }),
  { target: 'draft-2020-12' },
);

type NamedId = { id: string; name: string };
type Catalog = { people: NamedId[]; pets: NamedId[]; albums: NamedId[]; tags: NamedId[]; places: string[] };

/** A plan with every name resolved to the ids it searches. */
type ResolvedPlan = {
  filters: AssistantPlanFilters;
  people: NamedId[];
  pets: NamedId[];
  albums: NamedId[];
  tags: NamedId[];
  /** Rule-planner only: a file name the rules search for ("Screenshot") */
  fileName?: string;
};

type SpeechHits = Map<string, string>;

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const fold = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase();

const toIso = (value?: Date | string) => (value === undefined ? undefined : new Date(value).toISOString());

@Injectable()
export class AssistantService {
  constructor(
    private logger: LoggingRepository,
    private search: SearchService,
    private speech: SpeechService,
    private people: PersonService,
    private pets: PetService,
    private albums: AlbumService,
    private tags: TagService,
    private machineLearning: MachineLearningRepository,
    private mlDestinations: MlDestinationRepository,
  ) {
    this.logger.setContext(AssistantService.name);
  }

  async ask(auth: AuthDto, dto: AssistantAskDto): Promise<AssistantAskResponseDto> {
    // A shared link has no library to ask about; its visitors keep the album's own search.
    if (auth.sharedLink) {
      throw new ForbiddenException('The Library Assistant is not available from a shared link');
    }
    const { localFeatures, machineLearning } = await this.search.getConfig({ withCache: false });
    const settings = assistantSettings({ localFeatures });
    if (!settings.enabled) {
      throw new BadRequestException('The Library Assistant is turned off');
    }
    const size = Math.min(dto.size ?? settings.maxResults, settings.maxResults);
    const query = dto.query.trim().replaceAll(/\s+/g, ' ');
    // Question text stays out of every log above debug.
    this.logger.debug(`Library Assistant question (${query.length} characters)`);

    const catalog = await this.loadCatalog(auth);
    const smartSearch = isSmartSearchEnabled(machineLearning);
    const warnings: string[] = [];
    let answeredBy = 'rules';
    let plan: ResolvedPlan | undefined;
    if (settings.planner) {
      const planned = await this.planWithModel(query, dto.language || 'en', catalog);
      if (planned && 'clarify' in planned) {
        warnings.push(planned.clarify);
      } else if (planned && this.isRunnable(planned, smartSearch)) {
        plan = planned;
        answeredBy = 'planner';
      }
    }
    plan ??= await this.planWithRules(auth, query, size, catalog, warnings);

    if (plan.filters.visual && !smartSearch) {
      warnings.push('Visual search is off, so only names, places, dates and text were searched.');
      delete plan.filters.visual;
    }
    if (plan.filters.spoken && plan.filters.visual) {
      // spoken words are searched on their own; a visual reason would claim a search that did not run
      warnings.push('Spoken words are searched on their own, so what the photos look like was not searched.');
      delete plan.filters.visual;
    }
    const { assets, hits } = await this.execute(auth, plan, size, dto.language || undefined);
    const reasons = assets.map((asset, index) => ({
      assetId: asset.id,
      items: this.reasonsFor(asset, plan, hits, index),
    }));
    return {
      query: dto.query,
      summary: this.describe(plan, assets.length),
      answeredBy,
      plan: plan.filters,
      results: {
        albums: { total: 0, count: 0, items: [], facets: [] },
        assets: {
          total: assets.length,
          count: assets.length,
          items: assets,
          facets: [],
          nextPage: null,
          nextCursor: null,
        },
      },
      reasons,
      warnings,
    };
  }

  /**
   * The names the person may see, each list capped. Every list comes from the same service call its own
   * page uses, so suppressed people, pets and tags stay out of a session that is not unlocked, and an API
   * key only reads the kinds it is granted.
   */
  private async loadCatalog(auth: AuthDto): Promise<Catalog> {
    const granted = (permission: Permission) =>
      !auth.apiKey || isGranted({ requested: [permission], current: auth.apiKey.permissions });
    const named = (items: { id: string; name: string }[]) =>
      items.filter(({ name }) => name.trim()).slice(0, CATALOG_CAP);
    const [people, pets, albums, tags, places] = await Promise.all([
      granted(Permission.PersonRead)
        ? this.people.getAll(auth, { withHidden: false, page: 1, size: CATALOG_CAP }).then(({ people }) => people)
        : [],
      granted(Permission.PersonRead) ? this.pets.getAll(auth, { withHidden: false }) : [],
      granted(Permission.AlbumRead)
        ? this.albums
            .getAll(auth, { take: 100 })
            .then((albums) => albums.map(({ id, albumName }) => ({ id, name: albumName })))
        : [],
      granted(Permission.TagRead) ? this.tags.getAll(auth, { take: CATALOG_CAP }) : [],
      this.search.getSearchSuggestions(auth, { type: SearchSuggestionType.CITY }),
    ]);
    return {
      people: named(people),
      pets: named(pets),
      albums: named(albums),
      tags: named(tags),
      places: places.filter((place): place is string => !!place).slice(0, CATALOG_CAP),
    };
  }

  /**
   * Ask the planner model, through the same home-network admission as search text (FL-455). Any failure,
   * timeout, low confidence or a name it made up means no plan, and the rules answer.
   */
  private async planWithModel(
    question: string,
    language: string,
    catalog: Catalog,
  ): Promise<ResolvedPlan | { clarify: string } | undefined> {
    const request: AssistantPlanRequest = {
      question,
      language,
      today: new Date().toISOString().slice(0, 10),
      catalog: {
        people: catalog.people.map(({ name }) => name),
        pets: catalog.pets.map(({ name }) => name),
        albums: catalog.albums.map(({ name }) => name),
        tags: catalog.tags.map(({ name }) => name),
        places: catalog.places,
      },
      toolSchema: ASSISTANT_TOOL_SCHEMA,
    };
    const signal = AbortSignal.timeout(ASSISTANT_PLANNER_TIMEOUT_MS);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ASSISTANT_PLANNER_TIMEOUT_MS);
    });
    const attempt = async () => {
      const destinationId = await clipTextDestinationId(this.mlDestinations);
      const selection = await selectMlDestination(
        { mlDestinationRepository: this.mlDestinations, machineLearningRepository: this.machineLearning },
        { workload: MlWorkload.Clip, destinationId, homeOnly: true, jobName: 'library-assistant-plan' },
      );
      return this.machineLearning.planAssistantSearch(selection, request, signal);
    };
    try {
      const answer = await Promise.race([attempt(), timeout]);
      if (!answer) {
        this.logger.debug('The Library Assistant planner took too long; the rules answered');
        return;
      }
      if ('clarify' in answer) {
        return { clarify: answer.clarify };
      }
      if (answer.confidence < ASSISTANT_PLANNER_CONFIDENCE_FLOOR) {
        return;
      }
      const parsed = AssistantPlanFiltersSchema.safeParse(answer.arguments);
      return parsed.success ? this.resolve(parsed.data, catalog) : undefined;
    } catch (error) {
      this.logger.debug(`The Library Assistant planner did not answer: ${error}`);
      return;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolve the planner's names against the catalogue. A name it does not hold makes the plan unusable. */
  private resolve(filters: AssistantPlanFilters, catalog: Catalog): ResolvedPlan | undefined {
    const lookup = (names: string[] | undefined, items: NamedId[]) => {
      const found = (names ?? []).map((name) => items.find((item) => fold(item.name) === fold(name)));
      return found.every((item) => item !== undefined) ? found : undefined;
    };
    const people = lookup(filters.people, catalog.people);
    const pets = lookup(filters.pets, catalog.pets);
    const albums = lookup(filters.albums, catalog.albums);
    const tags = lookup(filters.tags, catalog.tags);
    if (!people || !pets || !albums || !tags) {
      return;
    }
    const city = filters.city
      ? (catalog.places.find((place) => fold(place) === fold(filters.city!)) ?? filters.city)
      : undefined;
    return {
      filters: {
        ...filters,
        ...(filters.people && { people: people.map(({ name }) => name) }),
        ...(filters.pets && { pets: pets.map(({ name }) => name) }),
        ...(filters.albums && { albums: albums.map(({ name }) => name) }),
        ...(filters.tags && { tags: tags.map(({ name }) => name) }),
        ...(city && { city }),
      },
      people,
      pets,
      albums,
      tags,
    };
  }

  /** Today's Ask Search rules (`buildAskSearchPlan`), in the assistant's plan shape. */
  private async planWithRules(
    auth: AuthDto,
    query: string,
    size: number,
    catalog: Catalog,
    warnings: string[],
  ): Promise<ResolvedPlan> {
    const rules = await this.search.planAskSearch(auth, query, size);
    warnings.push(...rules.warnings);
    const raw = rules.filters;
    const name = (items: NamedId[], id: string) => items.find((item) => item.id === id)?.name;
    const people = (raw.personIds ?? []).map((id) => ({ id, name: name(catalog.people, id) ?? '' }));
    const pets = (raw.petIds ?? []).map((id) => ({ id, name: name(catalog.pets, id) ?? '' }));
    const filters: AssistantPlanFilters = {
      ...(people.length > 0 && { people: people.map(({ name }) => name).filter(Boolean) }),
      ...(pets.length > 0 && { pets: pets.map(({ name }) => name).filter(Boolean) }),
      ...(raw.city && { city: raw.city }),
      ...(raw.takenAfter && { takenAfter: toIso(raw.takenAfter) }),
      ...(raw.takenBefore && { takenBefore: toIso(raw.takenBefore) }),
      ...((raw.type === AssetType.Image || raw.type === AssetType.Video) && { type: raw.type }),
      ...(raw.isFavorite !== undefined && { favorite: raw.isFavorite }),
      ...(raw.ocr && { ocr: raw.ocr }),
      ...(rules.mode === 'smart' && { visual: rules.normalizedQuery.slice(0, 200) }),
    };
    if (filters.people?.length === 0) delete filters.people;
    if (filters.pets?.length === 0) delete filters.pets;
    return { filters, people, pets, albums: [], tags: [], fileName: raw.originalFileName };
  }

  /** The structured filter the plan searches. Locked items never take part, even in an unlocked session. */
  private toFilter(plan: ResolvedPlan): SearchFilter {
    const { filters } = plan;
    return {
      visibility: { ne: AssetVisibility.Locked },
      ...(plan.people.length > 0 && { personIds: { all: plan.people.map(({ id }) => id) } }),
      ...(plan.pets.length > 0 && { petIds: { all: plan.pets.map(({ id }) => id) } }),
      ...(plan.albums.length > 0 && { albumIds: { any: plan.albums.map(({ id }) => id) } }),
      ...(plan.tags.length > 0 && { tagIds: { all: plan.tags.map(({ id }) => id) } }),
      ...(filters.city && { city: { eq: filters.city } }),
      ...((filters.takenAfter || filters.takenBefore) && {
        takenAt: {
          ...(filters.takenAfter && { gte: new Date(filters.takenAfter) }),
          ...(filters.takenBefore && { lte: new Date(filters.takenBefore) }),
        },
      }),
      ...(filters.type && { type: { eq: filters.type === 'VIDEO' ? AssetType.Video : AssetType.Image } }),
      ...(filters.favorite !== undefined && { isFavorite: { eq: filters.favorite } }),
      ...(filters.ocr && { ocr: { matches: filters.ocr } }),
      ...(filters.description && { description: { like: filters.description } }),
      ...(plan.fileName && { originalFileName: { like: plan.fileName } }),
    } as SearchFilter;
  }

  /** A planner plan the search can run: a structured filter, or visual search when it is on. */
  private isRunnable(plan: ResolvedPlan, smartSearch: boolean) {
    return this.hasStructuredFilter(plan) || (!!plan.filters.visual && smartSearch);
  }

  private hasStructuredFilter(plan: ResolvedPlan) {
    const { visual: _visual, ...rest } = plan.filters;
    return Object.keys(rest).length > 0 || !!plan.fileName || plan.people.length > 0 || plan.pets.length > 0;
  }

  /** Run the plan with the same scope as search: the person's own library, never a partner's rows. */
  private async execute(
    auth: AuthDto,
    plan: ResolvedPlan,
    size: number,
    language?: string,
  ): Promise<{ assets: AssetResponseDto[]; hits: SpeechHits }> {
    const filter = this.toFilter(plan);
    const hits: SpeechHits = new Map();
    if (plan.filters.spoken) {
      const { items } = await this.speech.search(auth, {
        query: `"${plan.filters.spoken.replaceAll('"', '')}"`,
        filter,
        size: Math.min(size, 100),
      });
      for (const item of items) {
        if (item.hits[0]) {
          hits.set(item.asset.id, item.hits[0].text);
        }
      }
      return { assets: items.map(({ asset }) => asset).filter(({ id }) => hits.has(id)), hits };
    }
    let response: SearchResponseDto;
    if (plan.filters.visual) {
      response = await this.search.searchSmart(auth, {
        query: plan.filters.visual,
        filter,
        size,
        withExif: true,
        language,
      });
    } else if (this.hasStructuredFilter(plan)) {
      response = await this.search.searchMetadata(auth, { filter, size, withExif: true, withPeople: true });
    } else {
      return { assets: [], hits };
    }
    return { assets: response.assets.items.slice(0, size), hits };
  }

  /**
   * Why one result matched. Each reason is either read from the result's own stored data (people, place,
   * date, favorite, type, description, spoken words) or is a condition the database checked on it (pets,
   * albums, tags, text in the photo). Nothing is claimed that the stored data does not hold.
   */
  private reasonsFor(asset: AssetResponseDto, plan: ResolvedPlan, hits: SpeechHits, index: number) {
    const { filters } = plan;
    const items: AssistantReasonItem[] = [];
    // the people on the result when the search loaded them; otherwise the face match the database ran
    const facesById = asset.people ? new Map(asset.people.map((person) => [person.id, person.name])) : undefined;
    for (const person of plan.people) {
      const name = facesById?.get(person.id) || person.name;
      if (name && (!facesById || facesById.has(person.id))) {
        items.push({ kind: 'person', text: `${name} is in this photo`, value: name });
      }
    }
    for (const pet of plan.pets) {
      if (pet.name) {
        items.push({ kind: 'pet', text: `${pet.name} is in this photo`, value: pet.name });
      }
    }
    const city = asset.exifInfo?.city;
    if (filters.city && city && fold(city) === fold(filters.city)) {
      items.push({ kind: 'place', text: `Taken in ${city}`, value: city });
    }
    if (filters.takenAfter || filters.takenBefore) {
      const taken = Date.parse(asset.fileCreatedAt);
      const after = filters.takenAfter ? Date.parse(filters.takenAfter) : -Infinity;
      const before = filters.takenBefore ? Date.parse(filters.takenBefore) : Infinity;
      if (taken >= after && taken <= before) {
        const local = new Date(asset.localDateTime);
        items.push({
          kind: 'date',
          text: `Taken ${dateFormat.format(local)}`,
          value: asset.localDateTime.slice(0, 10),
        });
      }
    }
    // the search asked for any of the albums, so with several the reason names them all
    if (plan.albums.length === 1) {
      const [album] = plan.albums;
      items.push({ kind: 'album', text: `In the album ${album.name}`, value: album.name });
    } else if (plan.albums.length > 1) {
      const names = plan.albums.map(({ name }) => name).join(', ');
      items.push({ kind: 'album', text: `In one of the albums ${names}` });
    }
    for (const tag of plan.tags) {
      items.push({ kind: 'tag', text: `Tagged ${tag.name}`, value: tag.name });
    }
    if (filters.favorite && asset.isFavorite) {
      items.push({ kind: 'favorite', text: 'In your favorites' });
    }
    if (filters.type && asset.type === (filters.type === 'VIDEO' ? AssetType.Video : AssetType.Image)) {
      items.push({ kind: 'type', text: filters.type === 'VIDEO' ? 'A video' : 'A photo' });
    }
    if (filters.ocr) {
      items.push({ kind: 'text', text: `Text in the photo matches “${filters.ocr}”`, value: filters.ocr });
    }
    const spoken = hits.get(asset.id);
    if (filters.spoken && spoken) {
      items.push({ kind: 'speech', text: `Says “${spoken}”`, value: spoken });
    }
    const description = asset.exifInfo?.description;
    if (filters.description && description && fold(description).includes(fold(filters.description))) {
      items.push({
        kind: 'description',
        text: `Description mentions “${filters.description}”`,
        value: filters.description,
      });
    }
    if (plan.fileName && fold(asset.originalFileName).includes(fold(plan.fileName))) {
      items.push({ kind: 'file', text: `File name contains “${plan.fileName}”`, value: plan.fileName });
    }
    if (filters.visual) {
      items.push({
        kind: 'visual',
        text: `Looks like “${filters.visual}” (closest match ${index + 1})`,
        value: filters.visual,
      });
    }
    return items;
  }

  /** One line describing the search that ran, e.g. "Videos of Mara in Lisbon, from Jun 1, 2024". */
  private describe(plan: ResolvedPlan, count: number): string {
    const { filters } = plan;
    const subject = filters.type === 'VIDEO' ? 'videos' : filters.type === 'IMAGE' ? 'photos' : 'items';
    const parts = [filters.favorite ? `Favorite ${subject}` : subject.charAt(0).toUpperCase() + subject.slice(1)];
    const names = [...(filters.people ?? []), ...(filters.pets ?? [])];
    if (names.length > 0) {
      parts.push(`of ${names.join(' and ')}`);
    }
    if (filters.city) {
      parts.push(`in ${filters.city}`);
    }
    const after = filters.takenAfter ? dateFormat.format(new Date(filters.takenAfter)) : undefined;
    const before = filters.takenBefore ? dateFormat.format(new Date(filters.takenBefore)) : undefined;
    if (after && before) {
      parts.push(`from ${after} to ${before}`);
    } else if (after) {
      parts.push(`since ${after}`);
    } else if (before) {
      parts.push(`before ${before}`);
    }
    if (filters.albums?.length) parts.push(`in the album ${filters.albums.join(' or ')}`);
    if (filters.tags?.length) parts.push(`tagged ${filters.tags.join(' and ')}`);
    if (filters.ocr) parts.push(`with the text “${filters.ocr}”`);
    if (filters.spoken) parts.push(`where someone says “${filters.spoken}”`);
    if (filters.description) parts.push(`described as “${filters.description}”`);
    if (filters.visual) parts.push(`that look like “${filters.visual}”`);
    const found = count === 0 ? 'nothing found' : count === 1 ? '1 found' : `${count} found`;
    return `${parts.join(' ')} · ${found}`;
  }
}
