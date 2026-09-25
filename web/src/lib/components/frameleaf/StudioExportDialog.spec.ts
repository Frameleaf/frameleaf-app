import { MediaOperationDestination, StudioExportColor, StudioExportFormat, StudioExportResolution } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import StudioExportDialog from '$lib/components/frameleaf/StudioExportDialog.svelte';

/** The Studio video export dialog (FL-88 header, `Studio.jsx` ExportDialog). */
describe('Studio export dialog', () => {
  const exportButton = () => screen.getByRole('button', { name: 'frameleaf_studio_export_start' });

  it("starts from the prototype's defaults and renders on the network", async () => {
    const onExport = vi.fn();
    render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', onExport });

    expect(screen.getByText('frameleaf_studio_export_on_network')).toBeInTheDocument();
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledWith({
      format: StudioExportFormat.Mp4HevcMain10,
      color: StudioExportColor.Preserve,
      resolution: StudioExportResolution.$2160P,
      destination: MediaOperationDestination.Local,
      cloudConsent: false,
    });
  });

  it('renders only at home: this server or the home network, never Frameleaf Cloud (effd05ffb7)', async () => {
    const onExport = vi.fn();
    render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', onExport });

    const options = [...(screen.getByLabelText('frameleaf_studio_export_destination') as HTMLSelectElement).options];
    expect(options.map((option) => option.value)).toEqual([
      MediaOperationDestination.Local,
      MediaOperationDestination.Lan,
    ]);
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_destination'), {
      target: { value: MediaOperationDestination.Lan },
    });
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledWith(
      expect.objectContaining({ destination: MediaOperationDestination.Lan, cloudConsent: false }),
    );
    expect(screen.queryByText('frameleaf_studio_export_leaves')).not.toBeInTheDocument();
  });

  it('explains what Dolby Vision needs', async () => {
    render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', onExport: vi.fn() });
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_color'), {
      target: { value: StudioExportColor.DolbyVision },
    });
    expect(screen.getByText('frameleaf_studio_export_dolby_note')).toBeInTheDocument();
  });
});
