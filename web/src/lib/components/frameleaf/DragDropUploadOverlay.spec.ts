import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { page } from '$app/state';
import { clearPrivateBrowserState } from '$lib/frameleaf/private-browser-state';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { fileUploadHandler } from '$lib/utils/file-uploader';
import en from '../../../../../i18n/en.json';
import DragDropUploadOverlay from './DragDropUploadOverlay.svelte';
import DropUploadTest from './__test__/DropUploadTest.svelte';

vi.mock('$app/state', () => ({
  page: {
    url: new URL('https://example.test/albums/target-album'),
    route: { id: '/(user)/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]' },
    params: { albumId: 'target-album' },
    data: { album: { id: 'target-album', albumName: 'Drop target' } },
  },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { isSharedLink: false, authenticated: false, params: {} },
}));
vi.mock('$lib/utils/file-uploader', () => ({ fileUploadHandler: vi.fn().mockResolvedValue([]) }));

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  page.url = new URL('https://example.test/albums/target-album');
  Object.assign(authManager, { isSharedLink: false, authenticated: false, params: {} });
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

it.each(['route', 'account', 'unmount', 'share-key', 'private-state', 'unchanged'] as const)(
  'keeps a deferred directory drop scoped to its %s destination',
  async (change) => {
    Object.assign(authManager, { authenticated: true, user: { id: 'original-user' } });
    const component = render(DragDropUploadOverlay);
    const file = new File(['photo'], 'deferred.png', { type: 'image/png' });
    let complete!: FileCallback;
    const entry = {
      isFile: true,
      isDirectory: false,
      file: (success: FileCallback) => {
        complete = success;
      },
    };
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const item = dataTransfer.items[0];
    Object.defineProperty(item, 'webkitGetAsEntry', { value: () => entry });
    const original = Object.getOwnPropertyDescriptor(DataTransferItem.prototype, 'webkitGetAsEntry');
    Object.defineProperty(DataTransferItem.prototype, 'webkitGetAsEntry', { configurable: true, value: () => null });
    try {
      const dropping = fireEvent.drop(document.body, { dataTransfer });
      await waitFor(() => expect(complete).toBeTypeOf('function'));
      switch (change) {
        case 'route': {
          page.url = new URL('https://example.test/albums/another-album');
          break;
        }
        case 'account': {
          Object.assign(authManager, { authenticated: true, user: { id: 'another-user' } });
          break;
        }
        case 'share-key': {
          Object.assign(authManager, { params: { key: 'replacement-share' } });
          break;
        }
        case 'unmount': {
          component.unmount();
          break;
        }
        case 'private-state': {
          clearPrivateBrowserState();
          break;
        }
        case 'unchanged': {
          break;
        }
      }
      complete(file);
      await dropping;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (change === 'unchanged') {
        expect(fileUploadHandler).toHaveBeenCalledExactlyOnceWith({
          files: [file],
          albumId: 'target-album',
          isLockedAssets: false,
        });
      } else {
        expect(fileUploadHandler).not.toHaveBeenCalled();
      }
    } finally {
      Object.assign(authManager, { authenticated: false });
      if (original) {
        Object.defineProperty(DataTransferItem.prototype, 'webkitGetAsEntry', original);
      } else {
        Reflect.deleteProperty(DataTransferItem.prototype, 'webkitGetAsEntry');
      }
    }
  },
);

it('hands shared files only to the owning layout receiver', async () => {
  Object.assign(authManager, { isSharedLink: true, params: { key: 'current-share' } });
  const receive = vi.fn();
  render(DropUploadTest, { receive });
  const file = new File(['photo'], 'shared.png', { type: 'image/png' });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  await fireEvent.drop(document.body, { dataTransfer });
  await waitFor(() => expect(receive).toHaveBeenCalledExactlyOnceWith([file]));
  expect(fileUploadHandler).not.toHaveBeenCalled();
});

it('does not retain a shared drop while a password gate has no receiver', async () => {
  Object.assign(authManager, { isSharedLink: true });
  const component = render(DragDropUploadOverlay);
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File(['photo'], 'gated.png'));
  await fireEvent.drop(document.body, { dataTransfer });
  await new Promise((resolve) => setTimeout(resolve, 0));
  component.unmount();
  const receive = vi.fn();
  render(DropUploadTest, { receive });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(receive).not.toHaveBeenCalled();
  expect(fileUploadHandler).not.toHaveBeenCalled();
});

it('reads every directory chunk without changing traversal order', async () => {
  render(DragDropUploadOverlay);
  const first = new File(['first'], 'first.png');
  const second = new File(['second'], 'second.png');
  const leaf = (file: File) => ({ isDirectory: false, isFile: true, file: (success: FileCallback) => success(file) });
  const chunks = [[leaf(first)], [leaf(second)], []];
  const readEntries = vi.fn((success: FileSystemEntriesCallback) =>
    success(chunks.shift() as unknown as FileSystemEntry[]),
  );
  const directory = { isDirectory: true, isFile: false, createReader: () => ({ readEntries }) };
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(first);
  Object.defineProperty(dataTransfer.items[0], 'webkitGetAsEntry', { value: () => directory });
  const original = Object.getOwnPropertyDescriptor(DataTransferItem.prototype, 'webkitGetAsEntry');
  Object.defineProperty(DataTransferItem.prototype, 'webkitGetAsEntry', { configurable: true, value: () => null });
  try {
    await fireEvent.drop(document.body, { dataTransfer });
    await waitFor(() =>
      expect(fileUploadHandler).toHaveBeenCalledExactlyOnceWith({
        files: [second, first],
        albumId: 'target-album',
        isLockedAssets: false,
      }),
    );
    expect(readEntries).toHaveBeenCalledTimes(3);
  } finally {
    if (original) {
      Object.defineProperty(DataTransferItem.prototype, 'webkitGetAsEntry', original);
    } else {
      Reflect.deleteProperty(DataTransferItem.prototype, 'webkitGetAsEntry');
    }
  }
});

it('stops requesting directory chunks when the destination changes', async () => {
  render(DragDropUploadOverlay);
  const file = new File(['photo'], 'cancelled.png');
  let complete!: FileSystemEntriesCallback;
  const readEntries = vi.fn((success: FileSystemEntriesCallback) => {
    complete = success;
  });
  const directory = { isDirectory: true, isFile: false, createReader: () => ({ readEntries }) };
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  Object.defineProperty(dataTransfer.items[0], 'webkitGetAsEntry', { value: () => directory });
  const original = Object.getOwnPropertyDescriptor(DataTransferItem.prototype, 'webkitGetAsEntry');
  Object.defineProperty(DataTransferItem.prototype, 'webkitGetAsEntry', { configurable: true, value: () => null });
  try {
    await fireEvent.drop(document.body, { dataTransfer });
    await waitFor(() => expect(complete).toBeTypeOf('function'));
    page.url = new URL('https://example.test/photos');
    complete([{ isDirectory: false, isFile: true, file: vi.fn() } as unknown as FileSystemEntry]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readEntries).toHaveBeenCalledTimes(1);
    expect(fileUploadHandler).not.toHaveBeenCalled();
  } finally {
    if (original) {
      Object.defineProperty(DataTransferItem.prototype, 'webkitGetAsEntry', original);
    } else {
      Reflect.deleteProperty(DataTransferItem.prototype, 'webkitGetAsEntry');
    }
  }
});
