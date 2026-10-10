import {
  HardwareBackend,
  HardwareBenchmarkSource,
  HardwareBenchmarkUnit,
  HardwareBenchmarkWorkload,
  HardwareFindingContainer,
  HardwareRunsOn,
  HardwareWorkerKind,
  HardwareWorkloadUnavailable,
  type HardwareCheckResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import HardwareSection from './HardwareSection.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('$lib/utils', async (original) => ({
  ...(await original<typeof import('$lib/utils')>()),
  copyToClipboard: vi.fn(),
}));

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

const check = (overrides: Partial<HardwareCheckResponseDto> = {}): HardwareCheckResponseDto => ({
  checkedAt: '2026-09-25T09:00:00.000Z',
  mlImage: 'cuda',
  issues: [],
  findings: [],
  workers: [],
  benchmark: null,
  server: container(),
  ml: container(),
  ...overrides,
});

describe('HardwareSection (FL-159 §3.2, prototype HardwareCheck)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks the server and ML containers separately and says what each can use', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(
      check({
        ml: container({
          vendor: 'NVIDIA',
          model: 'NVIDIA GeForce RTX 4090',
          vramGb: 24,
          driver: 'Driver 560.35 · CUDA 12.4',
          backend: HardwareBackend.Cuda,
        }),
      }),
    );
    render(HardwareSection);

    const ml = await screen.findByRole('region', { name: 'AI features' });
    expect(within(ml).getByText('NVIDIA GeForce RTX 4090')).toBeInTheDocument();
    expect(within(ml).getByText('GPU in use')).toBeInTheDocument();
    const server = screen.getByRole('region', { name: 'Video playback and export' });
    expect(within(server).getByText('Processor')).toBeInTheDocument();
    expect(screen.queryByText('What needs fixing')).not.toBeInTheDocument();
  });

  it('explains a detected problem with its compose fix, and checks again on request', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(check({ issues: ['nvidia-toolkit'] }));
    sdkMock.runHardwareCheck.mockResolvedValue(check());
    render(HardwareSection);

    expect(await screen.findByText('What needs fixing')).toBeInTheDocument();
    // The issue card's fix comes first; the common-problems list repeats every vendor's fix.
    const [copy] = screen.getAllByRole('button', { name: /Copy the docker compose fix/ });
    await fireEvent.click(copy);
    const { copyToClipboard } = await import('$lib/utils');
    expect(copyToClipboard).toHaveBeenCalledWith(expect.stringContaining('driver: nvidia'));

    await fireEvent.click(screen.getByRole('button', { name: 'Run check again' }));
    expect(sdkMock.runHardwareCheck).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Check finished.')).toBeInTheDocument();
  });

  it('runs a short benchmark and says the sliders now use the measured speed', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(check());
    sdkMock.runHardwareBenchmark.mockResolvedValue(
      check({
        benchmark: {
          ranAt: '2026-09-25T09:05:00.000Z',
          embeddingMs: 420,
          transcodeSpeed: 1.2,
          mlFactor: 1.05,
          serverFactor: 1.08,
          workloads: [],
        },
      }),
    );
    render(HardwareSection);

    await fireEvent.click(await screen.findByRole('button', { name: 'Run a short benchmark' }));
    expect(sdkMock.runHardwareBenchmark).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText('Benchmark finished. Time estimates on the model sliders now use your measured speed.'),
    ).toBeInTheDocument();
    expect(screen.getByText('420 ms')).toBeInTheDocument();
  });

  it('reports GPU on the host, visible to the container and used by the runtime as separate facts', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(
      check({
        server: container({ gpu: { present: true, visible: false, usable: false } }),
        ml: container({ reachable: false, gpu: { present: null, visible: null, usable: null } }),
      }),
    );
    render(HardwareSection);

    const server = await screen.findByRole('region', { name: 'Video playback and export' });
    const facts = (region: HTMLElement) =>
      ['present', 'visible', 'usable'].map(
        (key) => region.querySelector(`[data-fact="${CSS.escape(key)}"]`)?.textContent,
      );
    expect(within(server).getByText('GPU on the host')).toBeInTheDocument();
    expect(facts(server)).toEqual(['Yes', 'No', 'No']);
    expect(facts(screen.getByRole('region', { name: 'AI features' }))).toEqual([
      'Not reported',
      'Not reported',
      'Not reported',
    ]);
  });

  it('shows render and restoration workers from what they reported', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(
      check({
        workers: [
          {
            id: 'w1',
            name: 'Studio PC',
            kind: HardwareWorkerKind.Render,
            reachable: true,
            model: null,
            vramGb: 8,
            gpu: { present: true, visible: true, usable: true },
          },
          {
            id: 'w2',
            name: 'Workshop GPU',
            kind: HardwareWorkerKind.Restoration,
            reachable: false,
            model: null,
            vramGb: null,
            gpu: { present: null, visible: null, usable: null },
          },
        ],
      }),
    );
    render(HardwareSection);

    expect(await screen.findByText('Other GPU workers')).toBeInTheDocument();
    const studio = screen.getByRole('region', { name: 'Studio PC' });
    expect(within(studio).getByText('Studio render worker')).toBeInTheDocument();
    expect(within(studio).getAllByText('Yes')).toHaveLength(3);
    const restoration = screen.getByRole('region', { name: 'Workshop GPU' });
    expect(within(restoration).getByText('Not checked in')).toBeInTheDocument();
    expect(within(restoration).getAllByText('Not reported')).toHaveLength(3);
  });

  it('fills the fix with what the check found, and shows a card limit as a note', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(
      check({
        issues: ['render-group', 'nvidia-bf16'],
        findings: [
          {
            id: 'render-group',
            container: HardwareFindingContainer.Server,
            gid: 107,
            pciAddress: null,
            gfxVersion: null,
            computeCapability: null,
          },
          {
            id: 'nvidia-bf16',
            container: HardwareFindingContainer.Ml,
            gid: null,
            pciAddress: null,
            gfxVersion: null,
            computeCapability: '7.5',
          },
        ],
      }),
    );
    render(HardwareSection);

    expect(await screen.findByText('What needs fixing')).toBeInTheDocument();
    const [copy] = screen.getAllByRole('button', { name: 'Copy the docker compose fix for the render group' });
    await fireEvent.click(copy);
    const { copyToClipboard } = await import('$lib/utils');
    expect(copyToClipboard).toHaveBeenCalledWith(expect.stringContaining('- "107"'));
    // The Turing limit is a note, not something to fix.
    expect(screen.getAllByText(/This card has no bf16 or FlashAttention support/)[0]).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  it('lists the throughput of each kind of work, or why there is none', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(
      check({
        benchmark: {
          ranAt: '2026-09-25T09:05:00.000Z',
          embeddingMs: 30,
          transcodeSpeed: 9,
          mlFactor: 1,
          serverFactor: 1,
          workloads: [
            {
              workload: HardwareBenchmarkWorkload.Descriptions,
              source: HardwareBenchmarkSource.Benchmark,
              unit: HardwareBenchmarkUnit.Photo,
              perHour: 1500,
              secondsPerUnit: 2.4,
              runsOn: HardwareRunsOn.Gpu,
              worker: 'This server',
              unavailable: null,
              error: null,
            },
            {
              workload: HardwareBenchmarkWorkload.Upscale,
              source: null,
              unit: null,
              perHour: null,
              secondsPerUnit: null,
              runsOn: null,
              worker: null,
              unavailable: HardwareWorkloadUnavailable.NoLocalRunner,
              error: null,
            },
          ],
        },
      }),
    );
    render(HardwareSection);

    expect(
      await screen.findByText('1,500 photos an hour (2.4 s each) on the GPU. Measured now on This server.'),
    ).toBeInTheDocument();
    expect(screen.getByText("Can't run here: Frameleaf Cloud only.")).toBeInTheDocument();
  });
});
