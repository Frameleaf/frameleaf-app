import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from 'src/config.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MachineLearningRepository,
  MlSelection,
  TRANSCRIBE_MODEL_NAME,
  TranscriptionUnavailableError,
} from 'src/repositories/machine-learning.repository.js';

const ndjson = (...lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
const info = { type: 'info', model: 'whisper-small', language: 'en', languageProbability: 0.9, duration: 4 };
const segment = (start: number, text: string) => ({
  type: 'segment',
  start,
  end: start + 1,
  text,
  words: [{ start, end: start + 1, text: ` ${text}` }],
});

/** A streamed body split at awkward places, the way a socket delivers it. */
const streamed = (text: string, chunk = 7) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const bytes = new TextEncoder().encode(text);
        for (let index = 0; index < bytes.length; index += chunk) {
          controller.enqueue(bytes.slice(index, index + chunk));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
  );

describe('MachineLearningRepository.transcribe', () => {
  let sut: MachineLearningRepository;
  let wavPath: string;
  let selection: MlSelection;

  beforeEach(async () => {
    wavPath = join(tmpdir(), `frameleaf-transcribe-${randomUUID()}.wav`);
    await writeFile(wavPath, Buffer.from('RIFF0000WAVE'));
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

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(wavPath, { force: true });
  });

  it('posts the audio to the named worker and reads the stream as it arrives', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(streamed(ndjson(info, segment(0, 'one'), segment(1, 'two'), { type: 'done' })));
    vi.stubGlobal('fetch', fetch);
    const seen: string[] = [];

    const result = await sut.transcribe(
      selection,
      wavPath,
      { language: 'de' },
      new AbortController().signal,
      (item) => {
        seen.push(item.text);
      },
    );

    expect(seen).toEqual(['one', 'two']);
    expect(result.info).toEqual(info);
    expect(result.segments).toHaveLength(2);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://worker.lan:3003/transcribe');
    expect(init.headers).toEqual({ Authorization: 'Bearer secret' });
    const form = init.body as FormData;
    expect(JSON.parse(form.get('entries') as string)).toEqual({
      transcribe: { audio: { modelName: TRANSCRIBE_MODEL_NAME, options: { wordTimestamps: true, language: 'de' } } },
    });
    expect((form.get('audio') as File).size).toBe(12);
    expect(selection.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', bytesSent: 12 }));
  });

  it('asks for detection when no language is given', async () => {
    const fetch = vi.fn().mockResolvedValue(streamed(ndjson(info, { type: 'done' })));
    vi.stubGlobal('fetch', fetch);
    await sut.transcribe(selection, wavPath, { language: null }, new AbortController().signal, vi.fn());
    const form = fetch.mock.calls[0][1].body as FormData;
    expect(JSON.parse(form.get('entries') as string).transcribe.audio.options).toEqual({ wordTimestamps: true });
  });

  it.each([404, 422, 503])('reports a worker that cannot transcribe (%s) as unavailable', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status })));
    await expect(
      sut.transcribe(selection, wavPath, { language: null }, new AbortController().signal, vi.fn()),
    ).rejects.toBeInstanceOf(TranscriptionUnavailableError);
    expect(selection.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });

  it.each([
    ['an error line', ndjson(info, { type: 'error', message: 'Transcription failed' })],
    ['a stream that stops early', ndjson(info, segment(0, 'one'))],
    ['a segment before the info', ndjson(segment(0, 'one'), { type: 'done' })],
    ['a line that is not a transcript', ndjson(info, { type: 'segment', start: 'soon' })],
  ])('fails on %s', async (_name, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamed(body)));
    await expect(
      sut.transcribe(selection, wavPath, { language: null }, new AbortController().signal, vi.fn()),
    ).rejects.toThrow();
  });

  it('never sends to Frameleaf Cloud', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      sut.transcribe(
        { ...selection, endpoint: { url: 'frameleaf-cloud:gateway', cloud: true } },
        wavPath,
        { language: null },
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
