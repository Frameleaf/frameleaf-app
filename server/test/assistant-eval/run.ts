import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import request from 'supertest';
import { AssistantController } from 'src/controllers/assistant.controller.js';
import { AssistantAskResponseDto } from 'src/dtos/assistant.dto.js';
import { SearchFilter } from 'src/dtos/search.dto.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SpeechRepository } from 'src/repositories/speech.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { AssistantService } from 'src/services/assistant.service.js';
import { SearchService } from 'src/services/search.service.js';
import { SPEECH_INDEX_VERSION, speechQuery, speechWindows } from 'src/utils/speech.js';
import cases from 'test/assistant-eval/cases.json' with { type: 'json' };
import library from 'test/assistant-eval/library.json' with { type: 'json' };
import { preparePlan, requestPlan } from 'test/assistant-eval/planner.js';
import { claimFromAssistantReason } from 'test/assistant-eval/reasons.js';
import replay from 'test/assistant-eval/replay.json' with { type: 'json' };
import {
  EvalAnswer,
  EvalFilters,
  RESULT_LIMIT,
  Reason,
  countFilterErrors,
  readFixtures,
  score,
  scoreByFamily,
} from 'test/assistant-eval/score.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { controllerSetup } from 'test/utils.js';

// This supplies the same CLIP vector for all items and all queries. The baseline measures the
// rule planner and database filters without assigning semantic relevance to a fake embedding.
const neutralEmbedding = `[1,${'0,'.repeat(766)}0]`;
const fingerprint = 'assistant-eval-synthetic';
const typeMap = { IMAGE: AssetType.Image, VIDEO: AssetType.Video };

type Mode =
  { mode: 'replay' | 'baseline' | 'assistant' } | { mode: 'live' | 'candidate' | 'qualification'; endpoint: URL };

