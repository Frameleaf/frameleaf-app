import { ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueExecution } from 'src/queue/types.js';
import type { MlDestinationRepository, MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { defaults } from 'src/config.js';
import { AssetRestorationMode } from 'src/dtos/asset-restoration.dto.js';
import {
  RESTORATION_PROTOCOL,
  RESTORATION_RESULT_HEADER,
  RestorationDynamicRange,
  RestorationWorkerErrorCode,
} from 'src/dtos/restoration-inference.dto.js';
import { MachineLearningHardwareAcceleration, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  CloudJobsUnavailableError,
  CutoutUnavailableError,
  CutoutWorkerError,
  FRAMELEAF_CLOUD_ENDPOINT,
  MachineLearningRepository,
  MlSelection,
  MlUsage,
  ModelTask,
  ModelType,
  RestorationWorkerError,
} from 'src/repositories/machine-learning.repository.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import * as cloudDisclosure from 'src/utils/frameleaf-cloud.js';
import {
  RestorationInferenceInput,
  RestorationInferenceOptions,
  RestorationSelection,
  selectRestorationDestination,
} from 'src/utils/restoration.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';

const qwenModelName = 'Qwen/Qwen2.5-VL-3B-Instruct';
const florenceModelName = 'microsoft/Florence-2-base-ft';
const boundProfile = parseDesktopModelCatalogue(
  JSON.parse(readFileSync(new URL('../../resources/desktop/model-catalogue.json', import.meta.url), 'utf8')),
).profiles[0];
const boundDimensions = boundProfile.embeddingDimensions;
if (boundDimensions === undefined) throw new Error('clip_fixture_required');

const localUrl = 'http://frameleaf-machine-learning:3003';
// The LAN restoration worker's port (FL-72 fixtures keep restoration on its own worker).
const lanUrl = 'https://workshop.lan:3004';

const description = {
  imageHeight: 120,
  imageWidth: 160,
  [ModelTask.IMAGE_DESCRIPTION]: {
    description: 'A beach scene.',
    people: [],
    environment: 'beach',
    objects: ['sand'],
    visible_text: [],
    context: '',
    tags: ['beach'],
  },
};

/** A model the restoration worker reports as available, weight-verified and qualified (FL-42). */
const qualifiedModel = {
  id: 'faithful-1',
  family: 'realbasicvsr',
  mode: 'faithful',
  displayName: 'Faithful',
  revision: 'abc',
  fingerprint: 'sha256:weights',
  state: 'available',
  reasons: [],
  nativeScale: 4,
  maxInputLongEdge: 1920,
  maxFrames: 120,
  dynamicRanges: ['sdr'],
  measured: [],
  qualificationId: 'qualification-1',
};

const restorationReport = (models: unknown[]) => ({
  protocol: RESTORATION_PROTOCOL,
  workloads: ['restoration-faithful'],
  models,
  gpus: [],
  configurationProblems: [],
  checkedAt: '2026-09-22T12:00:00.000Z',
});

const jsonResponse = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'content-type': 'application/json' } });

const selection = (
  kind: MlDestinationKind,
  url: string,
  record: (usage: MlUsage) => void = () => {},
  authToken?: string,
): MlSelection => ({
  destinationId: `destination-${kind}`,
  kind,
  workload: MlWorkload.Enrichment,
  endpoint: authToken ? { url, authToken } : { url },
  record,
});

