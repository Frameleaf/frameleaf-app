import {
  MediaOperationDestination,
  MlDestinationKind,
  MlWorkload,
  StudioExportColor,
  StudioExportFormat,
  StudioExportResolution,
  StudioExportQuality,
  StudioExportShape,
  StudioExportSubtitleMode,
  StudioReframeShotType,
  StudioReframeSubject,
  getMlCapabilities,
  getStudioFraming,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import MemoryHighlightDialog from '$lib/components/frameleaf/MemoryHighlightDialog.svelte';
import StudioExportDialog from '$lib/components/frameleaf/StudioExportDialog.svelte';
import type { StudioRenderEvidence } from '$lib/frameleaf/studio/host-contract';

vi.mock('@frameleaf/sdk', async () => ({
  ...(await vi.importActual<typeof import('@frameleaf/sdk')>('@frameleaf/sdk')),
  getMlCapabilities: vi.fn(),
  getStudioFraming: vi.fn(),
}));

/** The Studio video export dialog (FL-88 header, `Studio.jsx` ExportDialog). */
describe('Studio export dialog', () => {
  const exportButton = () => screen.getByRole('button', { name: 'frameleaf_studio_export_start' });

  const evidence = (overrides: Partial<StudioRenderEvidence> = {}): StudioRenderEvidence => {
    const row = {
      destination: MediaOperationDestination.Local,
      sessions: 1,
      gpuMemoryBytes: 16 * 1024 ** 3,
      codecs: ['hevc_nvenc', 'h264_nvenc'],
      maxBitDepth: 10,
      hdr10: true,
      dolbyVision: false,
      ...overrides,
    };
    return {
      ...row,
      candidates: [
        {
          gpuMemoryBytes: row.gpuMemoryBytes,
          outputFormats: [StudioExportFormat.Mp4HevcMain10, StudioExportFormat.Mp4H264],
          maxBitDepth: row.maxBitDepth,
          hdr10: row.hdr10,
          dolbyVision: row.dolbyVision,
        },
      ],
      ...overrides,
    };
  };

  it.each([
    { outputIntent: 'sdr' as const, hdrEnabled: true },
    { outputIntent: 'hdr' as const, hdrEnabled: false },
  ])('keeps HDR still choices unavailable without document intent and the server gate: %j', (props) => {
    const row = evidence();
    row.candidates![0].outputFormats.push(StudioExportFormat.HdrJpeg, StudioExportFormat.HdrHeic);
    render(StudioExportDialog, {
      open: true,
      sequenceName: 'Lake trip',
      ...props,
      renderEvidence: [row],
      onExport: vi.fn(),
    });
    expect(screen.getByRole('option', { name: 'frameleaf_studio_export_format_hdr_jpeg' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'frameleaf_studio_export_format_hdr_heic' })).toBeDisabled();
  });

  it.each([StudioExportFormat.SdrJpeg, StudioExportFormat.HdrJpeg, StudioExportFormat.HdrHeic])(
    'exports %s as one still without video or motion settings',
    async (format) => {
      const onExport = vi.fn();
      const row = evidence();
      row.candidates![0].outputFormats.push(format);
      render(StudioExportDialog, {
        open: true,
        sequenceName: 'Lake trip',
        outputIntent: 'hdr',
        hdrEnabled: true,
        renderEvidence: [row],
        onExport,
      });
      await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_format'), { target: { value: format } });
      expect(screen.getByLabelText('frameleaf_studio_export_resolution')).toHaveValue(StudioExportResolution.Original);
      expect(screen.queryByTestId('studio-export-smooth-motion')).not.toBeInTheDocument();
      await fireEvent.click(exportButton());
      expect(onExport).toHaveBeenCalledWith(
        expect.objectContaining({
          format,
          resolution: StudioExportResolution.Original,
          color: StudioExportColor.Preserve,
          quality: StudioExportQuality.High,
        }),
      );
      const choice = onExport.mock.calls[0][0];
      expect(choice).not.toHaveProperty('subtitleMode');
      expect(choice).not.toHaveProperty('smoothMotion');
      expect(choice).not.toHaveProperty('mastering');
    },
  );

  it("starts from the prototype's defaults and renders on the network", async () => {
    const onExport = vi.fn();
    render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', renderEvidence: [evidence()], onExport });

    expect(screen.getByText('frameleaf_studio_export_on_network')).toBeInTheDocument();
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledWith({
      format: StudioExportFormat.Mp4HevcMain10,
      color: StudioExportColor.Preserve,
      resolution: StudioExportResolution.$2160P,
      quality: StudioExportQuality.High,
      subtitleMode: StudioExportSubtitleMode.Burn,
      destination: MediaOperationDestination.Local,
    });
  });

  it('lists video formats first, keeps stills in their own group, and never offers a video its "original" size', () => {
    render(StudioExportDialog, {
      open: true,
      sequenceName: 'Lake trip',
      renderEvidence: [evidence()],
      onExport: vi.fn(),
    });

    const format = screen.getByLabelText('frameleaf_studio_export_format');
    const groups = within(format).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('label'))).toEqual([
      'frameleaf_studio_export_video_group',
      'frameleaf_studio_export_more_video_group',
      'frameleaf_studio_export_audio_group',
      'frameleaf_studio_export_stills_group',
    ]);
    expect(within(groups[0]).getAllByRole('option')[0]).toHaveValue(StudioExportFormat.Mp4HevcMain10);
    // FL-105: every other container and codec, and the sound alone; each unverified one says why.
    expect(within(groups[1]).getAllByRole('option')).toHaveLength(13);
    expect(within(groups[2]).getAllByRole('option')).toHaveLength(3);
    expect(within(groups[3]).getAllByRole('option')).toHaveLength(3);
    const mkv = within(groups[1]).getByRole('option', { name: 'frameleaf_studio_export_format_mkv_vp9' });
    expect(mkv).toBeDisabled();
    expect(mkv).toHaveAttribute('title', 'frameleaf_studio_render_refusal_codec_unavailable');

    const sizes = within(screen.getByLabelText('frameleaf_studio_export_resolution')).getAllByRole('option');
    expect(sizes.map((option) => (option as HTMLOptionElement).value)).not.toContain(StudioExportResolution.Original);
    expect(screen.getByTestId('studio-export-summary')).toHaveTextContent('frameleaf_studio_export_summary');
  });

  it('exports sound alone without picture settings or captions (FL-105)', async () => {
    const onExport = vi.fn();
    const row = evidence();
    row.candidates![0].outputFormats = [...row.candidates![0].outputFormats, StudioExportFormat.AudioWav];
    render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', renderEvidence: [row], onExport });
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_format'), {
      target: { value: StudioExportFormat.AudioWav },
    });
    expect(screen.getByLabelText('frameleaf_studio_export_resolution')).toBeDisabled();
    expect(screen.queryByLabelText('frameleaf_studio_export_subtitles')).toBeNull();
    expect(screen.queryByTestId('studio-export-smooth-motion')).toBeNull();
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledWith(
      expect.objectContaining({ format: StudioExportFormat.AudioWav, color: StudioExportColor.Preserve }),
    );
    expect(onExport.mock.calls[0][0]).not.toHaveProperty('subtitleMode');
  });

  it('starts from a preset, leaves unsupported ones disabled, and keeps the rare choices under Advanced', async () => {
    const onExport = vi.fn();
    const { container } = render(StudioExportDialog, {
      open: true,
      sequenceName: 'Lake trip',
      renderEvidence: [evidence()],
      onExport,
    });

    const advanced = container.querySelector('details.advanced') as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    expect(advanced).toContainElement(screen.getByLabelText('frameleaf_studio_export_color'));
    expect(advanced).toContainElement(screen.getByLabelText('frameleaf_studio_export_range'));
    expect(advanced).not.toContainElement(screen.getByLabelText('frameleaf_studio_export_format'));

    // The defaults are the Best quality preset; no worker here has a ProRes encoder for Archive.
    expect(screen.getByRole('radio', { name: 'frameleaf_studio_export_preset_best' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'frameleaf_studio_export_preset_archive' })).toBeDisabled();

    await fireEvent.click(screen.getByRole('radio', { name: 'frameleaf_studio_export_preset_share' }));
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledWith(
      expect.objectContaining({
        format: StudioExportFormat.Mp4H264,
        resolution: StudioExportResolution.$1080P,
        quality: StudioExportQuality.High,
      }),
    );

    // A partial range that cannot be exported opens Advanced, so the reason is never folded away.
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_range'), { target: { value: 'frames' } });
    await fireEvent.input(screen.getByLabelText('frameleaf_studio_export_range_end'), { target: { value: '0' } });
    await waitFor(() => expect(advanced.open).toBe(true));
    expect(screen.getByText('frameleaf_studio_export_range_invalid')).toBeInTheDocument();
  });

  it.each([StudioExportColor.Hdr10, StudioExportColor.Preserve])(
    'requires chosen display limits for %s PQ export (FL-107)',
    async (color) => {
      const onExport = vi.fn();
      const dialog = render(StudioExportDialog, {
        open: true,
        sequenceName: 'Lake trip',
        renderEvidence: [evidence()],
        onExport,
      });
      await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_color'), { target: { value: color } });
      if (color === StudioExportColor.Preserve) {
        await fireEvent.click(screen.getByLabelText('frameleaf_studio_export_mastering_preserve'));
      }
      expect(exportButton()).toBeDisabled();
      const max = screen.getByLabelText('frameleaf_studio_export_mastering_max');
      const min = screen.getByLabelText('frameleaf_studio_export_mastering_min');
      expect(max).toHaveValue(null);
      expect(min).toHaveValue(null);
      for (const [high, low] of [
        ['1000', '1000'],
        ['10001', '0'],
        ['1000', '-1'],
        ['1000', '0.00001'],
        ['1000.00001', '0'],
        ['', '0'],
      ]) {
        await fireEvent.input(max, { target: { value: high } });
        await fireEvent.input(min, { target: { value: low } });
        expect(exportButton()).toBeDisabled();
        await fireEvent.click(exportButton());
        expect(onExport).not.toHaveBeenCalled();
      }
      await fireEvent.input(max, { target: { value: '4000' } });
      await fireEvent.input(min, { target: { value: '0.005' } });
      await fireEvent.click(exportButton());
      expect(onExport).toHaveBeenLastCalledWith(
        expect.objectContaining({ mastering: { primaries: 'bt2020', maxNits: 4000, minNits: 0.005 } }),
      );
      await fireEvent.input(min, { target: { value: '0.0011' } });
      expect(exportButton()).toBeEnabled();
      await dialog.rerender({ renderEvidence: [] });
      expect(exportButton()).toBeDisabled();
      await dialog.rerender({ renderEvidence: [evidence()] });
      if (color === StudioExportColor.Preserve) {
        await fireEvent.click(screen.getByLabelText('frameleaf_studio_export_mastering_preserve'));
        await fireEvent.click(exportButton());
        expect(onExport.mock.calls.at(-1)![0]).not.toHaveProperty('mastering');
      }
      await dialog.rerender({ open: false });
      await dialog.rerender({ open: true });
      await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_color'), {
        target: { value: StudioExportColor.Hdr10 },
      });
      expect(screen.getByLabelText('frameleaf_studio_export_mastering_max')).toHaveValue(null);
      expect(exportButton()).toBeDisabled();
    },
  );

  it('submits each chosen quality preset', async () => {
    const onExport = vi.fn();
    render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', renderEvidence: [evidence()], onExport });
    const control = screen.getByLabelText('frameleaf_studio_export_quality');
    for (const quality of Object.values(StudioExportQuality)) {
      await fireEvent.change(control, { target: { value: quality } });
      await fireEvent.click(exportButton());
      expect(onExport).toHaveBeenLastCalledWith(expect.objectContaining({ quality }));
    }
  });

  it('preserves Burn-in and Off choices and refuses Sidecar and Embedded without paired writer evidence', async () => {
    const onExport = vi.fn();
    render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', renderEvidence: [evidence()], onExport });
    const control = screen.getByLabelText('frameleaf_studio_export_subtitles');
    expect(
      within(control)
        .getAllByRole('option')
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual([
      StudioExportSubtitleMode.Burn,
      StudioExportSubtitleMode.Off,
      StudioExportSubtitleMode.Embedded,
      StudioExportSubtitleMode.Sidecar,
    ]);
    expect(within(control).getByRole('option', { name: 'frameleaf_studio_export_subtitles_sidecar' })).toBeDisabled();
    expect(within(control).getByRole('option', { name: 'frameleaf_studio_export_subtitles_embedded' })).toBeDisabled();
    for (const subtitleMode of [StudioExportSubtitleMode.Burn, StudioExportSubtitleMode.Off]) {
      await fireEvent.change(control, { target: { value: subtitleMode } });
      await fireEvent.click(exportButton());
      expect(onExport).toHaveBeenLastCalledWith(expect.objectContaining({ subtitleMode }));
    }
  });

  it('requires Embedded paired writer proof on the same candidate and refuses withdrawal before submission', async () => {
    const onExport = vi.fn();
    const row = evidence();
    row.candidates = [
      ...row.candidates!,
      {
        ...row.candidates![0],
        outputFormats: [],
        embeddedOutputFormats: [StudioExportFormat.Mp4H264],
      },
    ];
    const view = render(StudioExportDialog, {
      open: true,
      sequenceName: 'Explicit embedded choice',
      renderEvidence: [row],
      onExport,
    });
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_format'), {
      target: { value: StudioExportFormat.Mp4H264 },
    });
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_resolution'), {
      target: { value: StudioExportResolution.$720P },
    });
    const control = screen.getByLabelText('frameleaf_studio_export_subtitles');
    expect(within(control).getByRole('option', { name: 'frameleaf_studio_export_subtitles_embedded' })).toBeDisabled();
    await fireEvent.change(control, { target: { value: StudioExportSubtitleMode.Embedded } });
    expect(exportButton()).toBeDisabled();
    await fireEvent.click(exportButton());
    expect(onExport).not.toHaveBeenCalled();
    const paired = evidence();
    paired.candidates![0].embeddedOutputFormats = [StudioExportFormat.Mp4H264];
    await view.rerender({ renderEvidence: [paired] });
    expect(within(control).getByRole('option', { name: 'frameleaf_studio_export_subtitles_embedded' })).toBeEnabled();
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenLastCalledWith(
      expect.objectContaining({ subtitleMode: StudioExportSubtitleMode.Embedded }),
    );
    await view.rerender({ renderEvidence: [row] });
    expect(exportButton()).toBeDisabled();
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('submits Sidecar only with the exact paired writer tuple and disables it on profile withdrawal', async () => {
    const onExport = vi.fn();
    const row = evidence();
    row.candidates![0].sidecarOutputFormats = [StudioExportFormat.Mp4H264];
    const view = render(StudioExportDialog, {
      open: true,
      sequenceName: 'Actual paired choice',
      renderEvidence: [row],
      onExport,
    });
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_format'), {
      target: { value: StudioExportFormat.Mp4H264 },
    });
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_resolution'), {
      target: { value: StudioExportResolution.$720P },
    });
    const subtitles = screen.getByLabelText('frameleaf_studio_export_subtitles');
    expect(within(subtitles).getByRole('option', { name: 'frameleaf_studio_export_subtitles_sidecar' })).toBeEnabled();
    await fireEvent.change(subtitles, { target: { value: StudioExportSubtitleMode.Sidecar } });
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: MediaOperationDestination.Local,
        format: StudioExportFormat.Mp4H264,
        color: StudioExportColor.Preserve,
        resolution: StudioExportResolution.$720P,
        quality: StudioExportQuality.High,
        subtitleMode: StudioExportSubtitleMode.Sidecar,
      }),
    );
    expect(onExport.mock.calls[0][0]).not.toHaveProperty('subtitleSeal');
    await view.rerender({ renderEvidence: [evidence()] });
    expect(exportButton()).toBeDisabled();
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('submits included/excluded integer frame boundaries and refuses invalid ranges', async () => {
    const onExport = vi.fn();
    render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', renderEvidence: [evidence()], onExport });
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_range'), { target: { value: 'frames' } });
    const start = screen.getByLabelText('frameleaf_studio_export_range_start');
    const end = screen.getByLabelText('frameleaf_studio_export_range_end');
    await fireEvent.input(start, { target: { value: '4' } });
    await fireEvent.input(end, { target: { value: '4' } });
    expect(exportButton()).toBeDisabled();
    await fireEvent.input(end, { target: { value: '12' } });
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenLastCalledWith(expect.objectContaining({ range: { inPoint: 4, outPoint: 12 } }));
    await fireEvent.input(start, { target: { value: '4.5' } });
    expect(exportButton()).toBeDisabled();
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_range'), { target: { value: 'all' } });
    await fireEvent.click(exportButton());
    expect(onExport.mock.calls.at(-1)![0]).not.toHaveProperty('range');
  });

  it('exports the still at any start frame, with no end to set', async () => {
    const onExport = vi.fn();
    const row = evidence();
    row.candidates![0].outputFormats.push(StudioExportFormat.SdrJpeg);
    render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', renderEvidence: [row], onExport });
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_format'), {
      target: { value: StudioExportFormat.SdrJpeg },
    });
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_range'), { target: { value: 'frames' } });
    expect(screen.queryByLabelText('frameleaf_studio_export_range_end')).toBeNull();
    await fireEvent.input(screen.getByLabelText('frameleaf_studio_export_range_start'), { target: { value: '120' } });
    expect(screen.queryByText('frameleaf_studio_export_range_invalid')).toBeNull();
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenLastCalledWith(expect.objectContaining({ range: { inPoint: 120, outPoint: 121 } }));
  });

  it('renders at home only: this server or the home network, never Frameleaf Cloud (FL-159 §2.7)', () => {
    render(StudioExportDialog, {
      open: true,
      sequenceName: 'Lake trip',
      renderEvidence: [evidence()],
      onExport: vi.fn(),
    });
    const destinations = within(screen.getByLabelText('frameleaf_studio_export_destination')).getAllByRole('option');
    expect(destinations.map((option) => (option as HTMLOptionElement).value)).toEqual([
      MediaOperationDestination.Local,
      MediaOperationDestination.Lan,
    ]);
  });

  it('disables what the render workers cannot produce and names why the chosen export would be refused (FL-42)', async () => {
    const onExport = vi.fn();
    render(StudioExportDialog, {
      open: true,
      sequenceName: 'Lake trip',
      renderEvidence: [evidence({ gpuMemoryBytes: 4 * 1024 ** 3 })],
      onExport,
    });

    // 2160p needs 8 GB: refused before anything is submitted.
    expect(screen.getByText('frameleaf_studio_render_refusal_insufficient_memory')).toBeInTheDocument();
    expect(exportButton()).toBeDisabled();
    const resolution = screen.getByLabelText('frameleaf_studio_export_resolution');
    const option = (value: string) =>
      within(resolution)
        .getAllByRole('option')
        .find((item) => (item as HTMLOptionElement).value === value) as HTMLOptionElement;
    expect(option(StudioExportResolution.$2160P).disabled).toBe(true);
    expect(option(StudioExportResolution.$1080P).disabled).toBe(false);
    // No AV1 or ProRes encoder was verified.
    const format = screen.getByLabelText('frameleaf_studio_export_format');
    const formats = within(format).getAllByRole('option') as HTMLOptionElement[];
    expect(formats.filter((item) => item.disabled).map((item) => item.value)).toEqual(
      expect.arrayContaining([StudioExportFormat.WebmAv1, StudioExportFormat.Prores422Hq]),
    );

    await fireEvent.change(resolution, { target: { value: StudioExportResolution.$1080P } });
    expect(screen.queryByText('frameleaf_studio_render_refusal_insufficient_memory')).not.toBeInTheDocument();
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ resolution: StudioExportResolution.$1080P }));
  });

  it('keeps Studio export and Memory highlight in agreement for split-worker and supported evidence (FL-342)', () => {
    const [candidate] = evidence().candidates!;
    for (const candidates of [
      [
        { ...candidate, outputFormats: [StudioExportFormat.Mp4H264] },
        { ...candidate, gpuMemoryBytes: 2 * 1024 ** 3 },
      ],
      [candidate],
    ]) {
      const renderEvidence = [evidence({ candidates })];
      const studio = render(StudioExportDialog, {
        open: true,
        sequenceName: 'Lake trip',
        renderEvidence,
        onExport: vi.fn(),
      });
      const exportDisabled = (exportButton() as HTMLButtonElement).disabled;
      studio.unmount();
      const memory = render(MemoryHighlightDialog, {
        open: true,
        memoryTitle: 'Lake trip',
        renderEvidence,
        onStart: vi.fn(),
      });
      expect(
        (screen.getByRole('button', { name: 'frameleaf_memories_highlight_start' }) as HTMLButtonElement).disabled,
      ).toBe(exportDisabled);
      expect(exportDisabled).toBe(candidates.length > 1);
      memory.unmount();
    }
  });

  it('can reach H264/720p when qualified export proof cannot support either default (FL-342)', async () => {
    const onExport = vi.fn();
    const [candidate] = evidence().candidates!;
    render(StudioExportDialog, {
      open: true,
      sequenceName: 'Lake trip',
      onExport,
      renderEvidence: [
        evidence({
          // The summary also includes a preview-only 8 GiB HEVC session; it grants no export proof.
          candidates: [
            {
              ...candidate,
              gpuMemoryBytes: 2 * 1024 ** 3,
              outputFormats: [StudioExportFormat.Mp4H264],
              maxBitDepth: 8,
              hdr10: false,
            },
          ],
        }),
      ],
    });
    const format = screen.getByLabelText('frameleaf_studio_export_format');
    const h264 = within(format)
      .getAllByRole('option')
      .find((item) => (item as HTMLOptionElement).value === StudioExportFormat.Mp4H264) as HTMLOptionElement;
    expect(h264).not.toBeDisabled();
    expect(exportButton()).toBeDisabled();
    await fireEvent.change(format, { target: { value: StudioExportFormat.Mp4H264 } });
    expect(exportButton()).toBeDisabled();
    const resolution = screen.getByLabelText('frameleaf_studio_export_resolution');
    const smallest = within(resolution)
      .getAllByRole('option')
      .find((item) => (item as HTMLOptionElement).value === StudioExportResolution.$720P) as HTMLOptionElement;
    expect(smallest).not.toBeDisabled();
    await fireEvent.change(resolution, { target: { value: StudioExportResolution.$720P } });
    expect(exportButton()).not.toBeDisabled();
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledWith({
      format: StudioExportFormat.Mp4H264,
      color: StudioExportColor.Preserve,
      resolution: StudioExportResolution.$720P,
      quality: StudioExportQuality.High,
      subtitleMode: StudioExportSubtitleMode.Burn,
      destination: MediaOperationDestination.Local,
    });
  });

  it('refuses every export when no qualified render worker is online', () => {
    render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', onExport: vi.fn() });
    expect(screen.getByText('frameleaf_studio_render_refusal_no_qualified_worker')).toBeInTheDocument();
    expect(exportButton()).toBeDisabled();
  });

  it('explains what Dolby Vision needs', async () => {
    render(StudioExportDialog, {
      open: true,
      sequenceName: 'Lake trip',
      renderEvidence: [evidence()],
      onExport: vi.fn(),
    });
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_color'), {
      target: { value: StudioExportColor.DolbyVision },
    });
    expect(screen.getByText('frameleaf_studio_export_dolby_note')).toBeInTheDocument();
  });

  describe('Smooth motion after export (FL-162, FL-159)', () => {
    const interpolation = (destinations: object[]) =>
      vi.mocked(getMlCapabilities).mockResolvedValue({
        probedAt: '2026-09-27T00:00:00.000Z',
        studio: {},
        workloads: [{ workload: MlWorkload.Interpolation, available: true, routedDestinationId: null, destinations }],
      } as never);
    const home = {
      id: 'lan-1',
      kind: MlDestinationKind.Lan,
      name: 'Garage GPU',
      available: true,
      gpuMemoryBytes: null,
    };
    const cloud = { id: 'cloud-1', kind: MlDestinationKind.FrameleafCloud, name: 'Frameleaf Cloud', available: true };
    const smoothGroup = () =>
      within(screen.getByTestId('studio-export-smooth-motion')).getByRole('radiogroup', {
        name: 'frameleaf_studio_export_smooth_motion',
      });

    it('asks for it with the model slider, and sends it as its own job next to a home render', async () => {
      interpolation([home]);
      const onExport = vi.fn();
      render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', renderEvidence: [evidence()], onExport });

      await fireEvent.click(within(smoothGroup()).getAllByRole('radio')[2]);
      expect(
        await screen.findByRole('group', { name: 'frameleaf_restoration_smooth_motion_model' }),
      ).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText('frameleaf_studio_export_smooth_motion_local')).toBeInTheDocument());
      await fireEvent.click(exportButton());

      expect(onExport).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: MediaOperationDestination.Local,
          smoothMotion: { factor: 4, destinationId: 'lan-1' },
        }),
      );
    });

    it('keeps the export at home even when Smooth motion runs on Frameleaf Cloud, confirmed separately', async () => {
      interpolation([cloud]);
      const onExport = vi.fn();
      render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', renderEvidence: [evidence()], onExport });

      await fireEvent.click(within(smoothGroup()).getAllByRole('radio')[1]);
      await waitFor(() => expect(screen.getByText('frameleaf_studio_export_smooth_motion_cloud')).toBeInTheDocument());
      await fireEvent.click(exportButton());

      expect(onExport).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: MediaOperationDestination.Local,
          smoothMotion: { factor: 2, destinationId: 'cloud-1' },
        }),
      );
    });

    it('will not export with Smooth motion nothing can run, and says so', async () => {
      interpolation([]);
      const onExport = vi.fn();
      render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', renderEvidence: [evidence()], onExport });

      await fireEvent.click(within(smoothGroup()).getAllByRole('radio')[1]);
      await waitFor(() =>
        expect(screen.getByText('frameleaf_studio_export_smooth_motion_unavailable')).toBeInTheDocument(),
      );
      expect(exportButton()).toBeDisabled();
    });
  });
});

