import {
  AssetEditAction,
  AssetTypeEnum,
  Profile,
  Purpose,
  Status,
  exportVideoEditVersion,
  getVideoEditVersions,
  removeAssetEdits,
  restoreVideoEditVersion,
  type VideoEditVersionResponseDto,
} from '@immich/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { websocketEvents } from '$lib/stores/websocket';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import VideoVersionControls from './VideoVersionControls.svelte';

vi.mock('@immich/sdk', async () => ({
  ...(await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk')),
  getVideoEditVersions: vi.fn(),
  exportVideoEditVersion: vi.fn(),
  restoreVideoEditVersion: vi.fn(),
  removeAssetEdits: vi.fn(),
  getBaseUrl: () => '/api',
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { params: {} } }));
vi.mock('$lib/managers/event-manager.svelte', () => ({ eventManager: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('$lib/stores/websocket', () => ({ websocketEvents: { on: vi.fn() } }));

const { modalShow } = vi.hoisted(() => ({ modalShow: vi.fn() }));
vi.mock('@immich/ui', async () => ({
  ...(await vi.importActual<typeof import('@immich/ui')>('@immich/ui')),
  modalManager: { show: modalShow },
}));

const asset = assetFactory.build({ type: AssetTypeEnum.Video, isEdited: true });
const version = (overrides: Partial<VideoEditVersionResponseDto> = {}): VideoEditVersionResponseDto => ({
  id: 'current',
  assetId: asset.id,
  createdAt: '2026-09-21T00:00:00Z',
  edits: [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }],
  purpose: Purpose.Save,
  status: Status.Ready,
  isCurrent: true,
  isRequested: true,
  ...overrides,
});
const unsubscribe = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVideoEditVersions).mockResolvedValue([version()]);
  vi.mocked(websocketEvents.on).mockReturnValue(unsubscribe);
});

it('queues a separate master export and exposes its ready download', async () => {
  const view = renderWithTooltips(VideoVersionControls, { asset, hasUnsavedChanges: false, onRestore: vi.fn() });
  const button = await view.findByRole('button', { name: 'editor_video_export_master' });
  await waitFor(() => expect(button).toBeEnabled());
  vi.mocked(getVideoEditVersions).mockResolvedValue([
    version(),
    version({ id: 'export', purpose: Purpose.Export, isCurrent: false, isRequested: false }),
  ]);
  await fireEvent.click(button);
  await waitFor(() =>
    expect(exportVideoEditVersion).toHaveBeenCalledWith({
      id: asset.id,
      videoEditExportDto: { profile: Profile.Master },
    }),
  );
  await fireEvent.click(view.getByText('editor_video_versions', { selector: 'summary' }));
  await waitFor(() =>
    expect(
      view
        .getAllByRole('link', { name: 'download' })
        .some((link) => link.getAttribute('href') === `/api/assets/${asset.id}/edit-versions/export/download?`),
    ).toBe(true),
  );
  expect(restoreVideoEditVersion).not.toHaveBeenCalled();
});

it.each([
  { dirty: true, versions: [version()] },
  { dirty: false, versions: [] },
  { dirty: false, versions: [version(), version({ id: 'pending', isCurrent: false, status: Status.Pending })] },
])('blocks export without a settled saved recipe: %j', async ({ dirty, versions }) => {
  vi.mocked(getVideoEditVersions).mockResolvedValue(versions);
  const view = renderWithTooltips(VideoVersionControls, { asset, hasUnsavedChanges: dirty, onRestore: vi.fn() });
  await waitFor(() => expect(getVideoEditVersions).toHaveBeenCalled());
  expect(view.getByRole('button', { name: 'editor_video_export_master' })).toBeDisabled();
});

it('restores selected history through its original-derived recipe endpoint', async () => {
  vi.mocked(getVideoEditVersions).mockResolvedValue([version({ id: 'older', isCurrent: false, isRequested: false })]);
  const onRestore = vi.fn();
  const view = renderWithTooltips(VideoVersionControls, { asset, hasUnsavedChanges: false, onRestore });
  await fireEvent.click(view.getByText('editor_video_versions', { selector: 'summary' }));
  const button = await view.findByRole('button', { name: 'restore' });
  await fireEvent.click(button);
  await waitFor(() => expect(restoreVideoEditVersion).toHaveBeenCalledWith({ id: asset.id, versionId: 'older' }));
  expect(onRestore).toHaveBeenCalledOnce();
});

it('reverts to the original but preserves a dirty draft when confirmation is canceled', async () => {
  const confirm = modalShow.mockResolvedValue(false);
  const view = renderWithTooltips(VideoVersionControls, { asset, hasUnsavedChanges: true, onRestore: vi.fn() });
  const button = await view.findByRole('button', { name: 'editor_video_revert_original' });
  await waitFor(() => expect(button).toBeEnabled());
  await fireEvent.click(button);
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(removeAssetEdits).not.toHaveBeenCalled();
  confirm.mockResolvedValue(true);
  await fireEvent.click(button);
  await waitFor(() => expect(removeAssetEdits).toHaveBeenCalledWith({ id: asset.id }));
  confirm.mockReset();
});

it('recovers a failed history read through explicit refresh and releases its event subscription', async () => {
  vi.mocked(getVideoEditVersions).mockRejectedValueOnce(new Error('offline'));
  const view = renderWithTooltips(VideoVersionControls, { asset, hasUnsavedChanges: false, onRestore: vi.fn() });
  expect(await view.findByRole('alert')).toHaveTextContent('editor_video_versions_error');
  expect(view.getByRole('button', { name: 'editor_video_export_master' })).toBeDisabled();
  await fireEvent.click(view.getByText('editor_video_versions', { selector: 'summary' }));
  await fireEvent.click(view.getByRole('button', { name: 'refresh' }));
  await waitFor(() => expect(view.queryByRole('alert')).not.toBeInTheDocument());
  expect(view.getByRole('button', { name: 'editor_video_export_master' })).toBeEnabled();
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('refreshes only for this asset completion and unsubscribes on unmount', async () => {
  const view = renderWithTooltips(VideoVersionControls, { asset, hasUnsavedChanges: false, onRestore: vi.fn() });
  await waitFor(() => expect(getVideoEditVersions).toHaveBeenCalledOnce());
  const listener = vi.mocked(websocketEvents.on).mock.calls[0][1] as (event: { asset: { id: string } }) => void;
  listener({ asset: { id: 'another-asset' } });
  expect(getVideoEditVersions).toHaveBeenCalledOnce();
  listener({ asset: { id: asset.id } });
  await waitFor(() => expect(getVideoEditVersions).toHaveBeenCalledTimes(2));
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
