import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import StudioBundleExportDialog from '$lib/components/frameleaf/StudioBundleExportDialog.svelte';

/**
 * The editor's bundle export dialog (FL-91): the same question the project library asks, with the
 * same words, and a choice that defaults to no copies.
 */
describe('Studio bundle export dialog', () => {
  const includeMedia = () => screen.getByRole('checkbox', { name: 'frameleaf_studio_bundle_include_media' });
  const exportButton = () => screen.getByRole('button', { name: 'frameleaf_studio_bundle_export_start' });

  it('asks whether to include copies of owned media, unchecked, with what that means', () => {
    render(StudioBundleExportDialog, { open: true, projectName: 'Lake trip', onConfirm: vi.fn() });

    expect(includeMedia()).not.toBeChecked();
    // Owned media only, shared media referenced, never Locked: the library dialog's own note.
    expect(screen.getByText('frameleaf_studio_bundle_include_media_note')).toBeInTheDocument();
  });

  it('exports without copies unless the person asks for them', async () => {
    const onConfirm = vi.fn();
    render(StudioBundleExportDialog, { open: true, projectName: 'Lake trip', onConfirm });

    await fireEvent.click(exportButton());

    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('hands the choice to include copies to the route', async () => {
    const onConfirm = vi.fn();
    render(StudioBundleExportDialog, { open: true, projectName: 'Lake trip', onConfirm });

    await fireEvent.click(includeMedia());
    await fireEvent.click(exportButton());

    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('cancels without exporting', async () => {
    const onConfirm = vi.fn();
    render(StudioBundleExportDialog, { open: true, projectName: 'Lake trip', onConfirm });

    await fireEvent.click(screen.getByRole('button', { name: 'cancel' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
