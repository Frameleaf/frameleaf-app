import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages, init, locale } from 'svelte-i18n';
import { clampPoint, moveCorner, moveQuad, sameAsExisting } from '$lib/frameleaf/scan-split';
import en from '../../../../i18n/en.json';
import ScanSplitSheet from './ScanSplitSheet.svelte';

// The generated SDK is regenerated after this PR; until then these two are not in it, so `sdkMock` cannot mock them.
const sdk = vi.hoisted(() => ({ detectScanPrints: vi.fn(), splitScan: vi.fn() }));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  ...sdk,
  isHttpError: (error: { status?: number }) => error?.status !== undefined,
}));

const size = { width: 1000, height: 800 };
const quad = (left: number, top: number) => [
  { x: left, y: top },
  { x: left + 200, y: top },
  { x: left + 200, y: top + 200 },
  { x: left, y: top + 200 },
];
const asset = { id: 'scan', originalFileName: 'Scan 014.jpg', thumbhash: null };
const firstSplit = {
  width: 1000,
  height: 800,
  crops: [],
  cropCount: 0,
  editedCount: 0,
  sourceAssetId: null,
  sourceFileName: null,
};
const found = (count: number) => ({
  ...size,
  prints: Array.from({ length: count }, (_, index) => ({
    quad: quad(100 + index * 300, 100),
    rotation: 0,
    confidence: 0.9,
  })),
});

const show = (info: object = firstSplit) => {
  const onClose = vi.fn();
  render(ScanSplitSheet, { props: { asset, info, onClose } as never });
  return onClose;
};
const sent = () => sdk.splitScan.mock.calls[0][0].scanSplitDto.crops;

beforeAll(async () => {
  addMessages('en', en);
  await init({ fallbackLocale: 'en' });
  await locale.set('en');
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => {
  sdk.detectScanPrints.mockReset();
  sdk.splitScan.mockReset().mockResolvedValue(undefined);
});

describe('ScanSplitSheet', () => {
  it('sends the detected prints with a nudged corner and a turn', async () => {
    sdk.detectScanPrints.mockResolvedValue(found(2));
    show();
    const corner = await screen.findByRole('button', { name: /Photo 1, top left corner/ });
    await fireEvent.keyDown(corner, { key: 'ArrowRight' });
    await fireEvent.click(screen.getByRole('button', { name: 'Rotate photo 2 by 90°' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Split into 2 photos' }));
    await waitFor(() => expect(sdk.splitScan).toHaveBeenCalledTimes(1));
    expect(sent()[0].quad[0]).toEqual({ x: 105, y: 100 });
    expect(sent()[1].rotation).toBe(90);
  });

  it('removes a print and adds one, and the button follows the count', async () => {
    sdk.detectScanPrints.mockResolvedValue(found(2));
    show();
    await fireEvent.click(await screen.findByRole('button', { name: 'Remove photo 1' }));
    expect(screen.getByRole('button', { name: 'Split into 1 photo' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Add a photo' }));
    expect(screen.getByText('Added by you')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Split into 2 photos' }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1].quad[0]).toEqual({ x: 400, y: 320 });
  });

  it('offers drawing or keeping one photo when nothing is found', async () => {
    sdk.detectScanPrints.mockResolvedValue(found(0));
    const onClose = show();
    expect(await screen.findByText('No separate photos found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Draw around a photo' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Keep as one photo' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(undefined));
    expect(sdk.splitScan).not.toHaveBeenCalled();
  });

  it('says plainly when no ML worker can look, and still allows drawing', async () => {
    sdk.detectScanPrints.mockRejectedValue({ status: 503 });
    show();
    expect(await screen.findByText(/machine learning service/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Draw around a photo' })).toBeInTheDocument();
  });

  it('warns before splitting again, truthfully, and starts from the saved outlines', async () => {
    show({
      ...firstSplit,
      cropCount: 2,
      editedCount: 1,
      crops: [
        { assetId: 'a', quad: quad(100, 100), rotation: 0, createdAt: '2026-11-22T00:00:00.000Z', edited: true },
        { assetId: 'b', quad: quad(400, 100), rotation: 0, createdAt: '2026-11-22T00:00:00.000Z', edited: false },
      ],
    });
    expect(await screen.findByText(/replaces the 2 photos made earlier/)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('1 of the 2 has been edited');
    expect(screen.getByRole('note')).toHaveTextContent('do not move to the new photos');
    expect(sdk.detectScanPrints).not.toHaveBeenCalled();
    // nothing changed yet, so there is nothing to split
    expect(screen.getByRole('button', { name: 'Split again into 2 photos' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Rotate photo 1 by 90°' }));
    expect(screen.getByRole('button', { name: 'Split again into 2 photos' })).toBeEnabled();
  });

  it('keeps the sheet open with a message when the split is refused', async () => {
    sdk.detectScanPrints.mockResolvedValue(found(1));
    sdk.splitScan.mockRejectedValue({ status: 400, data: { message: 'Quota has been exceeded!' } });
    const onClose = show();
    await fireEvent.click(await screen.findByRole('button', { name: 'Split into 1 photo' }));
    expect(await screen.findByText(/enough storage/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('scan geometry', () => {
  it('keeps a corner inside the scan', () => {
    expect(clampPoint({ x: -5, y: 900 }, size)).toEqual({ x: 0, y: 800 });
    expect(moveCorner(quad(0, 0), 0, { x: -40, y: -40 }, size)[0]).toEqual({ x: 0, y: 0 });
  });

  it('stops a moved outline at the edge without changing its shape', () => {
    expect(moveQuad(quad(0, 0), -50, 10, size)[1]).toEqual({ x: 200, y: 10 });
    expect(moveQuad(quad(700, 500), 500, 500, size)[2]).toEqual({ x: 1000, y: 800 });
  });

  it('does not treat outlines as unchanged when a Locked photo is not listed', () => {
    const print = { id: 'a', quad: quad(0, 0), rotation: 0 };
    expect(sameAsExisting([print], [{ quad: quad(0, 0), rotation: 0 }], 1)).toBe(true);
    expect(sameAsExisting([print], [{ quad: quad(0, 0), rotation: 0 }], 2)).toBe(false);
  });
});
