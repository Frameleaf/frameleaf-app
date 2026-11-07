import { MediaHealthRepairMethod, previewRepair, repair } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import LibraryCareRepairDialog from '$lib/components/frameleaf/LibraryCareRepairDialog.svelte';
import type { LibraryCareRow } from '$lib/frameleaf/library-care';
import en from '../../../../../i18n/en.json';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  previewRepair: vi.fn(),
  repair: vi.fn(),
}));

const row = { id: 'health-1', assetId: 'asset-1', name: 'IMG_0001.JPG' } as LibraryCareRow;
const preview = {
  findingId: 'health-1',
  method: MediaHealthRepairMethod.Lossless,
  width: 640,
  height: 480,
  sizeInBytes: 2048,
  checksum: 'a'.repeat(40),
  preview: 'data:image/jpeg;base64,AAAA',
  metadataKept: true,
};

beforeAll(() => {
  addMessages('dev', en);
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => vi.clearAllMocks());

describe('LibraryCareRepairDialog', () => {
  it('shows the damaged original beside the repair and replaces it only on approval', async () => {
    vi.mocked(previewRepair).mockResolvedValue(preview);
    vi.mocked(repair).mockResolvedValue({ findingId: 'health-1', assetId: 'asset-1', method: preview.method });
    const onRepaired = vi.fn();
    render(LibraryCareRepairDialog, { open: true, row, showOriginal: true, onRepaired });

    expect(screen.getByRole('img', { name: 'Damaged original' })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Repaired' })).toHaveAttribute('src', preview.preview);
    expect(screen.getByText(/The picture itself is intact/)).toBeInTheDocument();
    expect(repair).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Replace with repaired photo' }));
    expect(repair).toHaveBeenCalledWith({
      mediaHealthRepairDto: { findingId: 'health-1', checksum: preview.checksum },
    });
    await waitFor(() => expect(onRepaired).toHaveBeenCalled());
  });

  it('says when only the embedded preview was saved and the details were lost', async () => {
    vi.mocked(previewRepair).mockResolvedValue({
      ...preview,
      method: MediaHealthRepairMethod.Preview,
      width: 160,
      height: 120,
      metadataKept: false,
    });
    render(LibraryCareRepairDialog, { open: true, row, showOriginal: true, onRepaired: vi.fn() });

    expect(
      await screen.findByText(/Only the small preview stored inside the file could be saved \(160 × 120\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/couldn’t be read from the damaged file/)).toBeInTheDocument();
  });

  it('shows another account’s repair without its picture, and blocks a change it cannot review', async () => {
    vi.mocked(previewRepair).mockResolvedValue({ ...preview, method: MediaHealthRepairMethod.Rebuilt, preview: null });
    render(LibraryCareRepairDialog, { open: true, row, showOriginal: false, onRepaired: vi.fn() });

    expect(await screen.findByText(/only the photo’s owner can review and approve it/)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Repaired' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace with repaired photo' })).toBeDisabled();
  });

  it('says when nothing could be recovered and offers no replacement', async () => {
    vi.mocked(previewRepair).mockRejectedValue(new Error('no'));
    render(LibraryCareRepairDialog, { open: true, row, showOriginal: false, onRepaired: vi.fn() });

    expect(await screen.findByRole('alert')).toHaveTextContent('This photo could not be repaired.');
    expect(screen.getByRole('button', { name: 'Replace with repaired photo' })).toBeDisabled();
  });
});
