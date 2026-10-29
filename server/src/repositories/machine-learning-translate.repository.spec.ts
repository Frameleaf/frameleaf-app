import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from 'src/config.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MachineLearningRepository,
  MlSelection,
  TRANSLATE_MODEL_NAME,
  TranslationUnavailableError,
} from 'src/repositories/machine-learning.repository.js';

const answer = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'content-type': 'application/json' } });

describe('MachineLearningRepository.translateCaptions', () => {
  let sut: MachineLearningRepository;
  let selection: MlSelection;
  const options = { source: 'en', target: 'fr', lines: ['Hello', '', 'Bye'] };

  beforeEach(() => {
    sut = new MachineLearningRepository(LoggingRepository.create());
    sut.setup({ ...defaults.machineLearning, urls: ['http://ml:3003'] });
    selection = {
      destinationId: 'destination',
      kind: MlDestinationKind.Lan,
      workload: MlWorkload.StudioAi,
      endpoint: { url: 'https://worker.lan:3003/', authToken: 'secret' },
      record: vi.fn(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends only the lines and the two languages to the named worker', async () => {
    const fetch = vi.fn().mockResolvedValue(answer({ model: 'm2m100-418m', translations: ['Bonjour', '', 'Salut'] }));
    vi.stubGlobal('fetch', fetch);

    const result = await sut.translateCaptions(selection, options, new AbortController().signal);

    expect(result).toEqual({ model: 'm2m100-418m', translations: ['Bonjour', '', 'Salut'] });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://worker.lan:3003/translate');
    expect(init.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(init.redirect).toBe('error');
    const form = init.body as FormData;
    expect(form.keys().toArray().sort()).toEqual(['entries', 'lines']);
    expect(JSON.parse(form.get('entries') as string)).toEqual({
      translate: { textual: { modelName: TRANSLATE_MODEL_NAME, options: { source: 'en', target: 'fr' } } },
    });
    expect(JSON.parse(form.get('lines') as string)).toEqual(['Hello', '', 'Bye']);
    expect(selection.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  it.each([404, 422, 501, 503])('treats %s as a worker that cannot translate', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer({ detail: 'no' }, status)));
    await expect(sut.translateCaptions(selection, options, new AbortController().signal)).rejects.toBeInstanceOf(
      TranslationUnavailableError,
    );
    expect(selection.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });

  it('refuses an answer that does not cover every line', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer({ model: 'm', translations: ['Bonjour'] })));
    await expect(sut.translateCaptions(selection, options, new AbortController().signal)).rejects.toThrow(
      'did not answer every line',
    );
  });

  it('refuses a malformed answer and other failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer({ translations: 'nope' })));
    await expect(sut.translateCaptions(selection, options, new AbortController().signal)).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer({ detail: 'boom' }, 500)));
    await expect(sut.translateCaptions(selection, options, new AbortController().signal)).rejects.toThrow(
      'The translation worker answered 500',
    );
  });

  it('never sends captions to a cloud endpoint from this path', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      sut.translateCaptions(
        { ...selection, endpoint: { url: 'https://cloud', cloud: true } as never },
        options,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
