import {
  ICloudReviewDifferenceField,
  ICloudReviewEffect,
  ICloudReviewGroup,
  type ICloudReviewPageResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import en from '$i18n/en.json';
import ICloudReview from '$lib/components/frameleaf/ICloudReview.svelte';

const mocks = vi.hoisted(() => ({ getICloudReview: vi.fn(), acceptICloudReview: vi.fn(), goto: vi.fn() }));

vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/user-settings?review=x') } }));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  getICloudReview: mocks.getICloudReview,
  acceptICloudReview: mocks.acceptICloudReview,
}));

const id = '00000000-0000-4000-8000-0000000000aa';
const resource = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const asset = '00000000-0000-4000-8000-0000000000bb';
const item = (n: number, effect = ICloudReviewEffect.KeepCurrent) => ({
  resourceId: resource(n),
  group: ICloudReviewGroup.Details,
  effect,
  reason: 'source_metadata_conflict',
  fileName: `IMG_${n}.HEIC`,
  takenAt: '2026-08-01T10:00:00.000Z',
  previewAssetId: n === 1 ? asset : null,
  icloudAssetId: n === 1 ? asset : null,
  relatedAssetIds: [],
  differences:
    n === 1
      ? [
          {
            field: ICloudReviewDifferenceField.DateTaken,
            icloud: '2026-08-01T10:00:00.000Z',
            library: '2026-08-02T10:00:00.000Z',
          },
        ]
      : [],
  fileSize: 2_100_000,
  camera: 'Apple iPhone 16 Pro',
});
const reviewPage = (over: Partial<ICloudReviewPageResponseDto> = {}): ICloudReviewPageResponseDto => ({
  total: 3,
  page: 1,
  pages: 1,
  size: 48,
  groups: [{ group: ICloudReviewGroup.Details, count: 3 }],
  effects: { useExisting: 0, keepCurrent: 2, tryAgain: 1 },
  privateWaiting: 0,
  hiddenLocked: 2,
  items: [item(1, ICloudReviewEffect.TryAgain), item(2), item(3)],
  ...over,
});
const accepted = () => mocks.acceptICloudReview.mock.calls.at(-1)?.[0].iCloudReviewAcceptDto;

describe('ICloudReview', () => {
  beforeAll(async () => {
    register('en', () => Promise.resolve(en));
    await init({ fallbackLocale: 'en', initialLocale: 'en' });
    await waitLocale('en');
    HTMLDialogElement.prototype.showModal ??= vi.fn();
    HTMLDialogElement.prototype.close ??= vi.fn();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getICloudReview.mockResolvedValue(reviewPage());
    mocks.acceptICloudReview.mockResolvedValue({ accepted: 2, requeued: 0 });
  });

  it('shows placeholders while it reads, a failed read in place, and then the photos (FL-1810)', async () => {
    mocks.getICloudReview.mockRejectedValueOnce(new Error('offline'));
    render(ICloudReview, { connectionId: id, onBack: vi.fn() });

    expect(screen.getByTestId('frameleaf-grid-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Loading')).not.toBeInTheDocument();
    await screen.findByTestId('frameleaf-inline-error');
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'IMG_1.HEIC: Details changed' });
    expect(screen.queryByTestId('frameleaf-inline-error')).not.toBeInTheDocument();
  });

  const show = async () => {
    render(ICloudReview, { connectionId: id, onBack: vi.fn() });
    await screen.findByRole('button', { name: 'IMG_1.HEIC: Details changed' });
  };

  it('accepts the page without the photos marked Later', async () => {
    await show();
    await fireEvent.click(screen.getByRole('button', { name: 'Leave IMG_2.HEIC for later' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Accept this page (2)' }));
    await waitFor(() => expect(mocks.acceptICloudReview).toHaveBeenCalled());
    expect(accepted()).toEqual({ resourceIds: [resource(1), resource(3)] });
  });

  it('says what accept all will do and leaves Later photos out', async () => {
    await show();
    await fireEvent.click(screen.getByRole('button', { name: 'Leave IMG_2.HEIC for later' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Accept all (2)' }));
    expect(await screen.findByText('is copied from iCloud again')).toBeInTheDocument();
    expect(screen.getByText('keeps your library version')).toBeInTheDocument();
    await fireEvent.click(await screen.findByRole('button', { name: 'Accept 2 photos' }));
    await waitFor(() => expect(mocks.acceptICloudReview).toHaveBeenCalled());
    expect(accepted()).toEqual({ all: true, exceptResourceIds: [resource(2)] });
  });

  it('compares the iCloud copy with the library, says what differs and what Accept does, and accepts with the keyboard', async () => {
    await show();
    await fireEvent.click(screen.getByRole('button', { name: 'IMG_1.HEIC: Details changed' }));
    const viewer = await screen.findByRole('dialog', { name: 'IMG_1.HEIC' });
    expect(viewer).toHaveTextContent(en.frameleaf_icloud_review_in_icloud);
    expect(viewer).toHaveTextContent(en.frameleaf_icloud_review_in_library);
    expect(viewer).toHaveTextContent(en.frameleaf_icloud_review_why_details);
    expect(viewer).toHaveTextContent(en.frameleaf_icloud_review_accept_details);
    expect(viewer).toHaveTextContent(en.frameleaf_icloud_review_later_effect);
    expect(screen.getByRole('row', { name: /Date taken/ })).toHaveTextContent(/Aug 1, 2026.*Aug 2, 2026/);
    expect(viewer).toHaveTextContent('Apple iPhone 16 Pro');
    await fireEvent.keyDown(globalThis as unknown as Window, { key: 'a' });
    await waitFor(() => expect(accepted()).toEqual({ resourceIds: [resource(1)] }));
  });

  it('says when a photo could not be accepted because it is still syncing', async () => {
    mocks.acceptICloudReview.mockResolvedValue({ accepted: 2, requeued: 0 });
    await show();
    await fireEvent.click(screen.getByRole('button', { name: 'Accept this page (3)' }));
    expect(await screen.findByRole('status')).toHaveTextContent('1 is still syncing');
  });
});
