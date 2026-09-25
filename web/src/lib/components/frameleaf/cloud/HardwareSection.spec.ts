import { HardwareBackend, type HardwareCheckResponseDto } from '@immich/sdk';
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
  ...overrides,
});

const check = (overrides: Partial<HardwareCheckResponseDto> = {}): HardwareCheckResponseDto => ({
  checkedAt: '2026-09-25T09:00:00.000Z',
  mlImage: 'cuda',
  issues: [],
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
});
