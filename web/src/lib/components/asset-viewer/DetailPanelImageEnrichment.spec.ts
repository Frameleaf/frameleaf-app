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
} from '@frameleaf/sdk';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import DetailPanelImageEnrichment from './DetailPanelImageEnrichment.svelte';

vi.mock('@frameleaf/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@frameleaf/sdk')>('@frameleaf/sdk');
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

  it('ignores an action result that lands after the viewer moved to another photo', async () => {
    const first = assetFactory.build({ type: AssetTypeEnum.Image });
    const second = assetFactory.build({ type: AssetTypeEnum.Image });
    let resolveAction!: (value: AssetImageEnrichmentResponseDto) => void;
    vi.mocked(getAssetImageEnrichment).mockImplementation(({ id }) => Promise.resolve(enrichmentFactory(id, false)));
    vi.mocked(updateAssetImageEnrichment).mockReturnValue(
      new Promise((resolve) => (resolveAction = resolve)) as ReturnType<typeof updateAssetImageEnrichment>,
    );

    const view = renderWithTooltips(DetailPanelImageEnrichment, { asset: first, isOwner: true });
    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_info_mark_sensitive' }));
    // renderWithTooltips mounts a wrapper, so the panel's props travel as componentProps.
    await view.rerender({
      component: DetailPanelImageEnrichment,
      componentProps: { asset: second, isOwner: true },
    } as never);
    await waitFor(() => expect(getAssetImageEnrichment).toHaveBeenCalledWith({ id: second.id }, expect.anything()));
    await screen.findByRole('button', { name: 'frameleaf_info_mark_sensitive' });

    resolveAction(enrichmentFactory(first.id, true));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByRole('button', { name: 'frameleaf_info_unmark_sensitive' })).toBeNull();
    expect(getAssetInfo).not.toHaveBeenCalled();
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

  // FL-707 item 13: one status for the sensitive-content check, and the description shown once.
  describe('one status, one description (FL-707 item 13)', () => {
    it('says "Not checked" once, in the pill', async () => {
      const asset = assetFactory.build({ type: AssetTypeEnum.Image });
      vi.mocked(getAssetImageEnrichment).mockResolvedValue({
        ...enrichmentFactory('asset', false),
        nsfwDetection: { status: Status2.Missing, effectiveIsNsfw: false, appliedTags: false },
      });

      renderWithTooltips(DetailPanelImageEnrichment, { asset, isOwner: true });

      expect(await screen.findByTestId('frameleaf-sensitivity-state')).toHaveTextContent(
        'frameleaf_info_sensitivity_missing',
      );
      expect(screen.getByRole('heading', { name: 'frameleaf_info_sensitive_content' })).toBeInTheDocument();
      expect(screen.queryByText(/frameleaf_info_not_checked/)).toBeNull();
      expect(screen.queryByTestId('frameleaf-sensitivity-detail')).toBeNull();
    });

    it('puts the description evidence under the editor it is given, with no "No description" row', async () => {
      const asset = assetFactory.build({ type: AssetTypeEnum.Image });
      vi.mocked(getAssetImageEnrichment).mockResolvedValue(enrichmentFactory('asset', false));

      renderWithTooltips(DetailPanelImageEnrichment, { asset, isOwner: true });

      const row = await screen.findByTestId('frameleaf-enrichment-description');
      expect(row).not.toHaveTextContent('frameleaf_info_description_none');
      expect(row).not.toHaveTextContent('frameleaf_info_description');
      expect(screen.queryByRole('heading', { name: 'frameleaf_info_enrichment' })).toBeNull();
    });
  });
});
