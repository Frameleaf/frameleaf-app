import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import { defaults } from 'src/dtos/config.dto.js';
import { AssetType, AssetVisibility, Permission } from 'src/enum.js';
import { AssistantPlannerUnavailableError } from 'src/repositories/machine-learning.repository.js';
import {
  ASSISTANT_PLANNER_TIMEOUT_MS,
  ASSISTANT_TOOL_SCHEMA,
  AssistantService,
} from 'src/services/assistant.service.js';
import { selectMlDestination } from 'src/utils/ml-destination.js';
import { factory } from 'test/small.factory.js';

vi.mock('src/utils/ml-destination.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/ml-destination.js')>()),
  selectMlDestination: vi.fn(),
  clipTextDestinationId: vi.fn().mockResolvedValue('local'),
}));

const mara = { id: '0195e2a0-0000-4000-8000-000000000001', name: 'Mara Quill' };
const biscuit = { id: '0195e2a0-0000-4000-8000-000000000002', name: 'Biscuit' };
const trip = { id: '0195e2a0-0000-4000-8000-000000000003', albumName: 'Lisbon trip' };

const asset = (overrides: Partial<AssetResponseDto> = {}) =>
  ({
    id: factory.uuid(),
    type: AssetType.Image,
    isFavorite: false,
    originalFileName: 'IMG_0001.jpg',
    fileCreatedAt: '2024-07-02T10:00:00.000Z',
    localDateTime: '2024-07-02T12:00:00.000Z',
    exifInfo: { city: 'Lisbon', description: 'Sunset at the old harbour' },
    people: [{ id: mara.id, name: mara.name }],
    ...overrides,
  }) as AssetResponseDto;

const page = (items: AssetResponseDto[]) => ({
  albums: { total: 0, count: 0, items: [], facets: [] },
  assets: { total: items.length, count: items.length, items, facets: [], nextPage: null, nextCursor: null },
});

const rulesPlan = (filters: Record<string, unknown> = {}, mode: 'smart' | 'metadata' = 'smart') => ({
  mode,
  normalizedQuery: 'beach photos of Mara Quill',
  filters: { page: 1, size: 100, withExif: true, ...filters },
  warnings: [],
});

const setup = (assistant: Partial<typeof defaults.localFeatures.assistant> = {}) => {
  const config = {
    ...defaults,
    localFeatures: { ...defaults.localFeatures, assistant: { ...defaults.localFeatures.assistant, ...assistant } },
  };
  const search = {
    getConfig: vi.fn().mockResolvedValue(config),
    planAskSearch: vi.fn().mockResolvedValue(rulesPlan({ personIds: [mara.id] })),
    searchSmart: vi.fn().mockResolvedValue(page([asset()])),
    searchMetadata: vi.fn().mockResolvedValue(page([asset()])),
    getSearchSuggestions: vi.fn().mockResolvedValue(['Lisbon', 'Porto', null]),
  };
  const speech = { search: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }) };
  const people = { getAll: vi.fn().mockResolvedValue({ people: [mara, { id: 'x', name: '' }] }) };
  const pets = { getAll: vi.fn().mockResolvedValue([biscuit]) };
  const albums = { getAll: vi.fn().mockResolvedValue([trip]) };
  const tags = { getAll: vi.fn().mockResolvedValue([]) };
  const machineLearning = { planAssistantSearch: vi.fn() };
  const logger = { setContext: vi.fn(), debug: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  vi.mocked(selectMlDestination).mockResolvedValue({ destinationId: 'local' } as never);
  const sut = new AssistantService(
    logger as never,
    search as never,
    speech as never,
    people as never,
    pets as never,
    albums as never,
    tags as never,
    machineLearning as never,
    {} as never,
  );
  return { sut, search, speech, people, albums, machineLearning, logger };
};

const plannerAnswer = (args: Record<string, unknown>, confidence = 0.9) => ({
  tool: 'search_library' as const,
  arguments: args,
  confidence,
});