/** Run the same fixture library against reference plans, the rule planner, or a candidate worker. */
export async function run(database: Kysely<DB>, options: Mode) {
  const { mode } = options;
  const { questions, assets, plans } = readFixtures(cases, library, replay);
  const { sut, ctx } = newMediumService(SearchService, {
    database,
    real: [
      AssetRepository,
      ConfigRepository,
      DatabaseRepository,
      PersonRepository,
      SearchRepository,
      SystemMetadataRepository,
    ],
    mock: [JobRepository, LoggingRepository, MachineLearningRepository, MlDestinationRepository],
  });
  const ml = ctx.getMock(MachineLearningRepository);
  ml.clipCacheKey.mockResolvedValue(fingerprint);
  ml.encodeText.mockResolvedValue(neutralEmbedding);
  ctx
    .getMock(JobRepository)
    .pinDestination.mockImplementation((_workload, destinationId) => Promise.resolve(destinationId));

  const { user } = await ctx.newUser();
  const { user: stranger } = await ctx.newUser();
  const auth = factory.auth({ user });
  const generation = randomUUID();
  const people = new Map<string, string>();
  const pets = new Map<string, string>();
  const keys = new Map<string, string>();

  for (const name of new Set(assets.flatMap(({ people }) => people ?? []))) {
    const { person } = await ctx.newPerson({ ownerId: user.id, name });
    people.set(name, person.personGroupId);
  }
  for (const name of new Set(assets.flatMap(({ pets }) => pets ?? []))) {
    const { id } = await database
      .insertInto('pet')
      .values({ ownerId: user.id, name, birthDate: null, featuredAssetId: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    pets.set(name, id);
  }
  await database
    .insertInto('speech_settings')
    .values({
      ownerId: user.id,
      enabled: true,
      generation,
      modelFingerprint: fingerprint,
      cursor: null,
      destinationId: null,
    })
    .execute();

  const search = ctx.get(SearchRepository);
  for (const fixture of assets) {
    const ownerId = fixture.otherOwner ? stranger.id : user.id;
    const { asset } = await ctx.newAsset({
      ownerId,
      originalFileName: fixture.filename,
      type: fixture.type ? typeMap[fixture.type] : undefined,
      localDateTime: new Date(fixture.takenAt),
      fileCreatedAt: new Date(fixture.takenAt),
      isFavorite: fixture.favorite ?? false,
      visibility: fixture.locked ? AssetVisibility.Locked : AssetVisibility.Timeline,
    });
    keys.set(asset.id, fixture.key);
    await ctx.newExif({
      assetId: asset.id,
      city: fixture.city,
      latitude: fixture.latitude,
      longitude: fixture.longitude,
      description: fixture.description,
    });
    for (const name of fixture.people ?? []) {
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: people.get(name)! });
    }
    for (const name of fixture.pets ?? []) {
      await database
        .insertInto('pet_observation')
        .values({
          assetId: asset.id,
          petId: pets.get(name)!,
          boundingBoxX1: null,
          boundingBoxY1: null,
          boundingBoxX2: null,
          boundingBoxY2: null,
          imageWidth: null,
          imageHeight: null,
        })
        .execute();
    }
    if (fixture.ocr) {
      await database.insertInto('ocr_search').values({ assetId: asset.id, text: fixture.ocr }).execute();
    }
    if (fixture.spoken) {
      const operationId = randomUUID();
      await database
        .insertInto('speech_transcript')
        .values({
          assetId: asset.id,
          ownerId,
          generation,
          operationId,
          checksum: asset.checksum,
          modelFingerprint: fingerprint,
          indexVersion: SPEECH_INDEX_VERSION,
          model: null,
          language: 'en',
          completedAt: new Date(fixture.takenAt),
        })
        .execute();
      const transcript = fixture.spoken.split(' ').map((text, index) => ({
        text,
        startMs: index * 300,
        endMs: (index + 1) * 300,
      }));
      for (const [sequence, { vector, words, tokens }] of speechWindows(transcript).entries()) {
        await database
          .insertInto('speech_window')
          .values({ assetId: asset.id, operationId, sequence, vector, words, tokens })
          .execute();
      }
    }
    if (mode === 'baseline') {
      await search.upsert(asset.id, neutralEmbedding);
    }
  }

  const personNames = new Map([...people].map(([name, id]) => [id, name]));
  const petNames = new Map([...pets].map(([name, id]) => [id, name]));
  const speech = new SpeechRepository(database);
  const catalog = {
    people: people.keys().toArray(),
    pets: pets.keys().toArray(),
    places: [...new Set(assets.flatMap(({ city }) => city ?? []))],
    albums: [],
    tags: [],
  };
  let validPlans = 0;
  const answers: EvalAnswer[] = [];
  const productionPlanner = mode === 'candidate' || mode === 'qualification';
  if (mode === 'assistant' || productionPlanner) {
    const destination = ctx.getMock(MlDestinationRepository);
    let planner: MachineLearningRepository | undefined;
    if ('endpoint' in options) {
      destination.getById.mockResolvedValue({ ...mlDestinationStub.local, url: options.endpoint.href });
      planner = new MachineLearningRepository(LoggingRepository.create());
      planner.setup((await sut.getConfig({ withCache: false })).machineLearning);
    }
    const assistant = assistantForFixture(sut, speech, people, pets, planner, destination);
    const app = await controllerSetup(AssistantController, [{ provide: AssistantService, useValue: assistant.sut }]);
    const eligible = new Set(assets.filter(({ locked, otherOwner }) => !locked && !otherOwner).map(({ key }) => key));
    const plannerCaseIds = new Set<string>();
    let protectedHits = 0;
    try {
      app.authenticate.mockResolvedValue(auth);
      const http = request(app.getHttpServer());
      for (const { id, question } of questions) {
        assistant.plans.set(question, plans[id]);
        const startedAt = performance.now();
        const result = await http.post('/assistant/ask').send({ query: question, size: RESULT_LIMIT }).expect(200);
        const response: AssistantAskResponseDto = AssistantAskResponseDto.schema.parse(result.body);
        const elapsedMs = performance.now() - startedAt;
        if (response.answeredBy === 'planner') {
          plannerCaseIds.add(id);
        }
        for (const assetId of new Set([
          ...response.results.assets.items.map(({ id }) => id),
          ...response.reasons.map(({ assetId }) => assetId),
        ])) {
          protectedHits += Number(!eligible.has(keys.get(assetId) ?? assetId));
        }
        const hits = response.results.assets.items.map((asset) => ({
          key: keys.get(asset.id) ?? asset.id,
          reasons: assistantClaims(response, asset.id),
        }));
        answers.push({ id, filters: response.plan, hits, elapsedMs });
      }
    } finally {
      await app.close();
    }
    const plannerOnly =
      options.mode === 'candidate'
        ? answers.map((answer) => (plannerCaseIds.has(answer.id) ? answer : { ...answer, filters: null, hits: [] }))
        : undefined;
    return {
      mode,
      cases: questions.length,
      assets: assets.length,
      plannerAnswers: plannerCaseIds.size,
      ...(plannerOnly && {
        plannerOnly: score(questions, assets, plannerOnly),
        byFamily: scoreByFamily(questions, assets, plannerOnly),
        filterErrors: countFilterErrors(questions, plannerOnly),
      }),
      protectedHits,
      ...score(questions, assets, answers),
    };
  }

  for (const { id, question } of questions) {
    const startedAt = performance.now();
    let filters: EvalFilters;
    let ids: string[];
    if (mode === 'baseline') {
      const { plan, results } = await sut.askSearch(auth, { query: question, size: RESULT_LIMIT });
      const raw = plan.filters;
      filters = {
        ...(raw.personIds?.length && { people: raw.personIds.map((id) => personNames.get(id) ?? id) }),
        ...(raw.petIds?.length && { pets: raw.petIds.map((id) => petNames.get(id) ?? id) }),
        ...((raw.type === AssetType.Image || raw.type === AssetType.Video) && { type: raw.type }),
        ...(raw.city && { city: raw.city }),
        ...(raw.takenAfter && { takenAfter: new Date(raw.takenAfter).toISOString() }),
        ...(raw.takenBefore && { takenBefore: new Date(raw.takenBefore).toISOString() }),
        ...(raw.isFavorite !== undefined && { favorite: raw.isFavorite }),
        ...(raw.ocr && { ocr: raw.ocr }),
      };
      ids = results.assets.items.map(({ id }) => id);
    } else {
      const candidate =
        options.mode === 'live' ? await requestPlan(options.endpoint, question, catalog) : preparePlan(plans[id]);
      if (!candidate) {
        answers.push({ id, filters: null, hits: [], elapsedMs: performance.now() - startedAt });
        continue;
      }
      validPlans++;
      filters = candidate.filters;
      const filter: SearchFilter = {
        city: filters.city ? { eq: filters.city } : undefined,
        type: filters.type ? { eq: typeMap[filters.type] } : undefined,
        isFavorite: filters.favorite === undefined ? undefined : { eq: filters.favorite },
        personIds: filters.people ? { all: filters.people.map((name) => people.get(name)!) } : undefined,
        petIds: filters.pets ? { all: filters.pets.map((name) => pets.get(name)!) } : undefined,
        takenAt:
          filters.takenAfter || filters.takenBefore
            ? {
                gte: filters.takenAfter ? new Date(filters.takenAfter) : undefined,
                lte: filters.takenBefore ? new Date(filters.takenBefore) : undefined,
              }
            : undefined,
        ocr: filters.ocr ? { matches: filters.ocr } : undefined,
        description: filters.description ? { like: filters.description } : undefined,
      };
      if (candidate.speech) {
        const { query, clauses } = candidate.speech;
        const { items } = await speech.search(auth, { query, size: RESULT_LIMIT, filter }, clauses);
        ids = items.map(({ asset }) => asset.id);
      } else {
        const { assets } = await sut.searchMetadata(auth, { size: RESULT_LIMIT, filter });
        ids = assets.items.map(({ id }) => id);
      }
    }
    // Replay exercises structured claims from a recorded plan. The existing Ask Search API has
    // only a response-level explanation and provides no per-asset claims to score.
    const reasons = mode === 'baseline' ? [] : filterReasons(filters);
    const hits = ids.map((id) => ({ key: keys.get(id) ?? id, reasons }));
    answers.push({ id, filters, hits, elapsedMs: performance.now() - startedAt });
  }
  return {
    mode,
    cases: questions.length,
    assets: assets.length,
    ...(mode === 'live' && {
      validPlanRate: validPlans / questions.length,
      byFamily: scoreByFamily(questions, assets, answers),
      filterErrors: countFilterErrors(questions, answers),
    }),
    ...score(questions, assets, answers),
  };
}

