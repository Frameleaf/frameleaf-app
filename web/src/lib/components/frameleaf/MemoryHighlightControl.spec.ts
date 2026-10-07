import {
  MemoryExportFormat,
  MemoryExportStatus,
  MemoryHighlightAudio,
  MemoryHighlightDestination,
  StudioExportResolution,
  StudioExportFormat,
  type MemoryExportResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import MemoryHighlightControl from '$lib/components/frameleaf/MemoryHighlightControl.svelte';
import * as utils from '$lib/utils';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const highlight = (overrides: Partial<NonNullable<MemoryExportResponseDto['highlight']>> = {}) => ({
  lengthSeconds: 60,
  resolution: StudioExportResolution.$2160P,
  audio: MemoryHighlightAudio.Original,
  destination: MemoryHighlightDestination.Local,
  progress: 0,
  savedAssetId: null,
  ...overrides,
});

const run = (overrides: Partial<MemoryExportResponseDto> = {}): MemoryExportResponseDto => ({
  id: 'run-1',
  memoryId: 'memory-1',
  ownerId: 'me',
  title: 'Lake trip',
  format: MemoryExportFormat.Highlight,
  status: MemoryExportStatus.Running,
  assetCount: 3,
  processedAssets: 0,
  sizeInBytes: null,
  error: null,
  isDownloadable: false,
  createdAt: '2026-09-26T10:00:00.000Z',
  updatedAt: '2026-09-26T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  expiresAt: null,
  highlight: highlight(),
  ...overrides,
});

/** A qualified render worker on this server that verified 4K HEVC Main10. */
const capable = {
  workloads: [],
  studio: {
    gpuWorker: true,
    renderWorker: true,
    restorationWorker: false,
    transcriptionWorker: false,
    render: [
      {
        destination: 'local',
        sessions: 1,
        gpuMemoryBytes: 16 * 1024 ** 3,
        codecs: ['hevc_nvenc', 'h264_nvenc'],
        maxBitDepth: 10,
        hdr10: true,
        dolbyVision: false,
        candidates: [
          {
            gpuMemoryBytes: 16 * 1024 ** 3,
            outputFormats: [StudioExportFormat.Mp4HevcMain10, StudioExportFormat.Mp4H264],
            maxBitDepth: 10,
            hdr10: true,
            dolbyVision: false,
          },
        ],
      },
    ],
  },
  probedAt: '2026-09-26T10:00:00.000Z',
};

const renderControl = () =>
  render(MemoryHighlightControl, { memoryId: 'memory-1', memoryTitle: 'Lake trip', pollMs: 10 });

describe('MemoryHighlightControl (FL-194)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getMemoryExports.mockResolvedValue([]);
    sdkMock.getMlCapabilities.mockResolvedValue(capable as never);
  });

  it('asks nothing of any render until the owner chooses, then renders with their choices', async () => {
    sdkMock.createMemoryExport.mockResolvedValue(run());
    renderControl();

    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_memories_highlight' }));
    expect(sdkMock.createMemoryExport).not.toHaveBeenCalled();

    // the Studio ExportDialog's defaults: 2160p on this server; the memory's own sound; about a minute
    expect(screen.getByLabelText<HTMLSelectElement>('frameleaf_memories_highlight_length').value).toBe('60');
    expect(screen.getByLabelText<HTMLSelectElement>('frameleaf_studio_export_resolution').value).toBe('2160p');
    expect(screen.getByLabelText<HTMLSelectElement>('frameleaf_memories_highlight_audio').value).toBe('original');
    expect(screen.getByLabelText<HTMLSelectElement>('frameleaf_studio_export_destination').value).toBe('local');

    await fireEvent.change(screen.getByLabelText('frameleaf_memories_highlight_length'), { target: { value: '30' } });
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_resolution'), {
      target: { value: '1080p' },
    });
    await fireEvent.change(screen.getByLabelText('frameleaf_memories_highlight_audio'), {
      target: { value: 'silent' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'frameleaf_memories_highlight_start' })).not.toBeDisabled(),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_memories_highlight_start' }));

    expect(sdkMock.createMemoryExport).toHaveBeenCalledWith({
      id: 'memory-1',
      memoryExportCreateDto: {
        format: MemoryExportFormat.Highlight,
        highlight: {
          lengthSeconds: 30,
          resolution: StudioExportResolution.$1080P,
          audio: MemoryHighlightAudio.Silent,
          destination: MemoryHighlightDestination.Local,
        },
      },
    });
  });

  it('names why a render would be refused before anything is submitted', async () => {
    sdkMock.getMlCapabilities.mockResolvedValue({ ...capable, studio: { ...capable.studio, render: [] } } as never);
    renderControl();

    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_memories_highlight' }));

    expect(await screen.findByText('frameleaf_studio_render_refusal_no_qualified_worker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'frameleaf_memories_highlight_start' })).toBeDisabled();
  });

  it('follows a render already under way, shows its progress and can stop it', async () => {
    sdkMock.getMemoryExports.mockResolvedValue([
      run({ format: MemoryExportFormat.Archive, id: 'archive' }),
      run({ highlight: highlight({ progress: 40 }) }),
    ]);
    sdkMock.getMemoryExport.mockResolvedValue(run({ highlight: highlight({ progress: 55 }) }));
    sdkMock.cancelMemoryExport.mockResolvedValue(run({ status: MemoryExportStatus.Cancelled }));
    renderControl();

    expect(await screen.findByText('frameleaf_memories_highlight_progress')).toBeInTheDocument();
    await waitFor(() => expect(sdkMock.getMemoryExport).toHaveBeenCalledWith({ id: 'run-1' }));

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_memories_highlight_cancel' }));
    expect(sdkMock.cancelMemoryExport).toHaveBeenCalledWith({ id: 'run-1' });
    expect(await screen.findByRole('button', { name: 'frameleaf_memories_highlight_retry' })).toBeInTheDocument();
  });

  it('retries a failed render with the settings it was asked for', async () => {
    sdkMock.getMemoryExports.mockResolvedValue([
      run({
        status: MemoryExportStatus.Failed,
        error: 'GPU lost',
        highlight: highlight({ lengthSeconds: 120, resolution: StudioExportResolution.$1080P }),
      }),
    ]);
    sdkMock.createMemoryExport.mockResolvedValue(run({ id: 'run-2' }));
    renderControl();

    expect(await screen.findByText('GPU lost')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_memories_highlight_retry' }));
    expect(screen.getByLabelText<HTMLSelectElement>('frameleaf_memories_highlight_length').value).toBe('120');
    expect(screen.getByLabelText<HTMLSelectElement>('frameleaf_studio_export_resolution').value).toBe('1080p');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'frameleaf_memories_highlight_start' })).not.toBeDisabled(),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_memories_highlight_start' }));
    expect(sdkMock.createMemoryExport).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryExportCreateDto: expect.objectContaining({
          highlight: expect.objectContaining({ lengthSeconds: 120, resolution: StudioExportResolution.$1080P }),
        }),
      }),
    );
  });

  it('downloads the result, and saves it to the library only when asked', async () => {
    const ready = run({
      status: MemoryExportStatus.Ready,
      isDownloadable: true,
      highlight: highlight({ progress: 100 }),
    });
    sdkMock.getMemoryExports.mockResolvedValue([ready]);
    sdkMock.downloadMemoryExport.mockResolvedValue(new Blob(['video']));
    sdkMock.saveMemoryExportToLibrary.mockResolvedValue({
      ...ready,
      highlight: highlight({ progress: 100, savedAssetId: 'asset-saved' }),
    });
    const downloadBlob = vi.spyOn(utils, 'downloadBlob').mockImplementation(() => {});
    renderControl();

    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_memories_highlight_download' }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'Lake trip.mp4'));
    expect(sdkMock.saveMemoryExportToLibrary).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_memories_highlight_save' }));
    expect(sdkMock.saveMemoryExportToLibrary).toHaveBeenCalledWith({ id: 'run-1' });
    const open = await screen.findByRole('link', { name: 'frameleaf_memories_highlight_open_saved' });
    expect(open).toHaveAttribute('href', '/photos/asset-saved');
  });
});
