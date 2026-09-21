import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
import { AssetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { assetFactory, timelineAssetFactory } from '@test-data/factories/asset-factory';

vi.mock('@immich/sdk', async (original) => ({ ...(await original<object>()), getAssetInfo: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: true, user: { id: 'owner-a' }, params: {} },
}));

const restrictions = [
  ['lock', () => eventManager.emit('SessionLocked')],
  ['PIN reset', () => eventManager.emit('UserPinCodeReset')],
  ['access restriction', () => eventManager.emit('SessionAccessChanged', { isElevated: false })],
  ['logout', () => eventManager.emit('AuthLogout')],
  ['session deletion', () => eventManager.emit('SessionDelete')],
  [
    'account change',
    () => {
      authManager.user.id = 'owner-b';
      eventManager.emit('AuthUserLoaded', authManager.user);
    },
  ],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  authManager.user.id = 'owner-reset';
  eventManager.emit('AuthUserLoaded', authManager.user);
  authManager.user.id = 'owner-a';
  eventManager.emit('AuthUserLoaded', authManager.user);
});

it.each(restrictions)(
  'clears viewer/selection evidence on %s and rejects late viewer completion',
  async (_name, revoke) => {
    const selection = new AssetMultiSelectManager();
    const asset = assetFactory.build();
    selection.selectAsset(timelineAssetFactory.build());
    selection.setAssetSelectionCandidates([timelineAssetFactory.build()]);
    assetViewerManager.setAsset(asset);
    assetViewerManager.setHighlightedFaces([
      {
        id: 'face',
        imageHeight: 10,
        imageWidth: 10,
        boundingBoxX1: 0,
        boundingBoxX2: 5,
        boundingBoxY1: 0,
        boundingBoxY2: 5,
      },
    ]);
    let resolve!: (asset: AssetResponseDto) => void;
    vi.mocked(getAssetInfo).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const afterLoad = vi.fn();
    const load = assetViewerManager.setAssetId('pending').then(afterLoad);
    const signal = vi.mocked(getAssetInfo).mock.calls[0][1]?.signal;
    revoke();
    expect(signal?.aborted).toBe(true);
    expect(assetViewerManager.asset).toBeUndefined();
    expect(assetViewerManager.isViewing).toBe(false);
    expect(assetViewerManager.highlightedFaces).toEqual([]);
    expect(selection.selectionActive).toBe(false);
    expect(selection.candidates).toEqual([]);
    resolve(asset);
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });
    expect(afterLoad).not.toHaveBeenCalled();
    expect(assetViewerManager.asset).toBeUndefined();
    selection.destroy();
  },
);

it('preserves active editor and selection on unlock or a same-account profile refresh', () => {
  const selection = new AssetMultiSelectManager();
  const asset = assetFactory.build();
  selection.selectAsset(timelineAssetFactory.build());
  assetViewerManager.setAsset(asset);
  assetViewerManager.openEditor();
  eventManager.emit('SessionAccessChanged', { isElevated: true });
  eventManager.emit('AuthUserLoaded', authManager.user);
  expect(assetViewerManager.asset?.id).toBe(asset.id);
  expect(assetViewerManager.isViewing).toBe(true);
  expect(assetViewerManager.isShowEditor).toBe(true);
  expect(selection.selectionActive).toBe(true);
  selection.destroy();
});

it('does not let an older viewer load overwrite a newer asset or reopen a closed viewer', async () => {
  let resolve!: (asset: AssetResponseDto) => void;
  vi.mocked(getAssetInfo).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const old = assetViewerManager.setAssetId('old');
  const current = assetFactory.build();
  assetViewerManager.setAsset(current);
  resolve(assetFactory.build({ id: 'old' }));
  await expect(old).rejects.toMatchObject({ name: 'AbortError' });
  expect(assetViewerManager.asset?.id).toBe(current.id);

  vi.mocked(getAssetInfo).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = assetViewerManager.setAssetId('closed');
  assetViewerManager.showAssetViewer(false);
  resolve(assetFactory.build({ id: 'closed' }));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(assetViewerManager.isViewing).toBe(false);
});

it('keeps a revoked viewer closed through later access events until an authenticated owner arrives', async () => {
  eventManager.emit('AuthLogout');
  eventManager.emit('SessionLocked');
  eventManager.emit('SessionAccessChanged', { isElevated: true });
  assetViewerManager.setAsset(assetFactory.build());
  await expect(assetViewerManager.setAssetId('private')).rejects.toMatchObject({ name: 'AbortError' });
  expect(getAssetInfo).not.toHaveBeenCalled();
  expect(assetViewerManager.asset).toBeUndefined();
  eventManager.emit('AuthUserLoaded', authManager.user);
  assetViewerManager.setAsset(assetFactory.build());
  expect(assetViewerManager.isViewing).toBe(true);
});
