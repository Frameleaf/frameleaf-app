import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from 'src/config.js';
import { MachineLearningHardwareAcceleration, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MachineLearningRepository,
  MlSelection,
  MlUsage,
  ModelTask,
  ModelType,
} from 'src/repositories/machine-learning.repository.js';

const qwenModelName = 'Qwen/Qwen2.5-VL-3B-Instruct';
const florenceModelName = 'microsoft/Florence-2-base-ft';

const localUrl = 'http://immich-machine-learning:3003';
const lanUrl = 'http://workshop.lan:3003';
const runPodUrl = 'https://endpoint.api.runpod.ai/';

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

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
    imagePath = join(tmpdir(), `immich-machine-learning-${randomUUID()}.webp`);
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
    await rm(imagePath, { force: true });
  });

  describe('predict', () => {
    it('sends the request to the selected endpoint only and never to another URL when it fails', async () => {
      sut.setRunPodEndpoint(runPodUrl, 'rpa_test_key');
      const fetch = vi.fn().mockResolvedValue(new Response('error', { status: 500, statusText: 'Internal Error' }));
      vi.stubGlobal('fetch', fetch);

      await expect(
        sut.encodeImage(selection(MlDestinationKind.Lan, lanUrl), imagePath, { ...defaults.machineLearning.clip }),
      ).rejects.toThrow(/lan destination destination-lan failed with status 500/);

      // One call, to the LAN worker; the published RunPod endpoint and the local URL are untouched.
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toBe(`${lanUrl}/predict`);
    });

    it('does not fall through to the local URL when the RunPod destination is down', async () => {
      const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      vi.stubGlobal('fetch', fetch);

      await expect(
        sut.encodeImage(selection(MlDestinationKind.RunPod, runPodUrl, () => {}, 'rpa_test_key'), imagePath, {
          ...defaults.machineLearning.clip,
        }),
      ).rejects.toThrow(/runpod destination destination-runpod failed: fetch failed/);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toBe(`${runPodUrl}predict`);
    });

    it('sends the bearer token of the selected endpoint', async () => {
      const fetch = vi.fn().mockResolvedValue(jsonResponse({ [ModelTask.SEARCH]: '[1,2,3]', imageHeight: 1, imageWidth: 1 }));
      vi.stubGlobal('fetch', fetch);

      await sut.encodeImage(selection(MlDestinationKind.Lan, lanUrl, () => {}, 'lan-token'), imagePath, {
        ...defaults.machineLearning.clip,
      });

      expect(fetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer lan-token' });
    });

    it('records usage once per request with bytes sent, bytes received and the outcome', async () => {
      const fetch = vi.fn().mockResolvedValue(jsonResponse({ [ModelTask.SEARCH]: '[1,2,3]', imageHeight: 1, imageWidth: 1 }));
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
    it('does not retry the Florence fallback model unless CUDA acceleration is selected', async () => {
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

    it('never retries the fallback model on a RunPod destination', async () => {
      const fetch = vi.fn().mockResolvedValue(new Response('error', { status: 500, statusText: 'Internal Error' }));
      vi.stubGlobal('fetch', fetch);

      await expect(
        sut.describeImage(selection(MlDestinationKind.RunPod, runPodUrl, () => {}, 'rpa_test_key'), imagePath, {
          modelName: qwenModelName,
          fallbackModelName: florenceModelName,
          acceleration: MachineLearningHardwareAcceleration.Cuda,
          device: 'AUTO',
        }),
      ).rejects.toThrow('Machine learning request');

      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('probe', () => {
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

    it('credits a legacy predict container without a capabilities route with the library workloads only', async () => {
      const fetch = vi.fn().mockImplementation((url: URL) =>
        Promise.resolve(url.pathname === '/ping' ? new Response('pong') : new Response('', { status: 404 })),
      );
      vi.stubGlobal('fetch', fetch);

      const probe = await sut.probe({ url: localUrl });

      expect(probe.workloads).toEqual([MlWorkload.Face, MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Enrichment]);
      expect(probe.workloads).not.toContain(MlWorkload.RestorationFaithful);
      expect(probe.workloads).not.toContain(MlWorkload.StudioAi);
    });

    it('reuses a fresh probe and re-probes once it is stale', async () => {
      const fetch = vi.fn().mockImplementation((url: URL) =>
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

  describe('RunPod endpoint publication', () => {
    it('exposes the published endpoint for explicit selection and nothing else', () => {
      expect(sut.getRunPodEndpoint()).toBeNull();
      sut.setRunPodEndpoint(runPodUrl, 'rpa_test_key');
      expect(sut.getRunPodEndpoint()).toEqual({ url: runPodUrl, authToken: 'rpa_test_key' });
      expect(sut.getLocalUrls()).toEqual([localUrl]);
      sut.clearRunPodEndpoint();
      expect(sut.getRunPodEndpoint()).toBeNull();
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
});
