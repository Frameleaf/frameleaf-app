import { describe, expect, it } from 'vitest';
import en from '../../../../i18n/en.json';
import {
  BANDS,
  LADDER_WORKLOADS,
  PRICE_MULTIPLIER,
  bandFor,
  cloudPositions,
  composeFixes,
  estimateCost,
  fixStepKey,
  gpuClassLabelKey,
  gpuClasses,
  gpuProblems,
  gpuProfileFor,
  interpolationEstimate,
  interpolationWork,
  isCloudOffered,
  isLocalOnlyModel,
  ladderFor,
  ladderStates,
  modelLadders,
  modelLicenceNoteKey,
  modelNoteKey,
  positionById,
  positionState,
  problemExplainKey,
  quotedUnitCost,
  resolvePosition,
  startFees,
  workloadUnitKey,
  type DetectedGpu,
  type LadderWorkload,
} from './gpu-model-catalog';

/**
 * Ported from the prototype's tests/gpu-model-catalog.test.mjs (effd05ffb7). The prototype's sample
 * hardware states are fixtures here: production reads the GPU each container really reports.
 */
const gpus: Record<string, DetectedGpu | null> = {
  'cpu-only': null,
  gtx1650: { name: 'GeForce GTX 1650', vramGb: 4, backend: 'CUDA', profile: 'gtx1650_4' },
  rtx3060: { name: 'GeForce RTX 3060', vramGb: 12, backend: 'CUDA', profile: 'rtx3060_12' },
  rtx4090: { name: 'GeForce RTX 4090', vramGb: 24, backend: 'CUDA', profile: 'rtx4090_24' },
};
const bands = (workload: LadderWorkload, gpu: DetectedGpu | null, cpuProfile?: 'cpu8' | 'mac_docker') =>
  ladderFor(workload).map((item) => bandFor(item, gpu, cpuProfile));
const messages = en as Record<string, string>;

