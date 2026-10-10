import { render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import DetailPanelCameraIdentification from './DetailPanelCameraIdentification.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { isSharedLink: false } }));

const value = {
  version: 1,
  recorded: { make: 'A', model: 'Original camera', source: 'original', modelTag: 'Model' },
  alternatives: [{ make: 'B', model: 'Sidecar camera', source: 'sidecar', modelTag: 'CameraModel' }],
  suggestion: { method: 'jpeg-signature', signature: 'digest', matches: 'Camera A, Camera B or editor' },
};
const metadata = (evidence = value) => [
  { key: 'camera-identification', value: evidence, updatedAt: '2026-10-02T00:00:00Z' },
];

describe('owner camera evidence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.assign(authManager, { isSharedLink: false });
    sdkMock.getAssetMetadata.mockResolvedValue(metadata());
  });
  it('shows source, conflict and explanatory clues as text', async () => {
    const asset = assetFactory.build();
    render(DetailPanelCameraIdentification, { asset, isOwner: true });
    expect(await screen.findByText('Original camera', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('frameleaf_camera_original', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('frameleaf_camera_conflict')).toBeInTheDocument();
    expect(screen.getByText('Camera A, Camera B or editor')).toBeInTheDocument();
    expect(screen.getByText('frameleaf_camera_encoding_caveat')).toBeInTheDocument();
    expect(sdkMock.getAssetMetadata).toHaveBeenCalledWith({ id: asset.id }, { signal: expect.any(AbortSignal) });
  });
  it.each([
    { isOwner: false, shared: false },
    { isOwner: true, shared: true },
  ])('does not fetch or expose evidence for %j', async ({ isOwner, shared }) => {
    Object.assign(authManager, { isSharedLink: shared });
    render(DetailPanelCameraIdentification, { asset: assetFactory.build(), isOwner });
    await Promise.resolve();
    expect(sdkMock.getAssetMetadata).not.toHaveBeenCalled();
    expect(screen.queryByTestId('camera-identification')).not.toBeInTheDocument();
  });
  it('hides malformed metadata', async () => {
    sdkMock.getAssetMetadata.mockResolvedValue([
      { key: 'camera-identification', value: { version: 1, recorded: 'invalid' }, updatedAt: '' },
    ]);
    render(DetailPanelCameraIdentification, { asset: assetFactory.build(), isOwner: true });
    await waitFor(() => expect(sdkMock.getAssetMetadata).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('camera-identification')).not.toBeInTheDocument();
  });
  it('cancels old fetches and ignores stale results after asset switching', async () => {
    let finish!: (items: ReturnType<typeof metadata>) => void;
    sdkMock.getAssetMetadata
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce([]);
    const asset = assetFactory.build({ id: 'old' });
    const { rerender } = render(DetailPanelCameraIdentification, { asset, isOwner: true });
    await waitFor(() => expect(sdkMock.getAssetMetadata).toHaveBeenCalledTimes(1));
    const signal = sdkMock.getAssetMetadata.mock.calls[0][1]?.signal;
    await rerender({ asset: assetFactory.build({ id: 'new' }), isOwner: true });
    await waitFor(() => expect(sdkMock.getAssetMetadata).toHaveBeenCalledTimes(2));
    expect(signal?.aborted).toBe(true);
    finish(metadata());
    await Promise.resolve();
    expect(screen.queryByText('Original camera', { exact: false })).not.toBeInTheDocument();
  });
  it('offers visible retry after a failed fetch', async () => {
    sdkMock.getAssetMetadata.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(metadata());
    render(DetailPanelCameraIdentification, { asset: assetFactory.build(), isOwner: true });
    await screen.findByRole('status');
    await fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(await screen.findByText('Original camera', { exact: false })).toBeInTheDocument();
  });
  it('hides loaded evidence when ownership or shared access changes', async () => {
    const asset = assetFactory.build();
    const { rerender } = render(DetailPanelCameraIdentification, { asset, isOwner: true });
    await screen.findByText('Original camera', { exact: false });
    await rerender({ asset, isOwner: false });
    expect(screen.queryByTestId('camera-identification')).not.toBeInTheDocument();
  });
});
