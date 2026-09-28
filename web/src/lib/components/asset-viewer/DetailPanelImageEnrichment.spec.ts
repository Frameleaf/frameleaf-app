import {
  AssetImageEnrichmentAction,
  AssetTypeEnum,
  getAssetImageEnrichment,
  getAssetInfo,
  isHttpError,
  Status,
  Status2,
  updateAssetImageEnrichment,
  type AssetImageEnrichmentResponseDto,
} from '@immich/sdk';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import DetailPanelImageEnrichment from './DetailPanelImageEnrichment.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return {
    ...sdk,
    getAssetImageEnrichment: vi.fn(),
    getAssetInfo: vi.fn(),
    isHttpError: vi.fn(),
    updateAssetImageEnrichment: vi.fn(),
  };
});

const enrichmentFactory = (assetId: string, effectiveIsNsfw: boolean): AssetImageEnrichmentResponseDto => ({
  assetId,
  description: {
    status: Status.Missing,
    appliedDescription: false,
    appliedTags: false,
  },
  nsfwDetection: {
    status: Status2.Success,
    effectiveIsNsfw,
    isNsfw: effectiveIsNsfw,
    score: effectiveIsNsfw ? 1 : 0,
    labels: {
      nsfw: effectiveIsNsfw ? 1 : 0,
      normal: effectiveIsNsfw ? 0 : 1,
    },
    appliedTags: false,
  },
});

describe('DetailPanelImageEnrichment', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('removes an asset from the current view when marking it NSFW hides it from the session', async () => {
    const asset = assetFactory.build({ type: AssetTypeEnum.Image });
    const onAssetSuppressed = vi.fn();
    const hiddenAssetError = { status: 400, data: { statusCode: 400 } };

    vi.mocked(getAssetImageEnrichment).mockResolvedValue(enrichmentFactory(asset.id, false));
    vi.mocked(updateAssetImageEnrichment).mockResolvedValue(enrichmentFactory(asset.id, true));
    vi.mocked(getAssetInfo).mockRejectedValue(hiddenAssetError);
    vi.mocked(isHttpError).mockImplementation((error) => error === hiddenAssetError);

    renderWithTooltips(DetailPanelImageEnrichment, {
      asset,
      isOwner: true,
      onAssetSuppressed,
    });

    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_info_mark_sensitive' }));

    await waitFor(() =>
      expect(updateAssetImageEnrichment).toHaveBeenCalledWith({
        id: asset.id,
        assetImageEnrichmentActionRequestDto: { action: AssetImageEnrichmentAction.MarkNsfw },
      }),
    );
    await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith({ id: asset.id }));
    expect(onAssetSuppressed).toHaveBeenCalledWith(asset);
  });

  // FL-36 AI provenance (MediaViewer.jsx:2608-2743): who wrote the description, how the check was made.
  describe('AI provenance', () => {
    const withDescription = (confidence: number | null): AssetImageEnrichmentResponseDto => ({
      ...enrichmentFactory('asset', false),
      description: {
        status: Status.Success,
        appliedDescription: true,
        appliedTags: false,
        description: 'A lake at dusk',
        modelName: 'vision-model',
        confidence,
      },
      nsfwDetection: {
        status: Status2.Success,
        effectiveIsNsfw: false,
        isNsfw: false,
        score: 0.12,
        modelName: 'nsfw-model',
        appliedTags: false,
      },
    });

    it('names the model and its confidence for an AI-written description', async () => {
      const asset = assetFactory.build({
        type: AssetTypeEnum.Image,
        exifInfo: { description: 'A lake at dusk' },
      });
      vi.mocked(getAssetImageEnrichment).mockResolvedValue(withDescription(0.87));

      renderWithTooltips(DetailPanelImageEnrichment, { asset, isOwner: true });

      const row = await screen.findByTestId('frameleaf-enrichment-description');
      expect(row).toHaveTextContent('frameleaf_info_written_by_ai · vision-model · frameleaf_info_confidence');
      expect(row.querySelector('.fl-enrich-icon.ai')).not.toBeNull();
    });

    it('leaves the confidence out when the server reported none', async () => {
      const asset = assetFactory.build({
        type: AssetTypeEnum.Image,
        exifInfo: { description: 'A lake at dusk' },
      });
      vi.mocked(getAssetImageEnrichment).mockResolvedValue(withDescription(null));

      renderWithTooltips(DetailPanelImageEnrichment, { asset, isOwner: true });

      const row = await screen.findByTestId('frameleaf-enrichment-description');
      expect(row).toHaveTextContent('frameleaf_info_written_by_ai · vision-model');
      expect(row).not.toHaveTextContent('frameleaf_info_confidence');
    });

    it('says an owner-written description was written by you', async () => {
      const asset = assetFactory.build({
        type: AssetTypeEnum.Image,
        exifInfo: { description: 'Grandma at the lake' },
      });
      vi.mocked(getAssetImageEnrichment).mockResolvedValue(withDescription(0.9));

      renderWithTooltips(DetailPanelImageEnrichment, { asset, isOwner: true });

      const row = await screen.findByTestId('frameleaf-enrichment-description');
      expect(row).toHaveTextContent('frameleaf_info_written_by_you');
      expect(row.querySelector('.fl-enrich-icon.ai')).toBeNull();
    });

    it('says how the sensitive-content check was made', async () => {
      const asset = assetFactory.build({ type: AssetTypeEnum.Image });
      vi.mocked(getAssetImageEnrichment).mockResolvedValue(withDescription(null));

      renderWithTooltips(DetailPanelImageEnrichment, { asset, isOwner: true });

      expect(await screen.findByTestId('frameleaf-sensitivity-detail')).toHaveTextContent(
        'frameleaf_info_checked_by_ai · nsfw-model · frameleaf_info_likely_sensitive',
      );
    });
  });
});