/** FL-563: Shape, with the framing of each shot following its subject (prototype `ReframePreview`). */
describe('Studio export dialog: vertical and square', () => {
  const PROJECT = '0195e2a0-0000-7000-8000-000000000001';
  const exportButton = () => screen.getByRole('button', { name: 'frameleaf_studio_export_start' });
  const framing = {
    revision: 3,
    width: 1920,
    height: 1080,
    shots: [
      {
        clipId: 'lake',
        type: StudioReframeShotType.Video,
        assetId: '0195e2a0-0000-4000-8000-000000000002',
        from: 0,
        durationInFrames: 120,
        subject: StudioReframeSubject.Face,
        path: [
          { t: 0.15, x: 0.3 },
          { t: 0.85, x: 0.7 },
        ],
      },
      {
        clipId: 'dock',
        type: StudioReframeShotType.Image,
        assetId: null,
        from: 120,
        durationInFrames: 90,
        subject: StudioReframeSubject.None,
        path: [{ t: 0.5, x: 0.5 }],
      },
    ],
  };
  const evidence = (reframe = true): StudioRenderEvidence => ({
    destination: MediaOperationDestination.Local,
    sessions: 1,
    gpuMemoryBytes: 16 * 1024 ** 3,
    codecs: ['webcodecs-avc'],
    maxBitDepth: 8,
    hdr10: false,
    dolbyVision: false,
    candidates: [
      {
        gpuMemoryBytes: 16 * 1024 ** 3,
        outputFormats: [StudioExportFormat.Mp4H264, StudioExportFormat.Mp4HevcMain10],
        maxBitDepth: 8,
        hdr10: false,
        dolbyVision: false,
        ...(reframe && { reframe: true }),
      },
    ],
  });
  const open = (props: Record<string, unknown> = {}) => {
    const onExport = vi.fn();
    vi.mocked(getStudioFraming).mockResolvedValue(framing);
    render(StudioExportDialog, {
      open: true,
      sequenceName: 'Lake trip',
      projectId: PROJECT,
      renderEvidence: [evidence()],
      onExport,
      ...props,
    });
    return onExport;
  };
  const shapeButton = (name: string) => screen.getByRole('radio', { name });

  it('offers Original, Vertical 9:16 and Square 1:1, starting from the original shape', async () => {
    const onExport = open();
    expect(shapeButton('frameleaf_studio_export_shape_original')).toHaveAttribute('aria-checked', 'true');
    expect(shapeButton('frameleaf_studio_export_shape_vertical')).toHaveAttribute('aria-checked', 'false');
    expect(shapeButton('frameleaf_studio_export_shape_square')).toBeInTheDocument();
    expect(getStudioFraming).not.toHaveBeenCalled();
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_format'), {
      target: { value: StudioExportFormat.Mp4H264 },
    });
    await fireEvent.click(exportButton());
    expect(onExport.mock.calls[0][0]).not.toHaveProperty('shape');
  });

  it('is not offered without a saved project', () => {
    render(StudioExportDialog, {
      open: true,
      sequenceName: 'Lake trip',
      renderEvidence: [evidence()],
      onExport: vi.fn(),
    });
    expect(screen.queryByRole('radio', { name: 'frameleaf_studio_export_shape_vertical' })).not.toBeInTheDocument();
  });

  it('frames every shot automatically and exports the shape with each crop path', async () => {
    const onExport = open();
    await fireEvent.click(shapeButton('frameleaf_studio_export_shape_vertical'));
    expect(getStudioFraming).toHaveBeenCalledWith({ id: PROJECT });
    expect(await screen.findByTestId('studio-export-reframe')).toBeInTheDocument();
    // a 10-bit master cannot be reshaped: the export switches to MP4 · H.264
    expect(screen.getByLabelText('frameleaf_studio_export_format')).toHaveValue(StudioExportFormat.Mp4H264);
    // the resolution options say the shaped size
    expect(screen.getByRole('option', { name: '2160 × 3840' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '1080 × 1920' })).toBeInTheDocument();
    expect(screen.getByText(/frameleaf_studio_reframe_titles/)).toBeInTheDocument();
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2);

    await fireEvent.click(exportButton());
    const choice = onExport.mock.calls[0][0];
    expect(choice).toMatchObject({ shape: StudioExportShape.Vertical, format: StudioExportFormat.Mp4H264 });
    expect(choice.framing).toEqual([
      {
        clipId: 'lake',
        path: [
          { t: 0.15, x: 0.3 },
          { t: 0.85, x: 0.7 },
        ],
      },
      { clipId: 'dock', path: [{ t: 0.5, x: 0.5 }] },
    ]);
  });

  it('moves a whole shot with the arrow keys, and Back to automatic undoes it', async () => {
    const onExport = open();
    await fireEvent.click(shapeButton('frameleaf_studio_export_shape_square'));
    const box = await screen.findByRole('slider', { name: 'frameleaf_studio_reframe_box' });
    const automatic = screen.getByRole('button', { name: /frameleaf_studio_reframe_automatic/ });
    expect(automatic).toBeDisabled();
    await fireEvent.keyDown(box, { key: 'ArrowRight' });
    await fireEvent.keyDown(box, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByText('frameleaf_studio_reframe_note_moved')).toBeInTheDocument();
    expect(screen.getByText(/frameleaf_studio_reframe_moved/)).toBeInTheDocument();
    await fireEvent.click(exportButton());
    // +0.06 on the whole shot, and the square crop (0.5625 of the width) is kept inside the frame
    expect(onExport.mock.calls[0][0].framing[0].path).toEqual([
      { t: 0.15, x: 0.36 },
      { t: 0.85, x: 0.7188 },
    ]);
    expect(automatic).toBeEnabled();
    await fireEvent.click(automatic);
    expect(screen.getByText('frameleaf_studio_reframe_note_auto')).toBeInTheDocument();
    await fireEvent.click(exportButton());
    expect(onExport.mock.calls[1][0].framing[0].path[0]).toEqual({ t: 0.15, x: 0.3 });
  });

  it('moves a shot by dragging its box', async () => {
    const onExport = open();
    await fireEvent.click(shapeButton('frameleaf_studio_export_shape_vertical'));
    const frame = await screen.findByTestId('studio-reframe-frame');
    frame.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 500,
      height: 281,
      right: 500,
      bottom: 281,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const box = screen.getByTestId('studio-reframe-box');
    await fireEvent.pointerDown(box, { clientX: 200, pointerId: 1 });
    await fireEvent.pointerMove(globalThis as unknown as Window, { clientX: 150, pointerId: 1 });
    await fireEvent.pointerUp(globalThis as unknown as Window, { pointerId: 1 });
    await fireEvent.click(exportButton());
    // 50 px of a 500 px frame to the left: a tenth of the width
    expect(onExport.mock.calls[0][0].framing[0].path[0].x).toBe(0.2);
  });

  it('keeps the export possible, centred, when the framing cannot be worked out', async () => {
    const onExport = vi.fn();
    vi.mocked(getStudioFraming).mockRejectedValue(new Error('offline'));
    render(StudioExportDialog, {
      open: true,
      sequenceName: 'Lake trip',
      projectId: PROJECT,
      renderEvidence: [evidence()],
      onExport,
    });
    await fireEvent.click(shapeButton('frameleaf_studio_export_shape_vertical'));
    expect(await screen.findByText('frameleaf_studio_reframe_failed')).toBeInTheDocument();
    await fireEvent.click(exportButton());
    expect(onExport.mock.calls[0][0]).toMatchObject({ shape: StudioExportShape.Vertical });
    expect(onExport.mock.calls[0][0]).not.toHaveProperty('framing');
  });

  it('explains when no render worker can reframe', async () => {
    open({ renderEvidence: [evidence(false)] });
    await fireEvent.click(shapeButton('frameleaf_studio_export_shape_vertical'));
    await screen.findByTestId('studio-export-reframe');
    expect(exportButton()).toBeDisabled();
    expect(screen.getByText('frameleaf_studio_render_refusal_codec_unavailable')).toBeInTheDocument();
  });
});
