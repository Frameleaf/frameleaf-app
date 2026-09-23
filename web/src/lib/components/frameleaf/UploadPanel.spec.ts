import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';
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

  it('offers retry and dismiss on a failed upload, and shows its error message', () => {
    uploadAssetsStore.addItem({ id: 'a', file: makeFile('broken.jpg') });
    uploadAssetsStore.updateItem('a', { state: UploadState.ERROR, error: 'The server rejected this file' });

    render(UploadPanel);

    expect(screen.getByText('The server rejected this file')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.retry_upload })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.dismiss })).toBeInTheDocument();
  });

  it('offers a view link and dismiss on a duplicate that resolved to an existing asset', () => {
    uploadAssetsStore.addItem({ id: 'a', file: makeFile('again.jpg') });
    uploadAssetsStore.updateItem('a', { state: UploadState.DUPLICATED, assetId: 'asset-1' });

    render(UploadPanel);

    expect(screen.getByRole('link', { name: en.view })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.dismiss })).toBeInTheDocument();
  });
});
