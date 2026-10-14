import { DocumentLineStatus, type DocumentLineDto, type DocumentResponseDto } from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import DocumentTextSection from '$lib/components/frameleaf/DocumentTextSection.svelte';
import { DOCUMENT_REREAD_POLL_MS } from '$lib/frameleaf/documents';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import { ocrManager } from '$lib/stores/ocr.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import en from '../../../../../i18n/en.json';

/**
 * FL-63 / FL-83: "Text in this photo" — Copy text puts the readable lines on the clipboard, and the
 * regions switch draws or hides the recognized boxes over the photo.
 */

const line = (id: string, text: string, status = DocumentLineStatus.Recognized): DocumentLineDto => ({
  confidence: 0.95,
  editId: null,
  evidenceChanged: false,
  id,
  ocrId: id,
  recognizedText: text,
  region: null,
  revision: null,
  status,
  text,
});

const asset = assetFactory.build({ id: 'asset-1' });
const document = (): DocumentResponseDto => ({
  assetId: 'asset-1',
  canEdit: false,
  fields: [],
  fieldsEnabled: false,
  lines: [line('a', 'RECEIPT'), line('b', 'hidden', DocumentLineStatus.Dismissed), line('c', 'Total 12.50')],
  recognition: null,
  recognizedAt: '2026-09-20T10:00:00.000Z',
});

describe('DocumentTextSection', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.resetAllMocks();
    ocrManager.clear();
    sdkMock.getDocument.mockResolvedValue(document());
    vi.spyOn(toastManager, 'primary').mockImplementation(() => {});
    vi.spyOn(toastManager, 'info').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('copies the readable text, one line per line', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(DocumentTextSection, { asset });

    await user.click(await screen.findByRole('button', { name: en.frameleaf_documents_copy_text }));

    expect(writeText).toHaveBeenCalledWith('RECEIPT\nTotal 12.50');
    expect(toastManager.primary).toHaveBeenCalledWith(en.frameleaf_documents_copied);
  });

  it('falls back to selecting the text when the clipboard refuses', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    render(DocumentTextSection, { asset });

    await user.click(await screen.findByRole('button', { name: en.frameleaf_documents_copy_text }));

    expect(toastManager.info).toHaveBeenCalledWith(en.frameleaf_documents_copy_fallback);
    expect(getSelection()?.toString()).toContain('RECEIPT');
  });

  it('shows and hides the text regions over the photo', async () => {
    render(DocumentTextSection, { asset });
    const show = await screen.findByRole('button', { name: en.frameleaf_documents_show_regions });
    expect(show).toHaveAttribute('aria-pressed', 'false');
    expect(ocrManager.showOverlay).toBe(false);

    await userEvent.click(show);
    const hide = screen.getByRole('button', { name: en.frameleaf_documents_hide_regions });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    expect(ocrManager.showOverlay).toBe(true);

    await userEvent.click(hide);
    expect(screen.getByRole('button', { name: en.frameleaf_documents_show_regions })).toBeInTheDocument();
    expect(ocrManager.showOverlay).toBe(false);
  });

  it('replaces the displayed OCR boxes when Read again completes while keeping the overlay visible', async () => {
    const before = {
      ...document(),
      canEdit: true,
      lines: [line('old', 'Old')],
      recognition: { enabled: true, routed: true },
    };
    const after = { ...before, recognizedAt: '2026-10-14T12:00:00.000Z', lines: [line('fresh', 'Fresh')] };
    sdkMock.getDocument.mockResolvedValueOnce(before).mockResolvedValue(after);
    const oldBox = {
      id: 'old',
      assetId: asset.id,
      text: 'Old',
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 0,
      x3: 1,
      y3: 1,
      x4: 0,
      y4: 1,
      boxScore: 0.9,
      textScore: 0.8,
    };
    sdkMock.getAssetOcr.mockResolvedValueOnce([oldBox]).mockResolvedValue([{ ...oldBox, id: 'fresh', text: 'Fresh' }]);
    assetCacheManager.clearOcrCache();
    await ocrManager.getAssetOcr(asset.id);
    render(DocumentTextSection, { asset });
    const readAgain = await screen.findByRole('button', { name: en.frameleaf_documents_read_again });
    await userEvent.click(screen.getByRole('button', { name: en.frameleaf_documents_show_regions }));
    vi.useFakeTimers();
    try {
      await fireEvent.click(readAgain);
      await vi.advanceTimersByTimeAsync(DOCUMENT_REREAD_POLL_MS);
      expect(ocrManager.data.map(({ id, text }) => [id, text])).toEqual([['fresh', 'Fresh']]);
      expect(ocrManager.showOverlay).toBe(true);
      expect(sdkMock.getAssetOcr).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      ocrManager.clear();
      assetCacheManager.clearOcrCache();
    }
  });
});
