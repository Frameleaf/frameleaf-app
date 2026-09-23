import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from 'src/config.js';
import {
  RESTORATION_PROTOCOL,
  RESTORATION_RESULT_HEADER,
  RestorationDynamicRange,
  RestorationErrorCode,
  RestorationInferenceRequest,
  RestorationMode,
} from 'src/dtos/restoration-inference.dto.js';
import { MachineLearningHardwareAcceleration, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MachineLearningRepository,
  MlSelection,
  MlUsage,
  ModelTask,
  ModelType,
  RestorationSelection,
  RestorationWorkerError,
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

  describe('restoration (FL-114)', () => {
    const original = Buffer.from('original video bytes');
    const restored = Buffer.from('restored video bytes');
    const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

    let directory: string;
    let sourcePath: string;
    let outputPath: string;

    const request = (overrides: Partial<RestorationInferenceRequest> = {}): RestorationInferenceRequest => ({
      protocol: RESTORATION_PROTOCOL,
      requestId: 'operation-1',
      mode: RestorationMode.Faithful,
      scale: 2,
      maxLongEdge: 3840,
      seed: 0,
      source: {
        width: 640,
        height: 360,
        frameRate: '30/1',
        durationMs: 5000,
        dynamicRange: RestorationDynamicRange.Sdr,
        bitDepth: 8,
      },
      ...overrides,
    });

    const result = (overrides: Record<string, unknown> = {}) => ({
      protocol: RESTORATION_PROTOCOL,
      requestId: 'operation-1',
      mode: RestorationMode.Faithful,
      model: {
        id: 'realbasicvsr-x4',
        family: 'realbasicvsr',
        mode: RestorationMode.Faithful,
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
        videoCodec: 'h264',
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

    const restorationSelection = (record: (usage: MlUsage) => void = () => {}): RestorationSelection => ({
      ...selection(MlDestinationKind.Lan, lanUrl, record, 'lan-token'),
      workload: MlWorkload.RestorationFaithful,
      cloudUploadAcknowledged: false,
    });

    const cloudSelection = (cloudUploadAcknowledged: boolean): RestorationSelection => ({
      ...selection(MlDestinationKind.RunPod, runPodUrl, () => {}, 'rpa_test_key'),
      workload: MlWorkload.RestorationFaithful,
      cloudUploadAcknowledged,
    });

    const restore = (overrides: Partial<RestorationInferenceRequest> = {}, record?: (usage: MlUsage) => void) =>
      sut.restore(restorationSelection(record), { sourcePath, outputPath, request: request(overrides) });

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'immich-restoration-'));
      sourcePath = join(directory, 'original.mp4');
      outputPath = join(directory, 'restored.mp4');
      await writeFile(sourcePath, original);
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('writes the restored file as a new derivative and leaves the original untouched', async () => {
      const fetch = vi.fn().mockResolvedValue(answer(result()));
      vi.stubGlobal('fetch', fetch);
      const record = vi.fn();

      const response = await restore({}, record);

      expect(response.model.qualificationId).toBe('realbasicvsr-x4-2026-09');
      expect(await readFile(outputPath)).toEqual(restored);
      expect(await readFile(sourcePath)).toEqual(original);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toBe(`${lanUrl}/restoration/restore`);
      expect(fetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer lan-token' });
      const form = fetch.mock.calls[0][1].body as FormData;
      expect(JSON.parse(String(form.get('request')))).toMatchObject({ requestId: 'operation-1', mode: 'faithful' });
      expect(form.get('media')).toBeInstanceOf(Blob);
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', bytesReceived: 20 }));
    });

    it('never writes over an existing file, the original included', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const intoSource = { sourcePath, outputPath: sourcePath, request: request() };

      await expect(sut.restore(restorationSelection(), intoSource)).rejects.toThrow('never writes over its source');
      await writeFile(outputPath, 'an earlier derivative');
      await expect(restore()).rejects.toThrow(/EEXIST/);

      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(sourcePath)).toEqual(original);
      expect(await readFile(outputPath, 'utf8')).toBe('an earlier derivative');
    });

    it('never uploads to a cloud destination the person did not confirm for this request', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const input = { sourcePath, outputPath, request: request() };

      await expect(sut.restore(cloudSelection(false), input)).rejects.toThrow(/confirmation that media leaves/);
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(outputPath)).toBe(false);
    });

    it('sends a cloud destination only a segment that was cut beforehand', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const input = { sourcePath, outputPath, request: request({ segment: { startMs: 0, endMs: 5000 } }) };

      await expect(sut.restore(cloudSelection(true), input)).rejects.toThrow(/Cut the segment/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('uploads to a confirmed cloud destination', async () => {
      const fetch = vi.fn().mockResolvedValue(answer(result()));
      vi.stubGlobal('fetch', fetch);

      await sut.restore(cloudSelection(true), { sourcePath, outputPath, request: request() });

      expect(String(fetch.mock.calls[0][0])).toBe(`${runPodUrl}restoration/restore`);
      expect(await readFile(outputPath)).toEqual(restored);
    });

    it('refuses a selection admitted for another workload', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      await expect(restore({ mode: RestorationMode.Creative })).rejects.toThrow(/needs a restoration-creative/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('reports the worker refusal by code and removes the partial derivative', async () => {
      const refusal = { code: 'model-unavailable', message: 'no faithful model is available' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(refusal), { status: 409 })));
      const record = vi.fn();

      const error = await restore({}, record).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(RestorationWorkerError);
      expect((error as RestorationWorkerError).code).toBe(RestorationErrorCode.ModelUnavailable);
      expect(existsSync(outputPath)).toBe(false);
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
    });

    it('discards a file that does not match the reported hash', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(result(), Buffer.from('tampered bytes'))));

      await expect(restore()).rejects.toMatchObject({ code: 'protocol-error' });
      expect(existsSync(outputPath)).toBe(false);
    });

    it('discards an answer for another request', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(result({ requestId: 'operation-2' }))));

      await expect(restore()).rejects.toMatchObject({ code: 'protocol-error' });
      expect(existsSync(outputPath)).toBe(false);
    });

    it('discards an answer from another model than the preview used', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(result())));

      await expect(restore({ modelFingerprint: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'protocol-error' });
      expect(existsSync(outputPath)).toBe(false);
    });

    it('does not move the work elsewhere when the destination is unreachable', async () => {
      sut.setRunPodEndpoint(runPodUrl, 'rpa_test_key');
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
});