describe(MachineLearningRepository.name, () => {
  let sut: MachineLearningRepository;
  let imagePath: string;

  beforeEach(async () => {
    imagePath = join(tmpdir(), `frameleaf-machine-learning-${randomUUID()}.webp`);
    await writeFile(imagePath, Buffer.from([0, 1, 2, 3]));

    sut = new MachineLearningRepository(LoggingRepository.create());
    sut.setup({
      ...defaults.machineLearning,
      urls: [localUrl],
      availabilityChecks: { ...defaults.machineLearning.availabilityChecks, enabled: false },
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(imagePath, { force: true });
  });

  describe('predict', () => {
    it.each([
      ['ml_worker_busy', 'destination-capacity'],
      ['model_identity_unavailable', undefined],
    ])('only defers a structured worker capacity refusal (%s)', async (detail, expected) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail }, 503)));
      const context = {
        claim: { data: {}, safeToRetry: true },
        signal: new AbortController().signal,
      } as QueueExecution;
      await expect(
        queueExecution.run(context, () =>
          sut.encodeText(selection(MlDestinationKind.Local, localUrl), 'fixture', { modelName: 'synthetic' }),
        ),
      ).rejects.toThrow();
      expect(context.dependencyReason).toBe(expected);
    });

    it('defers audio memory pressure instead of treating it as a missing transcription model', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: 'ml_worker_busy' }, 503)));
      const context = {
        claim: { data: {}, safeToRetry: true },
        signal: new AbortController().signal,
      } as QueueExecution;
      await expect(
        queueExecution.run(context, () =>
          sut.transcribe(
            selection(MlDestinationKind.Local, localUrl),
            imagePath,
            { language: null },
            context.signal,
            vi.fn(),
          ),
        ),
      ).rejects.toMatchObject({ reason: 'destination-capacity' });
      expect(context.dependencyReason).toBe('destination-capacity');
    });

    it('keeps structured transcription capacity distinct for durable operations outside SQL queue context', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: 'ml_worker_busy' }, 503)));
      await expect(
        sut.transcribe(
          selection(MlDestinationKind.Local, localUrl),
          imagePath,
          { language: null },
          new AbortController().signal,
          vi.fn(),
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('does not try a fallback model when the worker is full', async () => {
      const fetch = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ detail: 'ml_worker_busy' }, 503)));
      vi.stubGlobal('fetch', fetch);
      await expect(
        sut.describeImageRun(selection(MlDestinationKind.Local, localUrl), imagePath, {
          modelName: 'primary',
          fallbackModelName: 'fallback',
          acceleration: MachineLearningHardwareAcceleration.Auto,
          device: 'AUTO',
        }),
      ).rejects.toMatchObject({ status: 503 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([MlWorkload.Clip, MlWorkload.PetRecognition])(
      'binds NAS %s transport and returned vector to the exact producing profile',
      async (workload) => {
        const embedding = JSON.stringify(Array.from({ length: boundDimensions }, () => 0.1));
        const fetch = vi.fn().mockResolvedValue(
          jsonResponse({
            protocolVersion: 1,
            modelKey: boundProfile.modelKey,
            preprocessingSha256: boundProfile.spec.preprocessingSha256,
            result: { clip: embedding },
          }),
        );
        vi.stubGlobal('fetch', fetch);
        const assertAuthority = vi.fn().mockResolvedValue(undefined);
        const record = vi.fn();
        const chosen = selection(MlDestinationKind.Lan, lanUrl, record, 'synthetic-token');
        chosen.workload = MlWorkload.Clip;
        chosen.endpoint.assertAuthority = assertAuthority;
        expect(await sut.encodeBoundClip({ ...chosen, workload }, { text: 'frameleaf fixture' }, boundProfile)).toEqual(
          {
            embedding,
            modelKey: boundProfile.modelKey,
          },
        );
        expect(String(fetch.mock.calls[0][0])).toBe(`${lanUrl}/predict-bound`);
        const request = fetch.mock.calls[0][1];
        expect(new Headers(request.headers).get('authorization')).toBe('Bearer synthetic-token');
        expect(JSON.parse((request.body as FormData).get('binding') as string)).toEqual({
          protocolVersion: 1,
          modelKey: boundProfile.modelKey,
          models: boundProfile.spec.models,
          entries: boundProfile.spec.entries,
          preprocessingSha256: boundProfile.spec.preprocessingSha256,
        });
        expect(assertAuthority).toHaveBeenCalledTimes(2);
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
      },
    );

    it.each(['wrong-key', 'wrong-preprocessing', 'wrong-dimensions', 'unexpected-image-metadata'])(
      'refuses %s producer output without accounting it as success',
      async (failure) => {
        const fetch = vi.fn().mockResolvedValue(
          jsonResponse({
            protocolVersion: 1,
            modelKey: failure === 'wrong-key' ? `clip:${'f'.repeat(64)}` : boundProfile.modelKey,
            preprocessingSha256:
              failure === 'wrong-preprocessing' ? 'e'.repeat(64) : boundProfile.spec.preprocessingSha256,
            result: {
              ...(failure === 'unexpected-image-metadata' && { imageWidth: 2 }),
              clip: JSON.stringify(
                Array.from({ length: failure === 'wrong-dimensions' ? 2 : boundDimensions }, () => 0.1),
              ),
            },
          }),
        );
        vi.stubGlobal('fetch', fetch);
        const record = vi.fn();
        const chosen = selection(MlDestinationKind.Local, localUrl, record);
        chosen.workload = MlWorkload.Clip;
        await expect(sut.encodeBoundClip(chosen, { text: 'fixture' }, boundProfile)).rejects.toThrow(
          'producer_result_invalid',
        );
        expect(record).toHaveBeenCalledTimes(1);
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
        expect(fetch).toHaveBeenCalledTimes(1);
      },
    );

    it('does not fall back to legacy prediction after a bound producer refusal', async () => {
      const fetch = vi.fn().mockResolvedValue(jsonResponse({ detail: 'model_identity_unavailable' }, 409));
      vi.stubGlobal('fetch', fetch);
      const chosen = selection(MlDestinationKind.Lan, lanUrl);
      chosen.workload = MlWorkload.Clip;
      await expect(sut.encodeBoundClip(chosen, { text: 'fixture' }, boundProfile)).rejects.toThrow(
        'failed with status 409',
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toBe(`${lanUrl}/predict-bound`);
    });
    it('sends the request to the selected endpoint only and never to another URL when it fails', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response('error', { status: 500, statusText: 'Internal Error' }));
      vi.stubGlobal('fetch', fetch);

      await expect(
        sut.encodeImage(selection(MlDestinationKind.Lan, lanUrl), imagePath, { ...defaults.machineLearning.clip }),
      ).rejects.toThrow(/lan destination destination-lan failed with status 500/);

      // One call, to the LAN worker; the local URL is untouched.
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toBe(`${lanUrl}/predict`);
    });

    it('does not fall through to the local URL when the chosen destination is down', async () => {
      const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      vi.stubGlobal('fetch', fetch);

      await expect(
        sut.encodeImage(
          selection(MlDestinationKind.Lan, lanUrl, () => {}, 'lan-token'),
          imagePath,
          {
            ...defaults.machineLearning.clip,
          },
        ),
      ).rejects.toThrow(/lan destination destination-lan failed: fetch failed/);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toBe(`${lanUrl}/predict`);
    });

    it('never sends a Frameleaf Cloud request through the predict protocol or anywhere else (FL-159)', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const record = vi.fn();
      const cloud: MlSelection = {
        destinationId: 'destination-frameleaf-cloud',
        kind: MlDestinationKind.FrameleafCloud,
        workload: MlWorkload.Enrichment,
        endpoint: FRAMELEAF_CLOUD_ENDPOINT,
        record,
      };

      await expect(sut.encodeImage(cloud, imagePath, { ...defaults.machineLearning.clip })).rejects.toBeInstanceOf(
        CloudJobsUnavailableError,
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('never encodes search text on Frameleaf Cloud, even when smart search is routed there (FL-455)', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const record = vi.fn();
      const cloud: MlSelection = {
        destinationId: 'destination-frameleaf-cloud',
        kind: MlDestinationKind.FrameleafCloud,
        workload: MlWorkload.Clip,
        endpoint: FRAMELEAF_CLOUD_ENDPOINT,
        record,
      };

      await expect(
        sut.encodeText(cloud, 'a dog on a beach', { modelName: defaults.machineLearning.clip.modelName }),
      ).rejects.toBeInstanceOf(CloudJobsUnavailableError);
      expect(fetch).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('sends the bearer token of the selected endpoint', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({ [ModelTask.SEARCH]: '[1,2,3]', imageHeight: 1, imageWidth: 1 }));
      vi.stubGlobal('fetch', fetch);

      await sut.encodeImage(
        selection(MlDestinationKind.Lan, lanUrl, () => {}, 'lan-token'),
        imagePath,
        {
          ...defaults.machineLearning.clip,
        },
      );

      expect(fetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer lan-token' });
    });

    it('records usage once per request with bytes sent, bytes received and the outcome', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({ [ModelTask.SEARCH]: '[1,2,3]', imageHeight: 1, imageWidth: 1 }));
      vi.stubGlobal('fetch', fetch);
      const record = vi.fn();

      await sut.encodeImage(selection(MlDestinationKind.Local, localUrl, record), imagePath, {
        ...defaults.machineLearning.clip,
      });

      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ bytesSent: 4, outcome: 'success', durationMs: expect.any(Number) }),
      );
      expect(record.mock.calls[0][0].bytesReceived).toBeGreaterThan(0);
    });

    it('records a failure when the endpoint answers with an error', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 503, statusText: 'Unavailable' }));
      vi.stubGlobal('fetch', fetch);
      const record = vi.fn();

      await expect(
        sut.encodeText(selection(MlDestinationKind.Local, localUrl, record), 'sunset', { modelName: 'clip' }),
      ).rejects.toThrow(/failed with status 503/);

      expect(record).toHaveBeenCalledWith(expect.objectContaining({ bytesSent: 6, outcome: 'failure' }));
    });
  });

  describe('describeImage', () => {
    it('does not retry the Florence fallback model when OpenVINO acceleration is selected', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response('error', { status: 500, statusText: 'Internal Error' }));
      vi.stubGlobal('fetch', fetch);

      await expect(
        sut.describeImage(selection(MlDestinationKind.Local, localUrl), imagePath, {
          modelName: qwenModelName,
          fallbackModelName: florenceModelName,
          acceleration: MachineLearningHardwareAcceleration.OpenVino,
          device: 'AUTO',
        }),
      ).rejects.toThrow('Machine learning request');

      expect(fetch).toHaveBeenCalledTimes(1);
      const formData = fetch.mock.calls[0][1].body as FormData;
      const entries = JSON.parse(String(formData.get('entries')));
      expect(entries[ModelTask.IMAGE_DESCRIPTION][ModelType.VISUAL].modelName).toBe(qwenModelName);
    });

    it('retries the Florence fallback model with automatic acceleration (CPU-only worker)', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('error', { status: 500, statusText: 'Internal Error' }))
        .mockResolvedValueOnce(jsonResponse(description));
      vi.stubGlobal('fetch', fetch);

      const result = await sut.describeImage(selection(MlDestinationKind.Local, localUrl), imagePath, {
        modelName: qwenModelName,
        fallbackModelName: florenceModelName,
        acceleration: MachineLearningHardwareAcceleration.Auto,
        device: 'AUTO',
      });

      expect(result.description).toBe('A beach scene.');
      expect(fetch).toHaveBeenCalledTimes(2);
      const retry = JSON.parse(String((fetch.mock.calls[1][1].body as FormData).get('entries')));
      expect(retry[ModelTask.IMAGE_DESCRIPTION][ModelType.VISUAL].modelName).toBe(florenceModelName);
    });

    it('retries the fallback model on the same local destination with CUDA acceleration', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('error', { status: 500, statusText: 'Internal Error' }))
        .mockResolvedValueOnce(jsonResponse(description));
      vi.stubGlobal('fetch', fetch);

      const result = await sut.describeImage(selection(MlDestinationKind.Local, localUrl), imagePath, {
        modelName: qwenModelName,
        fallbackModelName: florenceModelName,
        acceleration: MachineLearningHardwareAcceleration.Cuda,
        device: 'AUTO',
      });

      expect(result.description).toBe('A beach scene.');
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(String(fetch.mock.calls[0][0])).toBe(`${localUrl}/predict`);
      expect(String(fetch.mock.calls[1][0])).toBe(`${localUrl}/predict`);
      const retry = JSON.parse(String((fetch.mock.calls[1][1].body as FormData).get('entries')));
      expect(retry[ModelTask.IMAGE_DESCRIPTION][ModelType.VISUAL].modelName).toBe(florenceModelName);
    });

    it('says which model answered and where it ran, and keeps the device out of the stored result (FL-427)', async () => {
      const ranOn = {
        ...description,
        [ModelTask.IMAGE_DESCRIPTION]: { ...description[ModelTask.IMAGE_DESCRIPTION], device: 'cpu' },
      };
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('error', { status: 500, statusText: 'Internal Error' }))
        .mockResolvedValueOnce(jsonResponse(ranOn))
        .mockResolvedValueOnce(jsonResponse(ranOn));
      vi.stubGlobal('fetch', fetch);
      const options = {
        modelName: qwenModelName,
        fallbackModelName: florenceModelName,
        acceleration: MachineLearningHardwareAcceleration.Auto,
        device: 'AUTO',
      };

      const run = await sut.describeImageRun(selection(MlDestinationKind.Local, localUrl), imagePath, options);
      const result = await sut.describeImage(selection(MlDestinationKind.Local, localUrl), imagePath, options);

      expect(run).toEqual({
        result: description[ModelTask.IMAGE_DESCRIPTION],
        model: florenceModelName,
        device: 'cpu',
      });
      expect(result).not.toHaveProperty('device');
    });

    it('never retries the fallback model on a cloud destination', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response('error', { status: 500, statusText: 'Internal Error' }));
      vi.stubGlobal('fetch', fetch);

      await expect(
        sut.describeImage(
          { ...selection(MlDestinationKind.FrameleafCloud, ''), endpoint: FRAMELEAF_CLOUD_ENDPOINT },
          imagePath,
          {
            modelName: qwenModelName,
            fallbackModelName: florenceModelName,
            acceleration: MachineLearningHardwareAcceleration.Cuda,
            device: 'AUTO',
          },
        ),
      ).rejects.toBeInstanceOf(CloudJobsUnavailableError);

      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('probe', () => {
    it('shares concurrent probes of the same endpoint and authority', async () => {
      const held = Promise.withResolvers<void>();
      const fetch = vi.fn().mockImplementation(async (url: URL) => {
        if (url.pathname === '/capabilities') {
          await held.promise;
          return jsonResponse({ workloads: ['face'] });
        }
        return url.pathname === '/ping' ? new Response('pong') : new Response('', { status: 404 });
      });
      vi.stubGlobal('fetch', fetch);
      const calls = Array.from({ length: 8 }, () => sut.probe({ url: localUrl }, { maxAgeMs: 10_000 }));
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
      held.resolve();
      const results = await Promise.all(calls);
      expect(results.every((probe) => probe.reachable)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('does not share in-flight observations between access tokens', async () => {
      const fetch = vi
        .fn()
        .mockImplementation((url: URL) =>
          url.pathname === '/ping'
            ? new Response('pong')
            : url.pathname === '/capabilities'
              ? jsonResponse({ workloads: ['face'] })
              : new Response('', { status: 404 }),
        );
      vi.stubGlobal('fetch', fetch);
      await Promise.all(['first', 'second'].map((authToken) => sut.probe({ url: localUrl, authToken })));
      expect(fetch).toHaveBeenCalledTimes(6);
    });

    it('reauthorizes each caller after a shared probe finishes', async () => {
      let allowed = true;
      const held = Promise.withResolvers<void>();
      const fetch = vi.fn().mockImplementation(async (url: URL) => {
        if (url.pathname === '/capabilities') {
          await held.promise;
          return jsonResponse({ workloads: ['face'] });
        }
        return url.pathname === '/ping' ? new Response('pong') : new Response('', { status: 404 });
      });
      vi.stubGlobal('fetch', fetch);
      const first = sut.probe({ url: localUrl });
      const second = sut.probe({
        url: localUrl,
        assertAuthority: () => (allowed ? Promise.resolve() : Promise.reject(new Error('synthetic authority revoked'))),
      });
      await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => url.pathname === '/capabilities')).toBe(true));
      allowed = false;
      held.resolve();
      const results = await Promise.allSettled([first, second]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1]).toMatchObject({ status: 'rejected', reason: { message: 'synthetic authority revoked' } });
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('retries after a failed shared probe instead of retaining the settled promise', async () => {
      let healthy = false;
      const fetch = vi.fn().mockImplementation((url: URL) => {
        if (!healthy) return Promise.reject(new TypeError('synthetic offline'));
        return url.pathname === '/ping'
          ? new Response('pong')
          : url.pathname === '/capabilities'
            ? jsonResponse({ workloads: ['face'] })
            : new Response('', { status: 404 });
      });
      vi.stubGlobal('fetch', fetch);
      expect((await sut.probe({ url: localUrl })).reachable).toBe(false);
      healthy = true;
      expect((await sut.probe({ url: localUrl })).workloads).toEqual(['face']);
      expect(fetch).toHaveBeenCalledTimes(4);
    });

    it('does not fetch hardware during admission and still fetches it for a diagnostic probe', async () => {
      const fetch = vi
        .fn()
        .mockImplementation((url: URL) =>
          url.pathname === '/ping'
            ? new Response('pong')
            : url.pathname === '/capabilities'
              ? jsonResponse({ workloads: ['face'] })
              : new Response('', { status: 404 }),
        );
      vi.stubGlobal('fetch', fetch);
      expect((await sut.probe({ url: localUrl }, { maxAgeMs: 10_000, includeHardware: false })).workloads).toEqual([
        'face',
      ]);
      expect(fetch.mock.calls.some(([url]) => url.pathname === '/hardware')).toBe(false);
      await sut.probe({ url: localUrl }, { maxAgeMs: 10_000 });
      expect(fetch.mock.calls.some(([url]) => url.pathname === '/hardware')).toBe(true);
    });

    it.each(['policy', 'consent', 'quarantine-clear'])(
      're-probes unchanged URL/token after %s authority changes',
      async (transition) => {
        let authorityIdentity = 'original';
        const authority = {
          assertEndpointAuthority: vi.fn(() => Promise.resolve(authorityIdentity)),
        } as unknown as MlDestinationRepository;
        const repository = new MachineLearningRepository(LoggingRepository.create(), authority);
        repository.setup(defaults.machineLearning);
        const fetch = vi
          .fn()
          .mockImplementation((url: URL) =>
            Promise.resolve(
              url.pathname === '/ping'
                ? new Response('pong')
                : url.pathname === '/capabilities'
                  ? jsonResponse({ workloads: ['face'] })
                  : new Response('', { status: 404 }),
            ),
          );
        vi.stubGlobal('fetch', fetch);
        await repository.probe({ url: lanUrl, authToken: 'unchanged' }, { maxAgeMs: 10_000 });
        const count = fetch.mock.calls.length;
        await repository.probe({ url: lanUrl, authToken: 'unchanged' }, { maxAgeMs: 10_000 });
        expect(fetch).toHaveBeenCalledTimes(count);
        authorityIdentity = transition;
        await repository.probe({ url: lanUrl, authToken: 'unchanged' }, { maxAgeMs: 10_000 });
        expect(fetch).toHaveBeenCalledTimes(count * 2);
      },
    );
    it('reports an unreachable endpoint without claiming any workload', async () => {
      const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      vi.stubGlobal('fetch', fetch);

      const probe = await sut.probe({ url: lanUrl });

      expect(probe).toMatchObject({ reachable: false, workloads: [], hardware: null, error: 'fetch failed' });
    });

    it('takes served workloads from the worker and ignores values it does not know', async () => {
      const fetch = vi.fn().mockImplementation((url: URL) => {
        switch (url.pathname) {
          case '/ping': {
            return Promise.resolve(new Response('pong'));
          }
          case '/capabilities': {
            return Promise.resolve(jsonResponse({ workloads: ['face', 'restoration-faithful', 'teleport'] }));
          }
          case '/restoration/models': {
            return Promise.resolve(jsonResponse(restorationReport([qualifiedModel])));
          }
          default: {
            return Promise.resolve(new Response('', { status: 404 }));
          }
        }
      });
      vi.stubGlobal('fetch', fetch);

      const probe = await sut.probe({ url: lanUrl, authToken: 'lan-token' });

      expect(probe.reachable).toBe(true);
      expect(probe.workloads).toEqual([MlWorkload.Face, MlWorkload.RestorationFaithful]);
      expect(probe.error).toBeNull();
      expect(fetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer lan-token' });
    });

    it.each([
      ['no model report', null],
      ['an unqualified model', [{ ...qualifiedModel, qualificationId: null }]],
      ['unverified weights', [{ ...qualifiedModel, fingerprint: null }]],
      ['a model that is not available', [{ ...qualifiedModel, state: 'weights-missing' }]],
      ['a model for the other mode', [{ ...qualifiedModel, mode: 'creative' }]],
    ])('never admits a restoration claim backed by %s (FL-42)', async (_label, models) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: URL) => {
          switch (url.pathname) {
            case '/ping': {
              return Promise.resolve(new Response('pong'));
            }
            case '/capabilities': {
              return Promise.resolve(jsonResponse({ workloads: ['face', 'restoration-faithful'] }));
            }
            case '/restoration/models': {
              return Promise.resolve(
                models === null ? new Response('', { status: 404 }) : jsonResponse(restorationReport(models)),
              );
            }
            default: {
              return Promise.resolve(new Response('', { status: 404 }));
            }
          }
        }),
      );

      const probe = await sut.probe({ url: lanUrl, authToken: 'lan-token' });

      expect(probe.reachable).toBe(true);
      expect(probe.workloads).toEqual([MlWorkload.Face]);
    });

    it('credits a legacy predict container without a capabilities route with the library workloads only', async () => {
      const fetch = vi
        .fn()
        .mockImplementation((url: URL) =>
          Promise.resolve(url.pathname === '/ping' ? new Response('pong') : new Response('', { status: 404 })),
        );
      vi.stubGlobal('fetch', fetch);

      const probe = await sut.probe({ url: localUrl });

      expect(probe.workloads).toEqual([
        MlWorkload.Face,
        MlWorkload.Clip,
        MlWorkload.Ocr,
        MlWorkload.Enrichment,
        MlWorkload.PetRecognition,
      ]);
      expect(probe.workloads).not.toContain(MlWorkload.RestorationFaithful);
      expect(probe.workloads).not.toContain(MlWorkload.StudioAi);
    });

    it('never reuses an authenticated probe for different credentials at the same URL', async () => {
      const fetch = vi.fn().mockImplementation((url: URL, options: RequestInit) => {
        if ((options.headers as Record<string, string>).Authorization !== 'Bearer accepted') {
          return Promise.resolve(new Response('', { status: 401 }));
        }
        return Promise.resolve(url.pathname === '/ping' ? new Response('pong') : new Response('', { status: 404 }));
      });
      vi.stubGlobal('fetch', fetch);
      await sut.probe({ url: lanUrl, authToken: 'accepted' }, { maxAgeMs: 10_000 });
      const rejected = await sut.probe({ url: lanUrl, authToken: 'rejected' }, { maxAgeMs: 10_000 });
      expect(rejected.reachable).toBe(false);
      expect(rejected.workloads).toEqual([]);
    });

    const heldPing = () => {
      const deferred = Promise.withResolvers<Response>();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementation((url: URL) =>
            url.pathname === '/ping' ? deferred.promise : Promise.resolve(new Response('', { status: 404 })),
          ),
      );
      return deferred;
    };

    it('keeps a destination probe across an unrelated configuration change', async () => {
      const deferred = heldPing();
      const pending = sut.probe({ url: localUrl });
      sut.setup({ ...defaults.machineLearning });
      deferred.resolve(new Response('pong'));
      expect((await pending).reachable).toBe(true);
    });

    it('rejects oversized capability reports before admitting any workloads', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementation((url: URL) =>
            Promise.resolve(
              url.pathname === '/ping'
                ? new Response('pong')
                : jsonResponse({ workloads: ['face'], padding: 'x'.repeat(33_000) }),
            ),
          ),
      );
      const result = await sut.probe({ url: localUrl });
      expect(result.workloads).toEqual([]);
      expect(result.error).not.toBeNull();
    });

    it('treats malformed hardware as unknown and strips injected qualification fields', async () => {
      const hardware = {
        providers: [],
        openvinoDeviceIds: [],
        torchCudaAvailable: false,
        cudaDeviceCount: 0,
        preferredAcceleration: MachineLearningHardwareAcceleration.Auto,
        authenticatedRenderProof: true,
      };
      let invalid = true;
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementation((url: URL) =>
            Promise.resolve(
              url.pathname === '/ping'
                ? new Response('pong')
                : jsonResponse(
                    url.pathname === '/capabilities'
                      ? { workloads: ['face'] }
                      : { ...hardware, cudaDeviceCount: invalid ? -1 : 0 },
                  ),
            ),
          ),
      );
      expect((await sut.probe({ url: localUrl })).hardware).toBeNull();
      expect((await sut.getHardware({ url: localUrl })).cudaDeviceCount).toBe(0);
      invalid = false;
      expect((await sut.probe({ url: localUrl })).hardware).not.toHaveProperty('authenticatedRenderProof');
    });

    it('rejects real HTTP redirects and times out a stalled capability body', async () => {
      let mode: 'redirect' | 'stalled' = 'redirect';
      let escaped = false;
      const server = createServer((request, response) => {
        if (request.url === '/escape') {
          escaped = true;
          response.end('pong');
        } else if (mode === 'redirect') {
          response.writeHead(302, { location: '/escape' });
          response.end();
        } else if (request.url === '/ping') {
          response.end('pong');
        } else {
          response.writeHead(200);
          response.write('{');
        }
      }).listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Missing fixture port');
      }
      const endpoint = { url: `http://127.0.0.1:${address.port}` };
      sut.setup({
        ...defaults.machineLearning,
        availabilityChecks: { enabled: false, timeout: 250, interval: 30_000 },
      });
      try {
        expect((await sut.probe(endpoint)).reachable).toBe(false);
        expect(escaped).toBe(false);
        mode = 'stalled';
        const result = await sut.probe(endpoint);
        expect(result.workloads).toEqual([]);
        expect(result.error).not.toBeNull();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('reuses a fresh probe and re-probes once it is stale', async () => {
      const fetch = vi
        .fn()
        .mockImplementation((url: URL) =>
          Promise.resolve(url.pathname === '/ping' ? new Response('pong') : new Response('', { status: 404 })),
        );
      vi.stubGlobal('fetch', fetch);

      await sut.probe({ url: localUrl }, { maxAgeMs: 10_000 });
      await sut.probe({ url: localUrl }, { maxAgeMs: 10_000 });
      const callsAfterCached = fetch.mock.calls.length;
      await sut.probe({ url: localUrl });

      expect(callsAfterCached).toBe(3);
      expect(fetch.mock.calls.length).toBeGreaterThan(callsAfterCached);
    });
  });

  describe('getHardware', () => {
    it('asks the explicit endpoint and returns defaults when it does not answer', async () => {
      const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      vi.stubGlobal('fetch', fetch);

      const hardware = await sut.getHardware({ url: lanUrl });

      expect(String(fetch.mock.calls[0][0])).toBe(`${lanUrl}/hardware`);
      expect(hardware.preferredAcceleration).toBe(MachineLearningHardwareAcceleration.Auto);
    });
  });

  describe('restoration (FL-114)', () => {
    const original = Buffer.from('original video bytes');
    const restored = Buffer.from('restored video bytes');
    const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

    let directory: string;
    let sourcePath: string;
    let outputPath: string;
    let recordAccounting: ReturnType<typeof vi.fn>;

    const result = (overrides: Record<string, unknown> = {}) => ({
      protocol: RESTORATION_PROTOCOL,
      requestId: 'operation-1:restored.mp4',
      mode: AssetRestorationMode.Faithful,
      model: {
        id: 'realbasicvsr-x4',
        family: 'realbasicvsr',
        mode: AssetRestorationMode.Faithful,
        revision: '0123456789abcdef0123456789abcdef01234567',
        fingerprint: 'a'.repeat(64),
        weights: [{ role: 'generator', sha256: 'b'.repeat(64) }],
        qualificationId: 'realbasicvsr-x4-2026-09',
      },
      output: {
        width: 1280,
        height: 720,
        frameRate: '30/1',
        frameCount: 150,
        durationMs: 5000,
        container: 'mp4',
        codec: 'h264',
        dynamicRange: RestorationDynamicRange.Sdr,
        bitDepth: 8,
        audio: 'copied',
        bytes: restored.length,
        sha256: sha256(restored),
      },
      timing: { decodeMs: 10, runtimeMs: 1000, encodeMs: 20, totalMs: 1100, framesPerSecond: 150 },
      peakVramBytes: null,
      seed: 0,
      warnings: [],
      ...overrides,
    });

    const answer = (body: unknown, content = restored) =>
      new Response(new Uint8Array(content), {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          [RESTORATION_RESULT_HEADER]: Buffer.from(JSON.stringify(body)).toString('base64url'),
        },
      });

    /** A selection admitted the only way restore accepts: through selectRestorationDestination. */
    const admit = async (
      destination: MlDestinationRow = mlDestinationStub.lan,
      confirmed = false,
      mode: AssetRestorationMode = AssetRestorationMode.Faithful,
    ) => {
      recordAccounting = vi.fn().mockResolvedValue(undefined);
      const mlDestinationRepository = {
        assertRecoveryAuthority: vi.fn().mockResolvedValue(undefined),
        getById: vi.fn().mockResolvedValue(destination),
        getSpend: vi.fn().mockResolvedValue(0),
        recordProbe: vi.fn().mockResolvedValue(undefined),
        recordAccounting,
        getRoute: vi.fn(),
        getRoutes: vi.fn().mockResolvedValue([]),
        getCloudModelChoice: vi.fn().mockResolvedValue(null),
      } as unknown as MlDestinationRepository;
      const machineLearningRepository = {
        probe: vi
          .fn()
          .mockResolvedValue(
            destination.kind === MlDestinationKind.FrameleafCloud
              ? mlProbeStub.frameleafCloud
              : mlProbeStub.restoration,
          ),
      } as unknown as MachineLearningRepository;
      return selectRestorationDestination(
        { mlDestinationRepository, machineLearningRepository },
        { mode, destinationId: destination.id, acknowledgeCloudUpload: confirmed },
      );
    };

    const input = (): RestorationInferenceInput => ({
      kind: 'video',
      path: sourcePath,
      width: 640,
      height: 360,
      durationSeconds: 5,
    });

    const options = (overrides: Partial<RestorationInferenceOptions> = {}): RestorationInferenceOptions => ({
      mode: AssetRestorationMode.Faithful,
      upscale: 2,
      keepGrain: false,
      maxWidth: 1280,
      maxHeight: 720,
      outputPath,
      jobId: 'operation-1',
      signal: new AbortController().signal,
      ...overrides,
    });

    const restore = async (overrides: Partial<RestorationInferenceOptions> = {}, selection?: RestorationSelection) =>
      sut.restore(selection ?? (await admit()), input(), options(overrides));

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'immich-restoration-'));
      sourcePath = join(directory, 'original.mp4');
      outputPath = join(directory, 'restored.mp4');
      await writeFile(sourcePath, original);
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('writes the restored file as a new file and leaves the original untouched', async () => {
      const fetch = vi.fn().mockResolvedValue(answer(result()));
      vi.stubGlobal('fetch', fetch);

      const response = await restore();

      expect(response).toEqual({
        outputPath,
        width: 1280,
        height: 720,
        modelName: 'realbasicvsr-x4',
        modelVersion: '0123456789ab+aaaaaaaaaaaa',
      });
      expect(await readFile(outputPath)).toEqual(restored);
      expect(await readFile(sourcePath)).toEqual(original);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toBe(`${lanUrl}/restoration/restore`);
      expect(fetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer lan-token' });
      const form = fetch.mock.calls[0][1].body as FormData;
      expect(JSON.parse(String(form.get('request')))).toMatchObject({
        requestId: 'operation-1:restored.mp4',
        mode: 'faithful',
        kind: 'video',
        scale: 2,
        maxWidth: 1280,
        maxHeight: 720,
        source: { width: 640, height: 360, durationMs: 5000 },
      });
      expect(form.get('media')).toBeInstanceOf(Blob);
      expect(recordAccounting).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', bytesReceived: 20 }));
    });

    it.each(['disable', 'quarantine', 'rebind'])(
      'refuses a delayed restoration body after %s and deletes its output',
      async () => {
        const observed = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let revoked = false;
        const server = createServer((request, response) => {
          request.resume();
          request.on('end', () => {
            response.writeHead(200, {
              'content-type': 'video/mp4',
              [RESTORATION_RESULT_HEADER]: Buffer.from(JSON.stringify(result())).toString('base64url'),
            });
            response.write(restored.subarray(0, 1));
            observed.resolve();
            void release.promise.then(() => response.end(restored.subarray(1)));
          });
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected owned loopback server');
        const selection = await admit();
        selection.endpoint.url = `http://127.0.0.1:${address.port}`;
        selection.endpoint.assertAuthority = () =>
          revoked ? Promise.reject(new Error('replacement_ml_authority_unavailable')) : Promise.resolve();
        try {
          const pending = restore({}, selection);
          const assertion = expect(pending).rejects.toThrow('replacement_ml_authority');
          await observed.promise;
          revoked = true;
          release.resolve();
          await assertion;
          expect(existsSync(outputPath)).toBe(false);
          expect(await readFile(sourcePath)).toEqual(original);
          expect(recordAccounting).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
          expect(recordAccounting).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
        } finally {
          release.resolve();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );

    it('names the chosen model to the worker and refuses an answer from another one (FL-423)', async () => {
      const fetch = vi.fn().mockImplementation(() => Promise.resolve(answer(result())));
      vi.stubGlobal('fetch', fetch);

      await restore({ modelId: 'realbasicvsr-x4' });
      expect(JSON.parse(String((fetch.mock.calls[0][1].body as FormData).get('request')))).toMatchObject({
        modelId: 'realbasicvsr-x4',
      });

      // left out, the worker uses its own model for the mode
      await rm(outputPath, { force: true });
      await restore();
      expect(JSON.parse(String((fetch.mock.calls[1][1].body as FormData).get('request')))).not.toHaveProperty(
        'modelId',
      );

      await rm(outputPath, { force: true });
      await expect(restore({ modelId: 'seedvr2-3b' })).rejects.toThrow('a different request or model');
      expect(existsSync(outputPath)).toBe(false);
    });

    it('sends a still as an image request with no duration', async () => {
      const fetch = vi.fn().mockResolvedValue(answer(result()));
      vi.stubGlobal('fetch', fetch);
      const still: RestorationInferenceInput = { kind: 'image', path: sourcePath, width: 1024, height: 768 };

      await sut.restore(await admit(), still, options({ upscale: 4, maxWidth: 3840, maxHeight: 2880 }));

      const form = fetch.mock.calls[0][1].body as FormData;
      expect(JSON.parse(String(form.get('request')))).toMatchObject({
        kind: 'image',
        scale: 4,
        maxWidth: 3840,
        maxHeight: 2880,
        source: { width: 1024, height: 768, durationMs: null },
      });
    });

    it('asks a home restoration worker for Smooth motion at the chosen factor and size (FL-162)', async () => {
      const fetch = vi.fn().mockResolvedValue(
        answer(
          result({
            mode: 'smooth_motion',
            model: {
              id: 'rife-4-25',
              family: 'rife',
              mode: 'smooth_motion',
              revision: '0123456789abcdef0123456789abcdef01234567',
              fingerprint: 'a'.repeat(64),
              weights: [{ role: 'flownet', sha256: 'b'.repeat(64) }],
              qualificationId: 'rife-4-25-2026-09',
            },
          }),
        ),
      );
      vi.stubGlobal('fetch', fetch);
      const selection = await admit(
        { ...mlDestinationStub.lan, workloads: [MlWorkload.Interpolation] },
        false,
        AssetRestorationMode.SmoothMotion,
      );

      await sut.restore(
        selection,
        input(),
        options({
          mode: AssetRestorationMode.SmoothMotion,
          upscale: 1,
          interpolationFactor: 8,
          trailingContextFrame: true,
          maxWidth: 640,
          maxHeight: 360,
        }),
      );

      const form = fetch.mock.calls[0][1].body as FormData;
      expect(JSON.parse(String(form.get('request')))).toMatchObject({
        mode: 'smooth_motion',
        scale: 1,
        interpolationFactor: 8,
        trailingContextFrame: true,
      });
    });

    it('never writes over an existing file, the original included', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      await expect(restore({ outputPath: sourcePath })).rejects.toThrow('never writes over its source');
      await writeFile(outputPath, 'an earlier derivative');
      await expect(restore()).rejects.toThrow(/EEXIST/);

      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(sourcePath)).toEqual(original);
      expect(await readFile(outputPath, 'utf8')).toBe('an earlier derivative');
    });

    it('refuses a selection that did not come from selectRestorationDestination', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const plainCloud = {
        ...selection(MlDestinationKind.Lan, lanUrl, () => {}, 'lan-token'),
        workload: MlWorkload.RestorationFaithful,
      } as MlSelection as RestorationSelection;

      await expect(restore({}, plainCloud)).rejects.toThrow(/admitted by selectRestorationDestination/);
      await expect(restore({}, { ...(await admit()) })).rejects.toThrow(/admitted by selectRestorationDestination/);
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(outputPath)).toBe(false);
    });

    it('fails a Frameleaf Cloud restoration in place: worker protocol mechanics (disclosure policy mocked)', async () => {
      vi.spyOn(cloudDisclosure, 'hasPendingCloudDisclosure').mockReturnValue(false);
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      await expect(restore({}, await admit(mlDestinationStub.frameleafCloudConsented, true))).rejects.toBeInstanceOf(
        CloudJobsUnavailableError,
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(outputPath)).toBe(false);
    });

    it('refuses a selection admitted for another workload', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      await expect(restore({ mode: AssetRestorationMode.Creative })).rejects.toThrow(/needs a restoration-creative/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('reports the worker refusal by code and removes the partial file', async () => {
      const refusal = { code: 'model-unavailable', message: 'no faithful model is available' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(refusal, { status: 409 })));

      const error = await restore().catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(RestorationWorkerError);
      expect((error as RestorationWorkerError).code).toBe(RestorationWorkerErrorCode.ModelUnavailable);
      expect(existsSync(outputPath)).toBe(false);
      expect(recordAccounting).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
    });

    it('discards a file that does not match the reported hash', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(result(), Buffer.from('tampered bytes'))));

      await expect(restore()).rejects.toMatchObject({ code: 'protocol-error' });
      expect(existsSync(outputPath)).toBe(false);
    });

    it('discards an answer for another request', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(result({ requestId: 'operation-2:restored.mp4' }))));

      await expect(restore()).rejects.toMatchObject({ code: 'protocol-error' });
      expect(existsSync(outputPath)).toBe(false);
    });

    it('does not move the work elsewhere when the destination is unreachable', async () => {
      const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      vi.stubGlobal('fetch', fetch);

      await expect(restore()).rejects.toMatchObject({ code: 'unreachable' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toBe(`${lanUrl}/restoration/restore`);
      expect(existsSync(outputPath)).toBe(false);
    });

    it('reads the restoration report and drops workloads the server does not know', async () => {
      const report = {
        protocol: RESTORATION_PROTOCOL,
        workloads: ['restoration-faithful', 'restoration-teleport'],
        models: [],
        gpus: [{ name: 'GPU', memoryTotalBytes: 25_769_803_776, driverVersion: '550.0' }],
        configurationProblems: [],
        checkedAt: '2026-09-22T12:00:00.000Z',
      };
      const fetch = vi.fn().mockResolvedValue(jsonResponse(report));
      vi.stubGlobal('fetch', fetch);

      const parsed = await sut.getRestorationModels({ url: lanUrl, authToken: 'lan-token' });

      expect(String(fetch.mock.calls[0][0])).toBe(`${lanUrl}/restoration/models`);
      expect(parsed.workloads).toEqual([MlWorkload.RestorationFaithful]);
      expect(parsed.gpus[0].name).toBe('GPU');
    });

    it('says so when the destination does not run the restoration worker', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

      await expect(sut.getRestorationModels({ url: localUrl })).rejects.toThrow('does not run the restoration worker');
    });
  });

  describe('subjectMatte (FL-639)', () => {
    const stream = (lines: unknown[]) =>
      new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    const options = {
      seedKind: 'face' as const,
      seedBox: [0.4, 0.1, 0.6, 0.3] as [number, number, number, number],
      points: [{ frame: 1, x: 0.5, y: 0.5, label: 0 as const }],
      matteWidth: 192,
      matteHeight: 108,
    };

    it('sends the frames and the seed to the named home worker and reads one matte per frame', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          stream([
            { type: 'progress', done: 0, total: 2, seedBox: [1, 2, 3, 4] },
            { type: 'frame', index: 0, png: Buffer.from('a').toString('base64') },
            { type: 'progress', done: 1, total: 2 },
            { type: 'frame', index: 1, png: Buffer.from('b').toString('base64') },
            { type: 'done' },
          ]),
        );
      vi.stubGlobal('fetch', fetch);
      const frames: Array<[number, string]> = [];
      const progress = vi.fn();
      const usage = vi.fn();
      await sut.subjectMatte(
        selection(MlDestinationKind.Lan, lanUrl, usage),
        [imagePath, imagePath],
        options,
        new AbortController().signal,
        (index, png) => {
          frames.push([index, png.toString()]);
        },
        progress,
      );
      expect(String(fetch.mock.calls[0][0])).toBe(`${lanUrl}/subject-matte`);
      const form = fetch.mock.calls[0][1].body as FormData;
      expect(JSON.parse(form.get('entries') as string)).toEqual({
        'subject-matte': { visual: { modelName: 'frameleaf-florence2-sam2.1', options } },
      });
      expect(form.getAll('frames')).toHaveLength(2);
      expect(frames).toEqual([
        [0, 'a'],
        [1, 'b'],
      ]);
      expect(progress).toHaveBeenLastCalledWith(1, 2);
      expect(usage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    });

    it('says when the worker cannot cut out, could not find the subject, or stopped early', async () => {
      const run = () =>
        sut.subjectMatte(
          selection(MlDestinationKind.Local, localUrl),
          [imagePath],
          options,
          new AbortController().signal,
          vi.fn(),
          vi.fn(),
        );
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
      await expect(run()).rejects.toBeInstanceOf(CutoutUnavailableError);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(stream([{ type: 'error', message: 'No subject found in the first frame' }])),
      );
      await expect(run()).rejects.toThrow(new CutoutWorkerError('No subject found in the first frame'));
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream([{ type: 'done' }])));
      await expect(run()).rejects.toThrow('stopped before it finished');
    });

    it('never sends frames to Frameleaf Cloud', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await expect(
        sut.subjectMatte(
          {
            ...selection(MlDestinationKind.FrameleafCloud, FRAMELEAF_CLOUD_ENDPOINT.url),
            endpoint: FRAMELEAF_CLOUD_ENDPOINT,
          },
          [imagePath],
          options,
          new AbortController().signal,
          vi.fn(),
          vi.fn(),
        ),
      ).rejects.toBeInstanceOf(CloudJobsUnavailableError);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
