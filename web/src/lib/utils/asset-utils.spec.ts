import { AssetVisibility, updateAsset, type AssetResponseDto } from '@frameleaf/sdk';
import {
  canCopyImageToClipboard,
  copyAssetImageToClipboard,
  ignoreCancelledDownload,
  toggleArchive,
} from './asset-utils';

vi.mock('@frameleaf/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@frameleaf/sdk')>();
  return {
    ...actual,
    updateAsset: vi.fn(),
  };
});

describe('copy image to clipboard', () => {
  // This test is dubious, as it totally on the environment where the test is run which is mocked.
  it('should allow copy image to clipboard', () => {
    expect(canCopyImageToClipboard()).toEqual(true);
  });
});

describe('toggleArchive', () => {
  beforeEach(() => {
    vi.mocked(updateAsset).mockReset();
  });

  it('updates both isArchived and visibility when archiving', async () => {
    vi.mocked(updateAsset).mockResolvedValue({
      isArchived: true,
      visibility: AssetVisibility.Archive,
    } as AssetResponseDto);

    const asset = { id: '1', isArchived: false, visibility: AssetVisibility.Timeline } as AssetResponseDto;
    await toggleArchive(asset);

    expect(asset.isArchived).toBe(true);
    // regression: visibility must be refreshed so the timeline correctly excludes the archived asset
    expect(asset.visibility).toBe(AssetVisibility.Archive);
  });

  it('updates both isArchived and visibility when unarchiving', async () => {
    vi.mocked(updateAsset).mockResolvedValue({
      isArchived: false,
      visibility: AssetVisibility.Timeline,
    } as AssetResponseDto);

    const asset = { id: '1', isArchived: true, visibility: AssetVisibility.Archive } as AssetResponseDto;
    await toggleArchive(asset);

    expect(asset.isArchived).toBe(false);
    expect(asset.visibility).toBe(AssetVisibility.Timeline);
  });
});

describe('ignoreCancelledDownload', () => {
  it('settles quietly when the user cancels a download', async () => {
    const cancelled = Promise.reject(new DOMException('The download was cancelled', 'AbortError'));
    await expect(cancelled.catch(ignoreCancelledDownload)).resolves.toBeUndefined();
  });

  it('passes every other failure on', async () => {
    const failed = Promise.reject(new Error('network'));
    await expect(failed.catch(ignoreCancelledDownload)).rejects.toThrow('network');
  });
});

describe('copyAssetImageToClipboard (FL-83 AL-31)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the item as a PNG within the click, loading its preview inside the clipboard item', async () => {
    const write = vi.fn(() => Promise.resolve());
    const items: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(data: Record<string, unknown>) {
          items.push(data);
        }
      },
    );
    vi.stubGlobal('navigator', { ...navigator, clipboard: { write } });
    const created: HTMLImageElement[] = [];
    const RealImage = Image;
    vi.stubGlobal(
      'Image',
      class extends RealImage {
        constructor() {
          super();
          created.push(this);
        }
      },
    );

    await copyAssetImageToClipboard('asset-1');

    expect(write).toHaveBeenCalledTimes(1);
    expect(Object.keys(items[0])).toEqual(['image/png']);
    expect(items[0]['image/png']).toBeInstanceOf(Promise);
    expect(created[0].src).toContain('/assets/asset-1/thumbnail');
    expect(created[0].src).toContain('size=preview');
  });
});