/**
 * The Library Assistant over the seeded library. Offline mode substitutes a recorded planner call.
 */
function assistantForFixture(
  search: SearchService,
  speech: SpeechRepository,
  people: Map<string, string>,
  pets: Map<string, string>,
  planner: MachineLearningRepository | undefined,
  destination: MlDestinationRepository,
) {
  const plans = new Map<string, EvalFilters>();
  const configured = Object.create(search) as SearchService;
  configured.getConfig = async (options) => {
    const config = await search.getConfig(options);
    return {
      ...config,
      localFeatures: { ...config.localFeatures, assistant: { enabled: true, maxResults: RESULT_LIMIT, planner: true } },
    };
  };
  const named = (items: Map<string, string>) => [...items].map(([name, id]) => ({ id, name }));
  const sut = new AssistantService(
    LoggingRepository.create(),
    configured,
    {
      search: (auth: never, dto: { query: string }) => speech.search(auth, dto as never, speechQuery(dto.query)),
    } as never,
    { getAll: () => Promise.resolve({ people: named(people) }) } as never,
    { getAll: () => Promise.resolve(named(pets)) } as never,
    { getAll: () => Promise.resolve([]) } as never,
    { getAll: () => Promise.resolve([]) } as never,
    planner ?? ({} as MachineLearningRepository),
    destination,
  );
  if (planner) {
    return { sut, plans };
  }
  // the planner call itself (ML admission and HTTP) is replaced; validation and name resolution stay real
  const resolver = sut as unknown as {
    planWithModel: (question: string, language: string, catalog: unknown) => Promise<unknown>;
    resolve: (filters: EvalFilters, catalog: unknown) => unknown;
  };
  resolver.planWithModel = (question, _language, catalog) => {
    const recorded = plans.get(question);
    if (!recorded) {
      return Promise.resolve();
    }
    try {
      // the same check a live candidate's plan gets before it is counted (an unusable transcript query)
      preparePlan(recorded);
    } catch {
      return Promise.resolve();
    }
    return Promise.resolve(resolver.resolve(recorded, catalog));
  };
  return { sut, plans };
}

/** The Assistant's own reasons for one result, as the scorer's claims about fixture fields. */
function assistantClaims(response: AssistantAskResponseDto, assetId: string): Reason[] {
  return response.reasons
    .filter((reason) => reason.assetId === assetId)
    .flatMap(({ items }) => items.map((item) => claimFromAssistantReason(item)));
}

function filterReasons(filters: EvalFilters): Reason[] {
  return (Object.entries(filters) as [keyof EvalFilters, string | boolean | string[]][]).flatMap(([field, value]) =>
    (Array.isArray(value) ? value : [value]).map((value) => ({ field, value })),
  );
}
