import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from 'src/config.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  AssistantPlannerUnavailableError,
  MachineLearningRepository,
  MlSelection,
} from 'src/repositories/machine-learning.repository.js';

const answer = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'content-type': 'application/json' } });

describe('MachineLearningRepository.planAssistantSearch', () => {
  let sut: MachineLearningRepository;
  let selection: MlSelection;
  const request = {
    question: 'photos of Mara in Lisbon',
    language: 'en',
    today: '2026-11-10',
    catalog: { people: ['Mara'], pets: [], albums: [], tags: [], places: ['Lisbon'] },
    toolSchema: { type: 'object' },
  };

  beforeEach(() => {
    sut = new MachineLearningRepository(LoggingRepository.create());
    sut.setup({ ...defaults.machineLearning, urls: ['http://ml:3003'] });
    selection = {
      destinationId: 'destination',
      kind: MlDestinationKind.Lan,
      workload: MlWorkload.Clip,
      endpoint: { url: 'https://worker.lan:3003/', authToken: 'secret' },
      record: vi.fn(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends only the question and catalogue as JSON and reads one tool call', async () => {
    const plan = { tool: 'search_library', arguments: { people: ['Mara'] }, confidence: 0.8 };
    const fetch = vi.fn().mockResolvedValue(answer(plan));
    vi.stubGlobal('fetch', fetch);

    await expect(sut.planAssistantSearch(selection, request, new AbortController().signal)).resolves.toEqual(plan);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://worker.lan:3003/assistant/plan');
    expect(init.headers).toEqual({ Authorization: 'Bearer secret', 'Content-Type': 'application/json' });
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect(selection.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  it('reads a clarifying question', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer({ clarify: 'Which Mara?' })));
    await expect(sut.planAssistantSearch(selection, request, new AbortController().signal)).resolves.toEqual({
      clarify: 'Which Mara?',
    });
  });

  it.each([404, 422, 501, 503])('treats %s as a worker without a planner', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer({ detail: 'no' }, status)));
    await expect(sut.planAssistantSearch(selection, request, new AbortController().signal)).rejects.toBeInstanceOf(
      AssistantPlannerUnavailableError,
    );
    expect(selection.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });

  it('refuses any other answer shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer({ tool: 'delete_library', arguments: {}, confidence: 1 })));
    await expect(sut.planAssistantSearch(selection, request, new AbortController().signal)).rejects.toThrow();
  });

  it('never sends a question to Frameleaf Cloud', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const cloud = { ...selection, endpoint: { ...selection.endpoint, cloud: true } } as MlSelection;
    await expect(sut.planAssistantSearch(cloud, request, new AbortController().signal)).rejects.toBeInstanceOf(
      AssistantPlannerUnavailableError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
