import {
  HardwareBackend,
  HardwareBenchmarkSource,
  HardwareBenchmarkUnit,
  HardwareBenchmarkWorkload,
  HardwareFindingContainer,
  HardwareRunsOn,
  HardwareWorkerKind,
  HardwareWorkloadUnavailable,
  Kind,
  MediaOperationKind,
  type HardwareCheckResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import HardwareSection from './HardwareSection.svelte';

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

const card = container({
  vendor: 'NVIDIA',
  model: 'NVIDIA GeForce RTX 4090',
  vramGb: 24,
  driver: 'Driver 560.35 · CUDA 12.4',
  backend: HardwareBackend.Cuda,
  gpu: { present: true, visible: true, usable: true },
});

const status = () => within(screen.getByRole('region', { name: 'Graphics card status' }));
/** One row of "What this server can do": its outcome and the sentence under it. */
const can = (name: string) => {
  const row = screen.getByText(name, { selector: '.kit-row *' }).closest('.kit-row') as HTMLElement;
  return row.textContent?.replaceAll(/\s+/g, ' ').trim();
};

describe('Graphics card check (FL-364)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getRenderWorkerCompatibility.mockResolvedValue({ qualified: [], unavailable: [] });
  });

  it('opens on the answer: no graphics card, with video and AI features each given a status', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(
      check({ server: container({ test: { kind: Kind.Transcode, ok: true, gpu: false, value: 3.4, error: null } }) }),
    );
    render(HardwareSection);

    expect(await screen.findByRole('heading', { name: 'No graphics card found' })).toBeInTheDocument();
    expect(status().getByText('Converts a video 3.4 times faster than it plays')).toBeInTheDocument();
    expect(status().getAllByText('On the processor')).toHaveLength(2);
    expect(status().getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(screen.queryByText('How to fix it')).not.toBeInTheDocument();
    // The fact grids are kept, closed.
    expect(screen.getByText('Technical details').closest('details')).not.toHaveAttribute('open');
  });

  it('says the graphics card is working and names it', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(check({ ml: card }));
    render(HardwareSection);

    expect(await screen.findByRole('heading', { name: 'Your graphics card is working' })).toBeInTheDocument();
    expect(
      status().getByText(/NVIDIA GeForce RTX 4090 is speeding up AI features\. Video uses the processor\./),
    ).toBeInTheDocument();
    expect(can('Visual search')).toContain('Works here');
    expect(can('Descriptions & tags')).toContain('Works here');
    // Model names are an answer for whoever looks after the server, not the first thing read.
    const technical = screen.getByText('Technical details').closest('details')!;
    expect(within(technical).getAllByText('NVIDIA GeForce RTX 4090').length).toBeGreaterThan(0);
    expect(within(technical).getByText('AI models this server can run')).toBeInTheDocument();
  });

  it('counts AI features that do not answer as needing attention, and promises nothing about them', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(
      check({
        server: container({ test: { kind: Kind.Transcode, ok: true, gpu: false, value: 3.4, error: null } }),
        ml: container({ reachable: false, gpu: { present: null, visible: null, usable: null } }),
      }),
    );
    sdkMock.runHardwareCheck.mockResolvedValue(check({ ml: container({ reachable: false }) }));
    render(HardwareSection);

    expect(await screen.findByRole('heading', { name: 'AI features are not running' })).toBeInTheDocument();
    expect(status().getByText(/isn’t answering, so it couldn’t be checked\. Video is working\./)).toBeInTheDocument();
    expect(status().getByText('Not answering')).toBeInTheDocument();
    expect(status().getByRole('link', { name: 'Turn on AI features' })).toHaveAttribute(
      'href',
      expect.stringContaining('area=intelligence'),
    );
    for (const name of ['Visual search', 'Descriptions & tags', 'Transcripts & captions']) {
      expect(can(name)).toBe(`${name} Can’t tell until AI features answer. Can’t tell yet`);
    }
    // Studio export is the video side's, and the server says nothing connected can do it.
    expect(can('Studio export')).toContain('Can’t run here');

    await fireEvent.click(status().getByRole('button', { name: 'Try again' }));
    expect(sdkMock.runHardwareCheck).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Checked again. AI features still aren’t answering.')).toBeInTheDocument();
  });

  it('reads Studio export from what the server says is connected, not from the processor', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(check());
    sdkMock.getRenderWorkerCompatibility.mockResolvedValue({
      qualified: [MediaOperationKind.StudioExport],
      unavailable: [],
    });
    render(HardwareSection);

    await screen.findByRole('heading', { name: 'No graphics card found' });
    expect(can('Studio export')).toContain('Works here');
    expect(can('Studio export')).toContain('A computer with a graphics card is connected for Studio exports.');
  });

  it('says it can’t tell about Studio export when that answer could not be read', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(check());
    sdkMock.getRenderWorkerCompatibility.mockRejectedValue(new Error('down'));
    render(HardwareSection);

    await screen.findByRole('heading', { name: 'No graphics card found' });
    expect(can('Studio export')).toContain('Can’t tell yet');
  });

  it('explains a detected problem with its fix closed, and checks again on request', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(
      check({
        issues: ['nvidia-toolkit'],
        findings: [
          {
            id: 'nvidia-toolkit',
            container: HardwareFindingContainer.Ml,
            gid: null,
            pciAddress: null,
            gfxVersion: null,
            computeCapability: null,
          },
        ],
      }),
    );
    sdkMock.runHardwareCheck.mockResolvedValue(check());
    render(HardwareSection);

    expect(await screen.findByRole('heading', { name: 'Your graphics card isn’t being used' })).toBeInTheDocument();
    expect(status().getByText('Graphics card not reached')).toBeInTheDocument();
    const fix = screen.getByText('Show the fix for NVIDIA').closest('details')!;
    expect(fix).not.toHaveAttribute('open');
    await fireEvent.click(within(fix).getByRole('button', { name: 'Copy the fix for NVIDIA' }));
    const { copyToClipboard } = await import('$lib/utils');
    expect(copyToClipboard).toHaveBeenCalledWith(expect.stringContaining('driver: nvidia'));

    await fireEvent.click(status().getByRole('button', { name: 'Check again' }));
    expect(sdkMock.runHardwareCheck).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Check finished.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No graphics card found' })).toBeInTheDocument();
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

    const section = within(await screen.findByRole('region', { name: 'How to fix it' }));
    await fireEvent.click(section.getByRole('button', { name: /^Copy the fix for/ }));
    const { copyToClipboard } = await import('$lib/utils');
    expect(copyToClipboard).toHaveBeenCalledWith(expect.stringContaining('- "107"'));
    // The Turing limit is a note, not something to fix; only the video side is "not reached".
    expect(
      screen.getByText(/This card has no bf16 or FlashAttention support/, { selector: 'p.hint' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'How to fix it' })).not.toHaveTextContent(/bf16/);
    expect(status().getAllByText('Graphics card not reached')).toHaveLength(1);
  });

  it('measures this server’s speed and then says speeds in everyday units', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(check());
    sdkMock.runHardwareBenchmark.mockResolvedValue(
      check({
        benchmark: {
          ranAt: '2026-09-25T09:05:00.000Z',
          embeddingMs: 420,
          transcodeSpeed: 1.2,
          mlFactor: 1.05,
          serverFactor: 1.08,
          workloads: [
            {
              workload: HardwareBenchmarkWorkload.Descriptions,
              source: HardwareBenchmarkSource.Benchmark,
              unit: HardwareBenchmarkUnit.Photo,
              perHour: 42,
              secondsPerUnit: 85.7,
              runsOn: HardwareRunsOn.Cpu,
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

    await fireEvent.click(await screen.findByRole('button', { name: 'Run the test' }));
    expect(sdkMock.runHardwareBenchmark).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText('Measured. The speeds on this page now come from your own server.'),
    ).toBeInTheDocument();
    expect(status().getByText('About 42 descriptions an hour')).toBeInTheDocument();
    expect(status().getByText('Converts a video 1.2 times faster than it plays')).toBeInTheDocument();
    expect(can('Descriptions & tags')).toContain('About 42 photos an hour.');
    // The exact figures, and why a kind of work has none, stay under Technical details.
    const technical = within(screen.getByText('Technical details').closest('details')!);
    expect(technical.getByText('420 ms')).toBeInTheDocument();
    expect(technical.getByText("Can't run here: Frameleaf Cloud only.")).toBeInTheDocument();
  });

  it('lists the graphics cards other computers reported', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(
      check({
        workers: [
          {
            id: 'w1',
            name: 'Studio PC',
            kind: HardwareWorkerKind.Render,
            reachable: true,
            model: 'GeForce RTX 3060',
            vramGb: 12,
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

    const others = within(await screen.findByRole('region', { name: 'Other computers' }));
    const [studio, workshop] = others.getAllByRole('listitem');
    expect(within(studio).getByText('Studio PC')).toBeInTheDocument();
    expect(within(studio).getByText('Helps with Studio')).toBeInTheDocument();
    expect(within(studio).getByText('Connected')).toBeInTheDocument();
    expect(within(studio).getByText('GeForce RTX 3060 · 12 GB')).toBeInTheDocument();
    expect(within(workshop).getByText('Helps with AI restoration')).toBeInTheDocument();
    expect(within(workshop).getByText('Not answering')).toBeInTheDocument();
  });

  it('keeps the two fact grids under Technical details, each fact on its own', async () => {
    sdkMock.getHardwareCheck.mockResolvedValue(
      check({ server: container({ gpu: { present: true, visible: false, usable: false } }), ml: card }),
    );
    render(HardwareSection);

    await screen.findByRole('heading', { name: 'Your graphics card is working' });
    const technical = within(screen.getByText('Technical details').closest('details')!);
    expect(technical.getByText('Video: the server container')).toBeInTheDocument();
    expect(technical.getByText('AI features: the machine-learning container')).toBeInTheDocument();
    expect(technical.getAllByText('On the computer')).toHaveLength(2);
    expect(technical.getAllByText('Visible to Frameleaf')).toHaveLength(2);
    expect(technical.getByText('Driver 560.35 · CUDA 12.4')).toBeInTheDocument();
  });

  it('says so when the check cannot be read, and tries again', async () => {
    sdkMock.getHardwareCheck.mockRejectedValueOnce(new Error('down')).mockResolvedValue(check());
    render(HardwareSection);

    expect(await screen.findByText('The graphics card check couldn’t be read from the server.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByRole('heading', { name: 'No graphics card found' })).toBeInTheDocument();
  });
});
