import { AssetTypeEnum, AssetVisibility } from '@frameleaf/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ getAssetInfo: vi.fn(), getStudioProject: vi.fn(), getStudioRestoredVersion: vi.fn() }));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<object>()), ...sdk }));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn(async () => undefined) }));
vi.mock('$lib/utils/i18n', () => ({ getFormatter: vi.fn(async () => (key: string) => key) }));
vi.mock('$lib/utils', () => ({
  getAssetMediaUrl: vi.fn(),
  getAssetPlaybackUrl: vi.fn(),
  getStudioHdrVideoUrl: vi.fn(),
}));

const { load } = await import('./+page');
const projectId = '019c0000-0000-7000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-000000000001';
const asset = {
  id: assetId,
  type: AssetTypeEnum.Image,
  visibility: AssetVisibility.Timeline,
  isTrashed: false,
  originalFileName: 'authorized-image.png',
};
const open = (query: string) =>
  load({ url: new URL(`https://frameleaf.test/studio?${query}`) } as Parameters<typeof load>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  sdk.getStudioProject.mockResolvedValue({ envelope: { graph: { timeline: { items: [{ mediaId: assetId }] } } } });
  sdk.getAssetInfo.mockResolvedValue(asset);
});

describe('actual Studio route source bootstrap', () => {
  it('resolves stored project media before returning mount data without an assets query', async () => {
    const data = await open(`project=${projectId}`);
    expect(sdk.getStudioProject).toHaveBeenCalledWith({ id: projectId });
    expect(sdk.getAssetInfo).toHaveBeenCalledWith({ id: assetId });
    expect(data.assets).toEqual([asset]);
  });

  it('dedupes explicit handoff and stored graph references', async () => {
    const data = await open(`project=${projectId}&assets=${assetId.toUpperCase()}`);
    expect(data.assets).toEqual([asset]);
    expect(sdk.getAssetInfo).toHaveBeenCalledTimes(1);
    expect(data.unavailableAssetCount).toBe(0);
  });

  it('keeps overlapping project loads separate when the older lookup resolves last', async () => {
    const otherProject = '019c0000-0000-7000-8000-000000000002';
    const otherAsset = '00000000-0000-4000-8000-000000000002';
    let finish!: (value: unknown) => void;
    sdk.getStudioProject.mockImplementation(({ id }) =>
      id === projectId
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ envelope: { graph: { items: [{ mediaId: otherAsset }] } } }),
    );
    sdk.getAssetInfo.mockImplementation(async ({ id }) => ({ ...asset, id }));
    const older = open(`project=${projectId}`);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const newer = await open(`project=${otherProject}`);
    finish({ envelope: { graph: { items: [{ mediaId: assetId }] } } });
    const late = await older;
    expect(newer.projectId).toBe(otherProject);
    expect(newer.assets.map((a) => a.id)).toEqual([otherAsset]);
    expect(late.projectId).toBe(projectId);
    expect(late.assets.map((a) => a.id)).toEqual([assetId]);
  });

  it('does not query sources from a refused project or expose refused/Locked metadata', async () => {
    sdk.getStudioProject.mockRejectedValueOnce(new Error('403'));
    expect((await open(`project=${projectId}`)).assets).toEqual([]);
    expect(sdk.getAssetInfo).not.toHaveBeenCalled();
    sdk.getAssetInfo.mockRejectedValueOnce(new Error('404'));
    expect((await open(`project=${projectId}`)).assets).toEqual([]);
    sdk.getAssetInfo.mockResolvedValueOnce({
      ...asset,
      visibility: AssetVisibility.Locked,
      originalFileName: 'private-locked',
    });
    expect((await open(`project=${projectId}`)).assets).toEqual([]);
  });
});