describe('gpu model catalogue (FL-159, CLD-201)', () => {
  it('runs ladders light to heavy with at most two models per size class; Studio export is local only', () => {
    const order = ['cpu', 'tiny', 'small', 'medium', 'large', 'xl'];
    for (const workload of LADDER_WORKLOADS) {
      const ladder = ladderFor(workload);
      expect(ladder.length).toBeGreaterThanOrEqual(['interpolation', 'render'].includes(workload) ? 2 : 3);
      if (workload === 'render') {
        expect(cloudPositions(workload)).toHaveLength(0);
      } else {
        expect(cloudPositions(workload).length).toBeGreaterThanOrEqual(1);
      }
      const sizes = ladder.map((item) => order.indexOf(item.sizeClass));
      expect(sizes).toEqual(sizes.toSorted((a, b) => a - b));
      for (const size of order) {
        expect(ladder.filter((item) => item.sizeClass === size).length).toBeLessThanOrEqual(2);
      }
    }
    expect(ladderFor('descriptions').at(-1)?.id).toBe('qwen3.5-122b-a10b@1');
  });

  it('bands follow the detected GPU: white on CPU, green on the GPU, blue beyond it', () => {
    expect(bands('descriptions', gpus['cpu-only'])).toEqual([
      'cpu',
      'cpu',
      'cpu',
      'cpu',
      'cpu',
      'cloud',
      'cloud',
      'cloud',
      'cloud',
      'cloud',
    ]);
    expect(bands('descriptions', gpus.gtx1650)).toEqual([
      'gpu',
      'gpu',
      'gpu',
      'gpu',
      'gpu',
      'cloud',
      'cloud',
      'cloud',
      'cloud',
      'cloud',
    ]);
    expect(bands('descriptions', gpus.rtx3060)).toEqual([
      'gpu',
      'gpu',
      'gpu',
      'gpu',
      'gpu',
      'gpu',
      'gpu',
      'cloud',
      'cloud',
      'cloud',
    ]);
    expect(bands('descriptions', gpus.rtx4090).slice(-3)).toEqual(['gpu', 'gpu', 'cloud']);
    expect(bands('restoration', gpus['cpu-only'])).toEqual(['cloud', 'cloud', 'cloud']);
    expect(bands('restoration', gpus.rtx3060)).toEqual(['gpu', 'cloud', 'cloud']);
  });

  it('matches a detected card to its research profile only by name and memory', () => {
    expect(gpuProfileFor('NVIDIA GeForce RTX 3060', 12)).toBe('rtx3060_12');
    expect(gpuProfileFor('AMD Radeon RX 7900 XTX', 24)).toBe('rx7900xtx_24');
    expect(gpuProfileFor('NVIDIA GeForce RTX 3060', 0)).toBeNull();
    expect(gpuProfileFor('NVIDIA A2000', 6)).toBeNull();
    // An unrated card is judged by memory.
    const card: DetectedGpu = { name: 'NVIDIA A2000', vramGb: 6, backend: 'CUDA', profile: null };
    expect(bandFor(positionById('realbasicvsr@1'), card)).toBe('gpu');
    expect(bandFor(positionById('seedvr2-3b@1'), card)).toBe('cloud');
  });

  it('the route disables stops with a reason: local only blocks blue, cloud only keeps hosted models', () => {
    const gpu = gpus.gtx1650;
    const local = ladderStates('descriptions', { gpu, route: 'local' });
    expect(
      local
        .filter((entry) => entry.band === 'cloud')
        .every((entry) => entry.disabled && entry.reasons[0].key === 'frameleaf_model_reason_local_only'),
    ).toBe(true);
    expect(local.filter((entry) => entry.band === 'gpu').every((entry) => !entry.disabled)).toBe(true);
    const cloud = ladderStates('descriptions', { gpu, route: 'cloud' });
    expect(cloud.every((entry) => entry.band === 'cloud' && entry.runsOn === 'cloud')).toBe(true);
    const encoders = ladderStates('render', { gpu, route: 'cloud' });
    expect(
      encoders
        .filter((entry) => entry.band !== 'cloud')
        .every((entry) => entry.disabled && entry.reasons[0].key === 'frameleaf_model_reason_cloud_only'),
    ).toBe(true);
    expect(ladderStates('descriptions', { gpu, route: 'both' }).every((entry) => !entry.disabled)).toBe(true);
    const resolved = resolvePosition('descriptions', 'qwen3.5-122b-a10b@1', { gpu, route: 'local' });
    expect(resolved?.runsOn).toBe('local');
    expect(resolved?.fallback).toBe(true);
    expect(resolvePosition('descriptions', null, { gpu: null, route: 'cloud' })?.item.id).toBe('florence2-large@1');
  });

  it('every stop carries text and an icon, never colour alone', () => {
    const gpu = gpus.gtx1650;
    const [cpu] = ladderStates('descriptions', { gpu: null });
    expect(cpu.band).toBe('cpu');
    expect(cpu.seconds).toBeGreaterThan(0);
    const green = positionState(positionById('moondream2@1')!, { gpu });
    expect(green.band).toBe('gpu');
    expect(green.seconds).toBeGreaterThan(0);
    const blue = positionState(positionById('qwen3.5-122b-a10b@1')!, { gpu });
    expect(blue.quote?.per).toBe(100);
    expect(blue.quote?.usd).toBeGreaterThan(0);
    expect(positionState(positionById('qwen3.5-4b@1')!, { gpu }).speedClass).toBe('slow');
    for (const band of Object.values(BANDS)) {
      expect(band.icon).toMatch(/^mdi/);
      expect(messages[band.labelKey]).toBeTruthy();
    }
  });

  it('estimate maths: 2× loaded rate, a start fee per worker, the hold from p90', () => {
    expect(PRICE_MULTIPLIER).toBe(2);
    for (const item of gpuClasses) {
      expect(Math.abs(item.customerUsdPerSec - item.loadedUsdPerSec * 2)).toBeLessThan(1e-7);
    }
    expect(Math.abs(gpuClasses.find((item) => item.id === 'gpu48pro')!.customerUsdPerSec - 0.001_300_35)).toBeLessThan(
      1e-7,
    );
    expect(Math.abs(gpuClasses.find((item) => item.id === 'gpu80pro')!.customerUsdPerSec - 0.003_701_61)).toBeLessThan(
      1e-7,
    );
    const item = positionById('qwen3.5-27b@1')!;
    const rate = gpuClasses.find((entry) => entry.id === item.cloud!.gpuClass)!.customerUsdPerSec;
    const estimate = estimateCost(item, 250)!;
    expect(estimate.startFee).toBe(startFees[item.cloud!.feeClass].customerUsd);
    expect(estimate.workers).toBe(1);
    expect(Math.abs(estimate.p50 - (estimate.startFee + 250 * item.cloud!.secondsPerUnit.p50 * rate))).toBeLessThan(
      1e-6,
    );
    expect(estimate.hold).toBe(Math.ceil(estimate.p90 * 100) / 100);
    expect(estimateCost(item, 1)!.p50).toBeGreaterThan(estimateCost(item, 1)!.perUnit.p50);
    expect(estimateCost(item, 0)).toBeNull();
    const video = estimateCost('seedvr2-3b@1', 1)!;
    expect(video.workers).toBe(2);
    expect(estimateCost('seedvr2-3b@1', 60)!.workers).toBe(5);
    expect(Math.abs(video.p50 - (2 * video.startFee + video.workSeconds.p50 * video.rate))).toBeLessThan(1e-6);
    for (const fee of Object.values(startFees)) {
      const cls = gpuClasses.find((entry) => entry.id === fee.gpuClass)!;
      expect(fee.customerUsd + 1e-9).toBeGreaterThanOrEqual(2 * 1.07 * (fee.coldStartP90 + 5) * cls.flexUsdPerSec);
    }
    expect(quotedUnitCost(positionById('qwen3.5-9b@1'))!.usd).toBeGreaterThan(0);
  });

  it('never offers a licence that forbids hosted use on the cloud', () => {
    for (const item of Object.values(modelLadders).flat()) {
      if (item.commercialHosted === 'no') {
        expect(cloudPositions(item.workload)).not.toContain(item);
        expect(bandFor(item, null)).not.toBe('cloud');
      }
    }
    for (const item of cloudPositions()) {
      expect(item.commercialHosted).toBe('yes');
      expect(item.licence).not.toMatch(/non-commercial|research/i);
    }
  });

  it('never offers the nllb-clip models or MusicGen-small on the cloud, whatever the offer (FL-146)', () => {
    const qwen = positionById('qwen3.5-9b@1')!;
    for (const id of [
      'nllb-clip-base-siglip__mrl@1',
      'nllb-clip-base-siglip__v1@1',
      'nllb-clip-large-siglip__mrl@1',
      'nllb-clip-large-siglip__v1@1',
      'musicgen-small@1',
      'Xenova/musicgen-small',
    ]) {
      expect(isLocalOnlyModel(id), id).toBe(true);
      const item = { ...qwen, id };
      expect(isCloudOffered(item), id).toBe(false);
      expect(bandFor(item, null)).not.toBe('cloud');
      expect(positionState(item, { gpu: null, route: 'cloud' }).runsOn).not.toBe('cloud');
    }
    expect(cloudPositions().filter((item) => isLocalOnlyModel(item.id))).toEqual([]);
    expect(isLocalOnlyModel('qwen3.5-9b@1')).toBe(false);
  });

  it('every problem points at a real fix, and the fixes are the right ones per vendor', () => {
    expect(gpuProblems.length).toBeGreaterThanOrEqual(19);
    for (const problem of gpuProblems) {
      if (problem.fix) {
        expect(composeFixes[problem.fix]).toBeTruthy();
      }
      expect(messages[problemExplainKey(problem.id)]).toBeTruthy();
    }
    for (const [id, fix] of Object.entries(composeFixes)) {
      for (let step = 1; step <= fix.steps; step++) {
        expect(messages[fixStepKey(id as keyof typeof composeFixes, step)]).toBeTruthy();
      }
    }
    expect(composeFixes.nvidia.yaml).toMatch(/reservations:\s+devices:\s+- driver: nvidia/);
    expect(composeFixes.nvidia.yaml).not.toMatch(/\/dev\/dri/);
    expect(composeFixes.intel.yaml).toMatch(/\/dev\/dri/);
    expect(composeFixes.intel.yaml).toMatch(/group_add/);
    expect(composeFixes.amd.yaml).toMatch(/\/dev\/kfd/);
    expect(JSON.stringify({ composeFixes, gpuProblems, gpuClasses, modelLadders })).not.toMatch(/runpod|immich/i);
  });

  it('has copy for every model, GPU class and unit', () => {
    for (const item of Object.values(modelLadders).flat()) {
      expect(messages[modelNoteKey(item)], item.id).toBeTruthy();
      if (item.licenceNote) {
        expect(messages[modelLicenceNoteKey(item)], item.id).toBeTruthy();
      }
    }
    for (const item of gpuClasses) {
      expect(messages[gpuClassLabelKey(item.id)]).toBeTruthy();
    }
    for (const workload of LADDER_WORKLOADS) {
      expect(messages[workloadUnitKey(workload)]).toContain('{count');
    }
  });

  it('smooth motion: RIFE white on CPU and green on a GPU, FILM blue beyond it; cloud tier is commercial-OK', () => {
    expect(bands('interpolation', gpus['cpu-only'])).toEqual(['cpu', 'cloud']);
    expect(bands('interpolation', gpus.gtx1650)).toEqual(['gpu', 'cloud']);
    expect(bands('interpolation', gpus.rtx3060)).toEqual(['gpu', 'gpu']);
    expect(bands('interpolation', null, 'mac_docker')).toEqual(['cpu', 'cpu']);
    for (const item of cloudPositions('interpolation')) {
      expect(item.licence).toMatch(/^(MIT|Apache-2\.0)$/);
    }
    expect(ladderFor('interpolation').at(-1)?.id).toBe('film@1');
  });

  it('smooth motion estimates: new frames per source minute, chunked cloud workers, ~2× size at double rate', () => {
    const work = interpolationWork({ durationSeconds: 120, sourceFps: 30, targetFps: 60 });
    expect(work).toEqual({ ratio: 2, units: 2, sizeFactor: 2 });
    expect(interpolationWork({ durationSeconds: 60, sourceFps: 25, targetFps: 50 }).sizeFactor).toBe(2);
    expect(interpolationWork({ durationSeconds: 60, sourceFps: 30, targetFps: 120 }).units).toBe(3);
    const film = positionById('film@1')!;
    const cloudJob = interpolationEstimate(film, work, { gpu: gpus.gtx1650 });
    expect(cloudJob.runsOn).toBe('cloud');
    const rate = gpuClasses.find((entry) => entry.id === film.cloud!.gpuClass)!.customerUsdPerSec;
    expect(cloudJob.cost!.workers).toBe(4);
    expect(Math.abs(cloudJob.cost!.p50 - (4 * 0.05 + 2 * 480 * rate))).toBeLessThan(1e-6);
    const local = interpolationEstimate(positionById('rife-4.25@1')!, work, { gpu: gpus.gtx1650 });
    expect(local.runsOn).toBe('gpu');
    expect(local.seconds).toBeGreaterThan(0);
    expect(local.cost).toBeNull();
  });
});
