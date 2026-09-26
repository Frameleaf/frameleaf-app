import { MediaOperationDestination, StudioExportColor, StudioExportFormat, StudioExportResolution } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import StudioExportDialog from '$lib/components/frameleaf/StudioExportDialog.svelte';
import type { StudioRenderEvidence } from '$lib/frameleaf/studio/host-contract';

/** The Studio video export dialog (FL-88 header, `Studio.jsx` ExportDialog). */
describe('Studio export dialog', () => {
  const exportButton = () => screen.getByRole('button', { name: 'frameleaf_studio_export_start' });

  const evidence = (overrides: Partial<StudioRenderEvidence> = {}): StudioRenderEvidence => ({
    destination: MediaOperationDestination.Local,
    sessions: 1,
    gpuMemoryBytes: 16 * 1024 ** 3,
    codecs: ['hevc_nvenc', 'h264_nvenc'],
    maxBitDepth: 10,
    hdr10: true,
    dolbyVision: false,
    ...overrides,
  });

  it("starts from the prototype's defaults and renders on the network", async () => {
    const onExport = vi.fn();
    render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', renderEvidence: [evidence()], onExport });

    expect(screen.getByText('frameleaf_studio_export_on_network')).toBeInTheDocument();
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledWith({
      format: StudioExportFormat.Mp4HevcMain10,
      color: StudioExportColor.Preserve,
      resolution: StudioExportResolution.$2160P,
      destination: MediaOperationDestination.Local,
    });
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
});
