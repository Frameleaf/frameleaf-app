import { updateAsset } from '@immich/sdk';
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { DescriptionReview } from '$lib/frameleaf/info-panel';
import { assetFactory } from '@test-data/factories/asset-factory';
import DetailPanelDescription from './DetailPanelDescription.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return { ...sdk, updateAsset: vi.fn(), getAssetInfo: vi.fn() };
});

describe('DetailPanelDescription', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('clears unsaved draft on asset change', async () => {
    const user = userEvent.setup();

    const assetA = assetFactory.build({
      id: 'asset-a',
      exifInfo: { description: '' },
    });
    const assetB = assetFactory.build({
      id: 'asset-b',
      exifInfo: { description: '' },
    });

    const { rerender } = render(DetailPanelDescription, {
      props: {
        asset: assetA,
        isOwner: true,
      },
    });

    const textarea = screen.getByTestId('autogrow-textarea') as HTMLTextAreaElement;
    await user.type(textarea, 'unsaved draft');
    expect(textarea).toHaveValue('unsaved draft');

    await rerender({
      asset: assetB,
      isOwner: true,
    });

    expect(screen.getByTestId('autogrow-textarea')).toHaveValue('');
  });

  it('updates description on asset switch', async () => {
    const assetA = assetFactory.build({
      id: 'asset-a',
      exifInfo: { description: 'first description' },
    });
    const assetB = assetFactory.build({
      id: 'asset-b',
      exifInfo: { description: 'second description' },
    });

    const { rerender } = render(DetailPanelDescription, {
      props: {
        asset: assetA,
        isOwner: true,
      },
    });

    expect(screen.getByTestId('autogrow-textarea')).toHaveValue('first description');

    await rerender({
      asset: assetB,
      isOwner: true,
    });

    expect(screen.getByTestId('autogrow-textarea')).toHaveValue('second description');
  });

  // FL-36: an inline edit reports its own failure and offers only the recovery that can work.
  const typeAndBlur = async (value: string) => {
    const user = userEvent.setup();
    const textarea = screen.getByTestId('autogrow-textarea');
    await user.type(textarea, value);
    await user.tab();
  };

  it('offers a retry when the save never reached a verdict', async () => {
    vi.mocked(updateAsset).mockRejectedValue({ status: 503, data: { statusCode: 503, message: 'unavailable' } });

    render(DetailPanelDescription, {
      props: { asset: assetFactory.build({ exifInfo: { description: '' } }), isOwner: true },
    });

    await typeAndBlur('a lake at dusk');

    await waitFor(() => expect(screen.getByText('frameleaf_info_error_network')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'frameleaf_info_retry' })).toBeInTheDocument();
    // The typed value is kept so the retry replays it rather than an empty description.
    expect(screen.getByTestId('autogrow-textarea')).toHaveValue('a lake at dusk');
  });

  it('does not offer a retry for a change the user is not allowed to make', async () => {
    vi.mocked(updateAsset).mockRejectedValue({ status: 403, data: { statusCode: 403, message: 'forbidden' } });

    render(DetailPanelDescription, {
      props: { asset: assetFactory.build({ exifInfo: { description: '' } }), isOwner: true },
    });

    await typeAndBlur('a lake at dusk');

    await waitFor(() => expect(screen.getByText('frameleaf_info_error_forbidden')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'frameleaf_info_retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'frameleaf_info_reload' })).not.toBeInTheDocument();
  });

  it('offers a reload, and not a retry, when the asset changed somewhere else', async () => {
    vi.mocked(updateAsset).mockRejectedValue({ status: 404, data: { statusCode: 404, message: 'gone' } });

    render(DetailPanelDescription, {
      props: { asset: assetFactory.build({ exifInfo: { description: '' } }), isOwner: true },
    });

    await typeAndBlur('a lake at dusk');

    await waitFor(() => expect(screen.getByText('frameleaf_info_error_stale')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'frameleaf_info_reload' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'frameleaf_info_retry' })).not.toBeInTheDocument();
  });

  // FL-36 AI provenance (MediaViewer.jsx:2574-2592): the sparkle "AI" badge, or "Yours".
  describe('provenance badge', () => {
    const review = (overrides: Partial<DescriptionReview>): DescriptionReview => ({
      source: 'generated',
      status: 'success',
      modelName: 'vision-model',
      confidencePercent: 87,
      suggestion: null,
      canAccept: false,
      canClear: true,
      error: null,
      ...overrides,
    });
    const asset = assetFactory.build({ exifInfo: { description: 'A lake at dusk' } });

    it('marks an AI-written description with the model and confidence', () => {
      render(DetailPanelDescription, { props: { asset, isOwner: true, review: review({}) } });
      const badge = screen.getByTestId('frameleaf-description-provenance');
      expect(badge).toHaveClass('fl-provenance-ai');
      expect(badge).toHaveTextContent('frameleaf_info_description_ai');
      expect(badge).toHaveAttribute('title', 'frameleaf_info_written_by_ai · vision-model · frameleaf_info_confidence');
    });

    it('drops the confidence when none was reported', () => {
      render(DetailPanelDescription, {
        props: { asset, isOwner: true, review: review({ confidencePercent: null }) },
      });
      expect(screen.getByTestId('frameleaf-description-provenance')).toHaveAttribute(
        'title',
        'frameleaf_info_written_by_ai · vision-model',
      );
    });

    it('says "Yours" for a description the owner wrote, and nothing without one', async () => {
      const { rerender } = render(DetailPanelDescription, {
        props: { asset, isOwner: true, review: review({ source: 'manual' }) },
      });
      const badge = screen.getByTestId('frameleaf-description-provenance');
      expect(badge).not.toHaveClass('fl-provenance-ai');
      expect(badge).toHaveTextContent('frameleaf_info_description_yours');

      await rerender({ asset, isOwner: true, review: review({ source: 'none' }) });
      expect(screen.queryByTestId('frameleaf-description-provenance')).toBeNull();
    });
  });
});
