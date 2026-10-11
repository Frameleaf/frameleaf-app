import {
  HardwareBackend,
  MediaOperationKind,
  type HardwareCheckResponseDto,
  type RenderWorkerCompatibilityResponseDto,
} from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { isAiWork, runsHere, staysHome, WORK_KINDS } from '$lib/frameleaf/work-places';

const container = (overrides: Partial<HardwareCheckResponseDto['ml']> = {}): HardwareCheckResponseDto['ml'] => ({
  reachable: true,
  vendor: null,
  model: null,
  vramGb: null,
  driver: null,
  backend: HardwareBackend.Cpu,
  test: null,
  gpu: { present: false, visible: false, usable: false },
  ...overrides,
});
const check = (overrides: Partial<HardwareCheckResponseDto> = {}) =>
  ({
    server: container(),
    ml: container(),
    issues: [],
    findings: [],
    workers: [],
    benchmark: null,
    ...overrides,
  }) as HardwareCheckResponseDto;
const card = container({
  vendor: 'NVIDIA',
  model: 'NVIDIA GeForce RTX 4090',
  vramGb: 24,
  backend: HardwareBackend.Cuda,
});

const none: RenderWorkerCompatibilityResponseDto = { qualified: [], unavailable: [] };
const connected: RenderWorkerCompatibilityResponseDto = {
  qualified: [MediaOperationKind.StudioExport, MediaOperationKind.Restoration],
  unavailable: [],
};

describe('can this run here', () => {
  it('lists the nine kinds of heavy work in the pages’ order', () => {
    expect(WORK_KINDS).toEqual([
      'search',
      'faces',
      'ocr',
      'descriptions',
      'upscale',
      'restoration',
      'studio',
      'interpolation',
      'render',
    ]);
    expect(WORK_KINDS.filter((kind) => staysHome(kind))).toEqual(['search', 'faces', 'ocr', 'render']);
    expect(WORK_KINDS.filter((kind) => !isAiWork(kind))).toEqual(['render']);
  });

  it('reads Studio export from what the server says is connected, never from the processor being there', () => {
    // The old table called this "runs on this server" whenever the hardware check found a processor.
    expect(runsHere('render', { check: check(), compatibility: none })).toBe('no');
    expect(runsHere('render', { check: check({ server: card }), compatibility: none })).toBe('no');
    expect(runsHere('render', { check: check(), compatibility: connected })).toBe('works');
    expect(runsHere('render', { check: check(), compatibility: null })).toBe('unknown');
  });

  it('claims nothing about AI features while they do not answer', () => {
    const down = check({ ml: container({ reachable: false }) });
    for (const kind of ['search', 'faces', 'ocr', 'descriptions', 'upscale', 'studio', 'interpolation'] as const) {
      expect(runsHere(kind, { check: down, compatibility: none })).toBe('unknown');
    }
    expect(runsHere('search', { check: null, compatibility: none })).toBe('unknown');
  });

  it('search, faces and text work on a processor; the heavier AI work is slow without a graphics card', () => {
    const facts = { check: check(), compatibility: none };
    expect(runsHere('search', facts)).toBe('works');
    expect(runsHere('faces', facts)).toBe('works');
    expect(runsHere('ocr', facts)).toBe('works');
    expect(runsHere('descriptions', facts)).toBe('slow');
  });

  it('a graphics card the AI service reached makes the heavier work run properly', () => {
    expect(runsHere('descriptions', { check: check({ ml: card }), compatibility: none })).toBe('works');
  });

  it('AI restoration needs a graphics card here, or a computer the server says can take it', () => {
    expect(runsHere('restoration', { check: check(), compatibility: none })).toBe('no');
    expect(runsHere('restoration', { check: check(), compatibility: connected })).toBe('works');
    expect(
      runsHere('restoration', { check: check({ ml: container({ reachable: false }) }), compatibility: connected }),
    ).toBe('works');
  });
});