describe(AssistantService.name, () => {
  const auth = factory.auth({ session: {} });

  it('refuses shared-link sessions with 403', async () => {
    const { sut } = setup();
    const response = sut.ask(factory.auth({ sharedLink: {} }), { query: 'beach' });
    await expect(response).rejects.toBeInstanceOf(ForbiddenException);
    await expect(response).rejects.toThrow('Frameleaf Assistant is not available from a shared link');
  });

  it('refuses when the assistant is turned off', async () => {
    const { sut } = setup({ enabled: false });
    const response = sut.ask(auth, { query: 'beach' });
    await expect(response).rejects.toBeInstanceOf(BadRequestException);
    await expect(response).rejects.toThrow('Frameleaf Assistant is turned off');
  });

  it('answers with the rules by default and never asks the planner', async () => {
    const { sut, search, machineLearning } = setup();
    const response = await sut.ask(auth, { query: 'beach photos of Mara Quill' });

    expect(machineLearning.planAssistantSearch).not.toHaveBeenCalled();
    expect(response.answeredBy).toBe('rules');
    expect(response.plan).toEqual({ people: ['Mara Quill'], visual: 'beach photos of Mara Quill' });
    expect(search.searchSmart).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({
        query: 'beach photos of Mara Quill',
        filter: expect.objectContaining({
          visibility: { ne: AssetVisibility.Locked },
          personIds: { all: [mara.id] },
        }),
      }),
    );
    expect(response.reasons[0].items.map(({ kind }) => kind)).toEqual(['person', 'visual']);
    expect(response.reasons[0].items[1].text).toContain('closest match 1');
  });

  it('uses a valid planner answer and states only what the stored data holds', async () => {
    const { sut, search, machineLearning } = setup({ planner: true });
    machineLearning.planAssistantSearch.mockResolvedValue(
      plannerAnswer({
        people: ['mara quill'],
        city: 'lisbon',
        favorite: true,
        albums: ['Lisbon trip'],
        takenAfter: '2024-07-01T00:00:00.000Z',
        takenBefore: '2024-07-31T23:59:59.999Z',
      }),
    );
    const matches = asset({ isFavorite: true });
    const elsewhere = asset({ exifInfo: { city: 'Porto' } as never, isFavorite: false, people: [] });
    search.searchMetadata.mockResolvedValue(page([matches, elsewhere]));

    const response = await sut.ask(auth, { query: 'favorite photos of Mara in Lisbon last July' });

    expect(response.answeredBy).toBe('planner');
    expect(machineLearning.planAssistantSearch).toHaveBeenCalledWith(
      { destinationId: 'local' },
      expect.objectContaining({
        catalog: {
          people: ['Mara Quill'],
          pets: ['Biscuit'],
          albums: ['Lisbon trip'],
          tags: [],
          places: ['Lisbon', 'Porto'],
        },
        toolSchema: ASSISTANT_TOOL_SCHEMA,
      }),
      expect.any(AbortSignal),
    );
    expect(search.searchMetadata).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({
        filter: expect.objectContaining({
          visibility: { ne: AssetVisibility.Locked },
          personIds: { all: [mara.id] },
          albumIds: { any: [trip.id] },
          city: { eq: 'Lisbon' },
          isFavorite: { eq: true },
        }),
      }),
    );
    expect(response.plan.people).toEqual(['Mara Quill']);
    const [first, second] = response.reasons;
    expect(first.items.map(({ kind }) => kind)).toEqual(['person', 'place', 'date', 'album', 'favorite']);
    expect(first.items.find(({ kind }) => kind === 'date')?.text).toBe('Taken Jul 2, 2024');
    // the second item's stored place and favorite flag do not support those claims, so none are made
    expect(second.items.map(({ kind }) => kind)).toEqual(['date', 'album']);
  });

  it.each([
    ['the planner is unavailable', () => Promise.reject(new AssistantPlannerUnavailableError('no planner'))],
    ['the planner errors', () => Promise.reject(new Error('HTTP 500'))],
    ['the planner names someone not in the catalogue', () => Promise.resolve(plannerAnswer({ people: ['Zed'] }))],
    ['the planner is unsure', () => Promise.resolve(plannerAnswer({ city: 'Lisbon' }, 0.2))],
    ['the planner breaks the schema', () => Promise.resolve(plannerAnswer({ city: 'Lisbon', delete: true }))],
    ['the planner plans nothing', () => Promise.resolve(plannerAnswer({}))],
  ])('falls back to the rules when %s', async (_name, answer) => {
    const { sut, machineLearning } = setup({ planner: true });
    machineLearning.planAssistantSearch.mockImplementation(answer);
    const response = await sut.ask(auth, { query: 'beach photos of Mara Quill' });
    expect(response.answeredBy).toBe('rules');
    expect(response.results.assets.items).toHaveLength(1);
  });

  it('falls back to the rules when the planner plans only a visual search and visual search is off', async () => {
    const { sut, search, machineLearning } = setup({ planner: true });
    search.getConfig.mockResolvedValue({
      ...defaults,
      machineLearning: { ...defaults.machineLearning, enabled: false },
      localFeatures: { ...defaults.localFeatures, assistant: { ...defaults.localFeatures.assistant, planner: true } },
    });
    machineLearning.planAssistantSearch.mockResolvedValue(plannerAnswer({ visual: 'beach' }));
    const response = await sut.ask(auth, { query: 'beach photos of Mara Quill' });
    expect(response.answeredBy).toBe('rules');
  });

  it('names every planned album when the result only has to be in one of them', async () => {
    const { sut, albums, machineLearning } = setup({ planner: true });
    albums.getAll.mockResolvedValue([trip, { id: '0195e2a0-0000-4000-8000-000000000004', albumName: 'Porto' }]);
    machineLearning.planAssistantSearch.mockResolvedValue(plannerAnswer({ albums: ['Lisbon trip', 'Porto'] }));
    const response = await sut.ask(auth, { query: 'photos from my Lisbon or Porto albums' });
    expect(response.reasons[0].items).toContainEqual({
      kind: 'album',
      text: 'In one of the albums Lisbon trip, Porto',
    });
  });

  it('sends a tool schema the planner worker can validate (no references, only keywords it checks)', () => {
    // the worker's own keyword lists (machine-learning/frameleaf_ml/models/assistant_planner.py)
    const source = readFileSync(
      new URL('../../../machine-learning/frameleaf_ml/models/assistant_planner.py', import.meta.url),
      'utf8',
    );
    const words = (name: string) => {
      const body = source.match(new RegExp(String.raw`${name} = \{([^}]*)\}`, 's'))![1];
      return body
        .matchAll(/"([^"]+)"/g)
        .map(([, word]) => word)
        .toArray();
    };
    const allowed = new Set([...words('_ANNOTATIONS'), ...words('_CHECKED')]);
    const visit = (schema: Record<string, unknown>, depth = 0) => {
      for (const keyword of Object.keys(schema)) {
        expect(allowed, `keyword ${keyword}`).toContain(keyword);
      }
      for (const child of Object.values((schema.properties as Record<string, Record<string, unknown>>) ?? {})) {
        visit(child, depth + 1);
      }
      if (schema.items && typeof schema.items === 'object') {
        visit(schema.items as Record<string, unknown>, depth + 1);
      }
    };
    expect(ASSISTANT_TOOL_SCHEMA.type).toBe('object');
    visit(ASSISTANT_TOOL_SCHEMA as Record<string, unknown>);
  });

  it('falls back to the rules when the planner takes too long', async () => {
    vi.useFakeTimers();
    try {
      const { sut, machineLearning } = setup({ planner: true });
      machineLearning.planAssistantSearch.mockReturnValue(new Promise(() => {}));
      const pending = sut.ask(auth, { query: 'beach photos of Mara Quill' });
      await vi.advanceTimersByTimeAsync(ASSISTANT_PLANNER_TIMEOUT_MS + 1);
      await expect(pending).resolves.toMatchObject({ answeredBy: 'rules' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes a clarifying question on as a warning and answers with the rules', async () => {
    const { sut, machineLearning } = setup({ planner: true });
    machineLearning.planAssistantSearch.mockResolvedValue({ clarify: 'Which Mara?' });
    const response = await sut.ask(auth, { query: 'photos of Mara' });
    expect(response.answeredBy).toBe('rules');
    expect(response.warnings).toContain('Which Mara?');
  });

  it('quotes the words actually spoken for transcript matches', async () => {
    const { sut, speech, machineLearning } = setup({ planner: true });
    machineLearning.planAssistantSearch.mockResolvedValue(plannerAnswer({ spoken: 'happy birthday' }));
    const video = asset({ type: AssetType.Video, people: [] });
    speech.search.mockResolvedValue({
      items: [{ asset: video, hits: [{ text: 'happy birthday to you', startMs: 0, endMs: 900 }] }],
      total: 1,
      nextCursor: null,
    });
    const response = await sut.ask(auth, { query: 'the video where we sing happy birthday' });
    expect(speech.search).toHaveBeenCalledWith(auth, expect.objectContaining({ query: '"happy birthday"' }));
    expect(response.reasons[0].items).toEqual([
      { kind: 'speech', text: 'Says “happy birthday to you”', value: 'happy birthday to you' },
    ]);
  });

  it('searches spoken words on their own and claims no visual match for them', async () => {
    const { sut, speech, search, machineLearning } = setup({ planner: true });
    machineLearning.planAssistantSearch.mockResolvedValue(plannerAnswer({ spoken: 'happy birthday', visual: 'cake' }));
    const response = await sut.ask(auth, { query: 'the video with the cake where we sing happy birthday' });
    expect(speech.search).toHaveBeenCalled();
    expect(search.searchSmart).not.toHaveBeenCalled();
    expect(response.plan.visual).toBeUndefined();
    expect(response.summary).not.toContain('look like');
    expect(response.warnings[0]).toContain('Spoken words are searched on their own');
  });

  it('asks the planner in English when the language is empty', async () => {
    const { sut, machineLearning } = setup({ planner: true });
    machineLearning.planAssistantSearch.mockResolvedValue(plannerAnswer({ city: 'Lisbon' }));
    await sut.ask(auth, { query: 'photos in Lisbon', language: '' });
    expect(machineLearning.planAssistantSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ language: 'en' }),
      expect.any(AbortSignal),
    );
  });

  it('reads only the catalogue kinds an API key is granted', async () => {
    const { sut, people, albums } = setup();
    await sut.ask(factory.auth({ apiKey: { permissions: [Permission.AssetRead] } }), { query: 'beach' });
    expect(people.getAll).not.toHaveBeenCalled();
    expect(albums.getAll).not.toHaveBeenCalled();
  });

  it('returns nothing rather than everything when smart search is off and the rules found no filter', async () => {
    const { sut, search } = setup();
    search.getConfig.mockResolvedValue({
      ...defaults,
      machineLearning: { ...defaults.machineLearning, enabled: false },
    });
    search.planAskSearch.mockResolvedValue(rulesPlan());
    const response = await sut.ask(auth, { query: 'something nice' });
    expect(search.searchSmart).not.toHaveBeenCalled();
    expect(search.searchMetadata).not.toHaveBeenCalled();
    expect(response.results.assets.items).toEqual([]);
    expect(response.warnings[0]).toContain('Visual search is off');
  });

  it('never logs the question above debug', async () => {
    const { sut, logger } = setup();
    await sut.ask(auth, { query: 'photos of my secret place' });
    for (const method of [logger.log, logger.warn, logger.error]) {
      expect(JSON.stringify(method.mock.calls)).not.toContain('secret');
    }
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('secret');
  });
});
