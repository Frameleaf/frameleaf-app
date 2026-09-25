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

  it('warns that media leaves the network and needs consent before a cloud export', async () => {
    const onExport = vi.fn();
    render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', onExport });

    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_destination'), {
      target: { value: MediaOperationDestination.Runpod },
    });
    expect(screen.getByText('frameleaf_studio_export_leaves')).toBeInTheDocument();
    expect(exportButton()).toBeDisabled();

    await fireEvent.click(screen.getByRole('checkbox', { name: 'frameleaf_studio_export_cloud_consent' }));
    await fireEvent.click(exportButton());
    expect(onExport).toHaveBeenCalledWith(
      expect.objectContaining({ destination: MediaOperationDestination.Runpod, cloudConsent: true }),
    );
  });

  it('explains what Dolby Vision needs', async () => {
    render(StudioExportDialog, { open: true, sequenceName: 'Lake trip', onExport: vi.fn() });
    await fireEvent.change(screen.getByLabelText('frameleaf_studio_export_color'), {
      target: { value: StudioExportColor.DolbyVision },
    });
    expect(screen.getByText('frameleaf_studio_export_dolby_note')).toBeInTheDocument();
  });
});
