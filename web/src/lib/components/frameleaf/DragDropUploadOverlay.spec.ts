import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { fileUploadHandler } from '$lib/utils/file-uploader';
import en from '../../../../../i18n/en.json';
import DragDropUploadOverlay from './DragDropUploadOverlay.svelte';

vi.mock('$app/state', () => ({
  page: {
    route: { id: '/(user)/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]' },
    params: { albumId: 'target-album' },
    data: { album: { id: 'target-album', albumName: 'Drop target' } },
  },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { isSharedLink: false } }));
vi.mock('$lib/utils/file-uploader', () => ({ fileUploadHandler: vi.fn().mockResolvedValue([]) }));

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

it('announces the album destination and sends dropped files to that album', async () => {
  render(DragDropUploadOverlay);
  const file = new File(['photo'], 'dropped.png', { type: 'image/png' });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  // Happy DOM does not populate the browser's Files drag type.
  Object.defineProperty(dataTransfer, 'types', { value: ['Files'] });

  await fireEvent.dragEnter(document.body, { dataTransfer });
  expect(screen.getByRole('status')).toHaveTextContent('Drop to add to Drop target');
  expect(screen.getByRole('status')).toHaveTextContent('They are added to your library and to this album');
  await fireEvent.drop(document.body, { dataTransfer });
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(fileUploadHandler).toHaveBeenCalledExactlyOnceWith({
    files: [file],
    albumId: 'target-album',
    isLockedAssets: false,
  });
});

it('ignores internal drags without admitting an upload', async () => {
  render(DragDropUploadOverlay);
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File(['photo'], 'internal.png', { type: 'image/png' }));
  Object.defineProperty(dataTransfer, 'types', { value: ['Files'] });

  await fireEvent.dragStart(document.body, { dataTransfer });
  await fireEvent.dragEnter(document.body, { dataTransfer });
  expect(screen.queryByRole('status')).toBeNull();
  await fireEvent.drop(document.body, { dataTransfer });
  expect(fileUploadHandler).not.toHaveBeenCalled();
  await fireEvent.dragEnd(document.body, { dataTransfer });
});
