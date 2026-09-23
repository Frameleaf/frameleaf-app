import type { LibraryRemovalReviewDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LibraryRemoveDialog from '$lib/components/frameleaf/LibraryRemoveDialog.svelte';
import en from '../../../../../i18n/en.json';

const review = (overrides: Partial<LibraryRemovalReviewDto> = {}): LibraryRemovalReviewDto => ({
  libraryId: 'lib-1',
  name: 'Family photo archive',
  ownerId: 'owner-1',
  photos: 40,
  videos: 2,
  total: 42,
  usage: 1000,
  offline: 1,
  albums: 3,
  sharedLinks: 1,
  faces: 7,
  scanActive: true,
  originalsKept: true,
  reviewToken: 'token-1',
  ...overrides,
});

const ack = (count: number) => `I understand that ${count} indexed items will be removed from the library.`;

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('LibraryRemoveDialog (FL-78)', () => {
  it('reviews the consequences before anything can be confirmed', async () => {
    sdkMock.getLibraryRemovalReview.mockResolvedValue(review());
    render(LibraryRemoveDialog, { libraryId: 'lib-1', onRemoved: vi.fn(), onClose: vi.fn() });

    expect(await screen.findByText('3 albums lose items')).toBeInTheDocument();
    expect(screen.getByText('1 shared link loses items')).toBeInTheDocument();
    expect(screen.getByText('7 detected faces are removed')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_libraries_remove_scan)).toBeInTheDocument();
    expect(screen.getByText(/The files in your source folders will remain/)).toBeInTheDocument();
    // nothing is removed until the second stage
    expect(screen.getByRole('button', { name: en.frameleaf_libraries_remove })).toBeDisabled();
    expect(sdkMock.removeLibrary).not.toHaveBeenCalled();
  });

  it('confirms with the typed name and the review token', async () => {
    const onRemoved = vi.fn();
    sdkMock.getLibraryRemovalReview.mockResolvedValue(review());
    sdkMock.removeLibrary.mockResolvedValue(undefined as never);
    render(LibraryRemoveDialog, { libraryId: 'lib-1', onRemoved, onClose: vi.fn() });

    await fireEvent.input(await screen.findByLabelText(en.frameleaf_libraries_remove_confirm_name), {
      target: { value: 'Family photo archive' },
    });
    await fireEvent.click(screen.getByLabelText(ack(42)));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_remove }));

    expect(sdkMock.removeLibrary).toHaveBeenCalledWith({
      id: 'lib-1',
      libraryRemovalDto: { reviewToken: 'token-1', confirmName: 'Family photo archive' },
    });
    expect(onRemoved).toHaveBeenCalled();
  });

  it('refuses a name that does not match', async () => {
    sdkMock.getLibraryRemovalReview.mockResolvedValue(review());
    render(LibraryRemoveDialog, { libraryId: 'lib-1', onRemoved: vi.fn(), onClose: vi.fn() });

    await fireEvent.input(await screen.findByLabelText(en.frameleaf_libraries_remove_confirm_name), {
      target: { value: 'family photo archive' },
    });
    await fireEvent.click(screen.getByLabelText(ack(42)));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_remove }));

    expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_libraries_remove_name_mismatch);
    expect(sdkMock.removeLibrary).not.toHaveBeenCalled();
  });

  it('reviews again when the library changed after the review', async () => {
    const onRemoved = vi.fn();
    sdkMock.getLibraryRemovalReview
      .mockResolvedValueOnce(review())
      .mockResolvedValueOnce(review({ total: 50, photos: 48, reviewToken: 'token-2' }));
    sdkMock.removeLibrary.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { status: 409 }));
    render(LibraryRemoveDialog, { libraryId: 'lib-1', onRemoved, onClose: vi.fn() });

    await fireEvent.input(await screen.findByLabelText(en.frameleaf_libraries_remove_confirm_name), {
      target: { value: 'Family photo archive' },
    });
    await fireEvent.click(screen.getByLabelText(ack(42)));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_remove }));

    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_libraries_remove_stale);
    // the new consequences must be acknowledged again
    await waitFor(() => expect(screen.getByLabelText(ack(50))).not.toBeChecked());
    expect(screen.getByRole('button', { name: en.frameleaf_libraries_remove })).toBeDisabled();
    expect(onRemoved).not.toHaveBeenCalled();
    expect(sdkMock.getLibraryRemovalReview).toHaveBeenCalledTimes(2);
  });
});
