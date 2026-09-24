import type { AssetResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LibraryWorkInspector from '$lib/components/frameleaf/LibraryWorkInspector.svelte';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const detailOf = (id: string, patch: Partial<AssetResponseDto> = {}) =>
  ({
    id,
    ownerId: 'someone-else',
    originalFileName: 'IMG_0042.HEIC',
    width: 4032,
    height: 3024,
    exifInfo: {
      make: 'Apple',
      model: 'iPhone 15 Pro',
      city: 'Vancouver',
      state: 'British Columbia',
      country: 'Canada',
      dateTimeOriginal: '2026-09-20T14:05:00.000Z',
      timeZone: 'UTC',
      rating: null,
    },
    people: [
      { id: 'p1', name: 'Taylor', isHidden: false },
      { id: 'p2', name: '', isHidden: false },
    ],
    tags: [{ id: 't1', value: 'Hikes' }],
    ...patch,
  }) as unknown as AssetResponseDto;

describe('LibraryWorkInspector', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('shows the selected item’s information from its full record', async () => {
    const asset = timelineAssetFactory.build({ isVideo: true, duration: 12_000 });
    sdkMock.getAssetInfo.mockResolvedValue(detailOf(asset.id));

    render(LibraryWorkInspector, { asset, selectedCount: 1, onOpen: vi.fn(), onClose: vi.fn() });

    expect(await screen.findByRole('heading', { name: 'IMG_0042.HEIC' })).toBeInTheDocument();
    expect(sdkMock.getAssetInfo).toHaveBeenCalledWith(expect.objectContaining({ id: asset.id }));
    // a timeline duration is milliseconds
    expect(screen.getAllByText('0:12').length).toBeGreaterThan(0);
    expect(screen.getByText('4,032 × 3,024')).toBeInTheDocument();
    expect(screen.getByText('Apple iPhone 15 Pro')).toBeInTheDocument();
    expect(screen.getByText('Vancouver, British Columbia, Canada')).toBeInTheDocument();
    // an unnamed person is not listed
    expect(screen.getByText('Taylor')).toBeInTheDocument();
    expect(screen.getByText('Hikes')).toBeInTheDocument();
    // someone else's item offers no rating
    expect(screen.queryByRole('group', { name: 'rating' })).not.toBeInTheDocument();
  });

  it('opens the item from its preview and closes the panel from its heading', async () => {
    const asset = timelineAssetFactory.build();
    sdkMock.getAssetInfo.mockResolvedValue(detailOf(asset.id));
    const onOpen = vi.fn();
    const onClose = vi.fn();

    render(LibraryWorkInspector, { asset, selectedCount: 1, onOpen, onClose });

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_work_inspector_open' }));
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_work_inspector_close' }));

    expect(onOpen).toHaveBeenCalledWith(asset);
    expect(onClose).toHaveBeenCalled();
  });

  it('lists the item’s people on the People tab', async () => {
    const asset = timelineAssetFactory.build();
    sdkMock.getAssetInfo.mockResolvedValue(detailOf(asset.id, { people: [] }));

    render(LibraryWorkInspector, { asset, selectedCount: 1, onOpen: vi.fn(), onClose: vi.fn() });
    await screen.findByRole('heading', { name: 'IMG_0042.HEIC' });
    await fireEvent.click(screen.getByRole('tab', { name: 'people' }));

    expect(screen.getByRole('tab', { name: 'people' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('frameleaf_work_inspector_no_people')).toBeInTheDocument();
  });

  it('asks for a selection when nothing is selected', () => {
    render(LibraryWorkInspector, { asset: null, selectedCount: 0, onOpen: vi.fn(), onClose: vi.fn() });

    expect(screen.getByText('frameleaf_work_inspector_empty')).toBeInTheDocument();
    expect(sdkMock.getAssetInfo).not.toHaveBeenCalled();
  });

  it('keeps the newest selection when an older answer arrives late', async () => {
    const first = timelineAssetFactory.build();
    const second = timelineAssetFactory.build();
    let answerFirst!: (value: AssetResponseDto) => void;
    sdkMock.getAssetInfo.mockImplementation(({ id }) =>
      id === first.id
        ? new Promise((resolve) => (answerFirst = resolve))
        : Promise.resolve(detailOf(second.id, { originalFileName: 'second.jpg' })),
    );

    const view = render(LibraryWorkInspector, { asset: first, selectedCount: 1, onOpen: vi.fn(), onClose: vi.fn() });
    await view.rerender({ asset: second, selectedCount: 1, onOpen: vi.fn(), onClose: vi.fn() });
    await screen.findByRole('heading', { name: 'second.jpg' });
    answerFirst(detailOf(first.id, { originalFileName: 'first.jpg' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'second.jpg' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'first.jpg' })).not.toBeInTheDocument();
  });
});
