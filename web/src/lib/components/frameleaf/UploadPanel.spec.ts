import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';
import en from '../../../../../i18n/en.json';
import UploadPanel from './UploadPanel.svelte';

/**
 * UploadPanel (FL-45) renders directly off `uploadAssetsStore`, the same store the real
 * upload manager writes to — these tests drive the panel by writing to that store the way
 * `fileUploadHandler` does, never by faking a timer-driven progress simulation.
 */

const makeFile = (name: string, size = 1024) => new File([new Uint8Array(size)], name, { type: 'image/jpeg' });

beforeEach(() => {
  addMessages('dev', en);
  uploadAssetsStore.reset();
});

describe('UploadPanel', () => {
  it('renders nothing when there are no uploads', () => {
    const { container } = render(UploadPanel);
    expect(container.querySelector('.fl-panel')).toBeNull();
  });

  it('shows a row per queued file with its name', () => {
    uploadAssetsStore.addItem({ id: 'a', file: makeFile('sunset.jpg') });
    uploadAssetsStore.addItem({ id: 'b', file: makeFile('beach.jpg') });

    render(UploadPanel);

    expect(screen.getByText('sunset.jpg')).toBeInTheDocument();
    expect(screen.getByText('beach.jpg')).toBeInTheDocument();
  });

  it('is a region named Uploads (UploadPanel.jsx:327)', () => {
    uploadAssetsStore.addItem({ id: 'a', file: makeFile('sunset.jpg') });

    render(UploadPanel);

    expect(screen.getByRole('region', { name: en.frameleaf_transfer_uploads })).toBeInTheDocument();
  });

  it('shows the size and the prototype status in each row', () => {
    uploadAssetsStore.addItem({ id: 'wait', file: makeFile('wait.jpg') });
    uploadAssetsStore.addItem({ id: 'done', file: makeFile('done.jpg') });
    uploadAssetsStore.addItem({ id: 'same', file: makeFile('same.jpg') });
    uploadAssetsStore.addItem({ id: 'going', file: makeFile('going.jpg') });
    uploadAssetsStore.updateItem('done', { state: UploadState.DONE });
    uploadAssetsStore.updateItem('same', { state: UploadState.DUPLICATED, assetId: 'asset-1' });
    uploadAssetsStore.markStarted('going');
    uploadAssetsStore.updateItem('going', { progress: 42 });

    const { container } = render(UploadPanel);
    const meta = (id: string) =>
      [...container.querySelectorAll('.fl-row')]
        .find((row) => row.textContent?.includes(`${id}.jpg`))
        ?.querySelector('.fl-meta')
        ?.textContent?.trim();

    expect(meta('wait')).toMatch(/· Waiting$/);
    expect(meta('done')).toMatch(/· Uploaded$/);
    expect(meta('same')).toMatch(/· Already in your library$/);
    expect(meta('going')).toMatch(/· Uploading 42%$/);
  });

  it('shows the error of a failed upload without per-row controls, and retries from the footer', () => {
    uploadAssetsStore.addItem({ id: 'a', file: makeFile('broken.jpg') });
    uploadAssetsStore.updateItem('a', { state: UploadState.ERROR, error: 'The server rejected this file' });
    uploadAssetsStore.track('error');

    render(UploadPanel);

    expect(screen.getByText('The server rejected this file')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.frameleaf_transfer_retry_failed })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.dismiss })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('dismisses failed uploads only, keeping duplicates (U-1)', async () => {
    uploadAssetsStore.addItem({ id: 'same', file: makeFile('same.jpg') });
    uploadAssetsStore.addItem({ id: 'failed', file: makeFile('failed.jpg') });
    uploadAssetsStore.updateItem('same', { state: UploadState.DUPLICATED, assetId: 'asset-1' });
    uploadAssetsStore.track('duplicate');
    uploadAssetsStore.updateItem('failed', { state: UploadState.ERROR, error: 'nope' });
    uploadAssetsStore.track('error');

    render(UploadPanel);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_transfer_dismiss_errors }));

    expect(screen.queryByText('failed.jpg')).toBeNull();
    expect(screen.getByText('same.jpg')).toBeInTheDocument();
    // The counts drop the dismissed failure too, so the panel no longer asks for attention.
    expect(screen.queryByRole('button', { name: en.frameleaf_transfer_retry_failed })).toBeNull();
    expect(screen.getByText(en.frameleaf_transfer_upload_complete)).toBeInTheDocument();
  });

  it('styles a failed row as an error (M4: the status attribute is a name, not the numeric state)', () => {
    uploadAssetsStore.addItem({ id: 'failed', file: makeFile('failed.jpg') });
    uploadAssetsStore.addItem({ id: 'done', file: makeFile('done.jpg') });
    uploadAssetsStore.updateItem('failed', { state: UploadState.ERROR, error: 'nope' });
    uploadAssetsStore.updateItem('done', { state: UploadState.DONE });

    const { container } = render(UploadPanel);

    const failed = container.querySelector('.fl-row[data-status="error"]');
    expect(failed).toHaveTextContent('failed.jpg');
    expect(container.querySelector('.fl-row[data-status="done"]')).toHaveTextContent('done.jpg');
  });

  it('drops dismissed failures from the batch total (M5)', async () => {
    uploadAssetsStore.addItem({ id: 'going', file: makeFile('going.jpg') });
    uploadAssetsStore.addItem({ id: 'failed', file: makeFile('failed.jpg') });
    uploadAssetsStore.updateItem('failed', { state: UploadState.ERROR, error: 'nope' });
    uploadAssetsStore.track('error');
    uploadAssetsStore.markStarted('going');

    render(UploadPanel);
    expect(screen.getByText('Uploading 2 of 2')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_transfer_dismiss_errors }));

    expect(screen.getByText('Uploading 1 of 1')).toBeInTheDocument();
  });

  it('does not offer Dismiss errors for duplicates alone', () => {
    uploadAssetsStore.addItem({ id: 'same', file: makeFile('same.jpg') });
    uploadAssetsStore.updateItem('same', { state: UploadState.DUPLICATED, assetId: 'asset-1' });

    render(UploadPanel);

    expect(screen.queryByRole('button', { name: en.frameleaf_transfer_dismiss_errors })).toBeNull();
  });

  it('minimises to a pill with the label and overall percent (U-2)', async () => {
    uploadAssetsStore.addItem({ id: 'a', file: makeFile('a.jpg') });
    uploadAssetsStore.addItem({ id: 'b', file: makeFile('b.jpg') });
    uploadAssetsStore.updateItem('a', { state: UploadState.DONE });
    uploadAssetsStore.track('success');

    render(UploadPanel);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_transfer_minimize_uploads }));

    const pill = screen.getByRole('button', { name: /^Show uploads\. Uploading 2 of 2\. 1 uploaded$/ });
    expect(pill).toHaveTextContent('Uploading 2 of 2');
    expect(pill).toHaveTextContent('50%');
  });

  it('offers Clear finished while uploads continue, keeping what is still going and what failed', async () => {
    uploadAssetsStore.addItem({ id: 'done', file: makeFile('done.jpg') });
    uploadAssetsStore.addItem({ id: 'same', file: makeFile('same.jpg') });
    uploadAssetsStore.addItem({ id: 'failed', file: makeFile('failed.jpg') });
    uploadAssetsStore.addItem({ id: 'going', file: makeFile('going.jpg') });
    uploadAssetsStore.updateItem('done', { state: UploadState.DONE });
    uploadAssetsStore.updateItem('same', { state: UploadState.DUPLICATED, assetId: 'asset-1' });
    uploadAssetsStore.updateItem('failed', { state: UploadState.ERROR, error: 'nope' });
    uploadAssetsStore.markStarted('going');

    render(UploadPanel);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_transfer_clear_finished }));

    expect(screen.queryByText('done.jpg')).toBeNull();
    expect(screen.queryByText('same.jpg')).toBeNull();
    expect(screen.getByText('failed.jpg')).toBeInTheDocument();
    expect(screen.getByText('going.jpg')).toBeInTheDocument();
  });

  it('does not offer Clear finished once nothing is running (Done clears everything)', () => {
    uploadAssetsStore.addItem({ id: 'done', file: makeFile('done.jpg') });
    uploadAssetsStore.updateItem('done', { state: UploadState.DONE });

    render(UploadPanel);

    expect(screen.queryByRole('button', { name: en.frameleaf_transfer_clear_finished })).toBeNull();
  });
});
