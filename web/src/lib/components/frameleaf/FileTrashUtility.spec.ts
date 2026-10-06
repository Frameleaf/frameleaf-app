import type { FileTrashResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import FileTrashUtility from '$lib/components/frameleaf/FileTrashUtility.svelte';
import en from '../../../../../i18n/en.json';

vi.mock('@frameleaf/ui', async () => {
  const actual = await vi.importActual<typeof import('@frameleaf/ui')>('@frameleaf/ui');
  return {
    ...actual,
    modalManager: { showDialog: vi.fn(), show: vi.fn() },
    toastManager: { primary: vi.fn(), danger: vi.fn() },
  };
});

const initial: FileTrashResponseDto = {
  items: [
    {
      id: 'ft-1',
      originalFileName: 'IMG_4021.HEIC',
      sizeInBytes: 3_481_202,
      checksum: 'a'.repeat(64),
      lastOwnerId: 'owner-1',
      lastOwnerName: 'Taylor',
      lastAssetId: 'asset-1',
      trashedAt: '2026-10-02T18:20:00.000Z',
    },
    {
      id: 'ft-2',
      originalFileName: 'DSC_0912.NEF',
      sizeInBytes: 28_114_908,
      checksum: 'b'.repeat(64),
      lastOwnerId: null,
      lastOwnerName: null,
      lastAssetId: null,
      trashedAt: '2026-09-21T14:41:00.000Z',
    },
  ],
  total: 2,
  totalBytes: 31_596_110,
};

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('FileTrashUtility', () => {
  it('lists the files with the total size the file trash holds', () => {
    render(FileTrashUtility, { initial });

    expect(screen.getByText('IMG_4021.HEIC')).toBeInTheDocument();
    expect(screen.getByText('DSC_0912.NEF')).toBeInTheDocument();
    expect(screen.getByText(/2 files/)).toBeInTheDocument();
    expect(screen.getByText('Taylor')).toBeInTheDocument();
    // a file whose account is gone cannot be restored
    const restore = screen.getAllByRole('button', { name: en.frameleaf_file_trash_restore });
    expect(restore[1]).toBeDisabled();
  });

  it('restores a file to the library it was last in', async () => {
    sdkMock.restoreFileTrashItem.mockResolvedValue({ assetId: 'new-asset' });
    const { toastManager } = await import('@frameleaf/ui');
    render(FileTrashUtility, { initial });

    await fireEvent.click(screen.getAllByRole('button', { name: en.frameleaf_file_trash_restore })[0]);

    await waitFor(() => expect(sdkMock.restoreFileTrashItem).toHaveBeenCalledWith({ id: 'ft-1' }));
    await waitFor(() => expect(screen.queryByText('IMG_4021.HEIC')).toBeNull());
    expect(toastManager.primary).toHaveBeenCalled();
  });

  it('deletes a file permanently only after confirmation', async () => {
    const { modalManager } = await import('@frameleaf/ui');
    vi.mocked(modalManager.show)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(true as never);
    sdkMock.deleteFileTrashItem.mockResolvedValue(undefined as never);
    render(FileTrashUtility, { initial });
    const remove = () => screen.getAllByRole('button', { name: en.frameleaf_file_trash_delete })[1];

    await fireEvent.click(remove());
    await waitFor(() => expect(modalManager.show).toHaveBeenCalledTimes(1));
    expect(sdkMock.deleteFileTrashItem).not.toHaveBeenCalled();

    await fireEvent.click(remove());
    await waitFor(() => expect(sdkMock.deleteFileTrashItem).toHaveBeenCalledWith({ id: 'ft-2' }));
    await waitFor(() => expect(screen.queryByText('DSC_0912.NEF')).toBeNull());
  });

  it('says so when the file trash is empty', () => {
    render(FileTrashUtility, { initial: { items: [], total: 0, totalBytes: 0 } });

    expect(screen.getByText(en.frameleaf_file_trash_empty)).toBeInTheDocument();
  });
});
