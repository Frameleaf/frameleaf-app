import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from 'src/config.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MachineLearningRepository,
  MlSelection,
  VOICE_CLEANUP_MODEL_NAME,
  VoiceCleanupUnavailableError,
} from 'src/repositories/machine-learning.repository.js';

const ndjson = (...lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';

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

describe('MachineLearningRepository voice clean-up (FL-637)', () => {
  let sut: MachineLearningRepository;
  let wavPath: string;
  let outPath: string;
  let selection: MlSelection;

  beforeEach(async () => {
    wavPath = join(tmpdir(), `frameleaf-voice-${randomUUID()}.wav`);
    outPath = join(tmpdir(), `frameleaf-voice-${randomUUID()}-out.wav`);
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
    await rm(outPath, { force: true });
  });

  it('asks the worker what is in the sound', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(streamed(ndjson({ type: 'analysis', noises: ['hum', 'echo'], humHz: 50 }, { type: 'done' })));
    vi.stubGlobal('fetch', fetch);

    await expect(sut.analyzeVoice(selection, wavPath, new AbortController().signal)).resolves.toEqual({
      noises: ['hum', 'echo'],
      humHz: 50,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://worker.lan:3003/voice-cleanup');
    expect(init.headers).toEqual({ Authorization: 'Bearer secret' });
    const form = init.body as FormData;
    expect(JSON.parse(form.get('entries') as string)).toEqual({
      'voice-cleanup': { audio: { modelName: VOICE_CLEANUP_MODEL_NAME, options: { mode: 'analyze' } } },
    });
    expect(form.get('audio')).toBeInstanceOf(Blob);
    expect(selection.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  it('writes the cleaned WAV as it streams and reports progress', async () => {
    const wav = Buffer.from('RIFF....WAVEcleaned');
    const fetch = vi
      .fn()
      .mockResolvedValue(
        streamed(
          ndjson(
            { type: 'progress', done: 0, total: 10 },
            { type: 'progress', done: 10, total: 10 },
            { type: 'info', sampleRate: 48_000, seconds: 4 },
            { type: 'audio', data: wav.subarray(0, 8).toString('base64') },
            { type: 'audio', data: wav.subarray(8).toString('base64') },
            { type: 'done' },
          ),
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const progress: number[] = [];

    await expect(
      sut.cleanVoice(
        selection,
        wavPath,
        { strength: 'light', noises: ['hum', 'background'], humHz: 60 },
        outPath,
        new AbortController().signal,
        (done) => {
          progress.push(done);
        },
      ),
    ).resolves.toEqual({ seconds: 4 });
    expect(progress).toEqual([0, 10]);
    expect(await readFile(outPath)).toEqual(wav);
    const form = fetch.mock.calls[0][1].body as FormData;
    expect(JSON.parse(form.get('entries') as string)['voice-cleanup'].audio.options).toEqual({
      mode: 'clean',
      strength: 'light',
      noises: ['hum', 'background'],
      humHz: 60,
    });
  });

  it('a worker without the task or model is passed over, not failed', async () => {
    for (const status of [404, 422, 503]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
      await expect(sut.analyzeVoice(selection, wavPath, new AbortController().signal)).rejects.toBeInstanceOf(
        VoiceCleanupUnavailableError,
      );
    }
  });

  it('refuses an error line, an unfinished stream and audio before its info', async () => {
    for (const body of [
      ndjson({ type: 'error', message: 'Voice clean-up failed' }),
      ndjson({ type: 'progress', done: 1, total: 2 }),
      ndjson({ type: 'audio', data: 'AAAA' }, { type: 'done' }),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamed(body)));
      await expect(
        sut.cleanVoice(
          selection,
          wavPath,
          { strength: 'standard', noises: ['wind'], humHz: null },
          outPath,
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow(/voice clean-up worker/);
    }
    expect(selection.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });

  it('never sends the sound to Frameleaf Cloud', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      sut.analyzeVoice(
        { ...selection, endpoint: { ...selection.endpoint, cloud: true } } as MlSelection,
        wavPath,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
