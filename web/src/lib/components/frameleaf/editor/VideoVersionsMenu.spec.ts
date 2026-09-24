import {
  AssetEditAction,
  AssetTypeEnum,
  exportVideoEditVersion,
  getVideoEditVersions,
  removeAssetEdits,
  restoreVideoEditVersion,
  VideoEditExportProfile,
  VideoEditVersionPurpose,
  VideoEditVersionStatus,
  type VideoEditVersionResponseDto,
} from '@immich/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { websocketEvents } from '$lib/stores/websocket';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import VideoVersionsMenu from './VideoVersionsMenu.svelte';

vi.mock('@immich/sdk', async () => ({
  ...(await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk')),
  getVideoEditVersions: vi.fn(),
  exportVideoEditVersion: vi.fn(),
  restoreVideoEditVersion: vi.fn(),
  removeAssetEdits: vi.fn(),
  getBaseUrl: () => '/api',
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { params: {} } }));
vi.mock('$lib/stores/websocket', () => ({ websocketEvents: { on: vi.fn() } }));

const { modalShow } = vi.hoisted(() => ({ modalShow: vi.fn() }));
vi.mock('@immich/ui', async () => ({
  ...(await vi.importActual<typeof import('@immich/ui')>('@immich/ui')),
  modalManager: { show: modalShow },
}));

const asset = assetFactory.build({ type: AssetTypeEnum.Video, isEdited: true });
const rotate = [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }];
const version = (overrides: Partial<VideoEditVersionResponseDto> = {}) =>
  ({
    id: 'current',
    assetId: asset.id,
    createdAt: '2026-09-21T00:00:00Z',
    edits: rotate,
    purpose: VideoEditVersionPurpose.Save,
    status: VideoEditVersionStatus.Ready,
    isCurrent: true,
    isRequested: true,
    ...overrides,
  }) as VideoEditVersionResponseDto;
const unsubscribe = vi.fn();
const render = (props: { hasUnsavedChanges?: boolean; draftKey?: string; onApply?: () => void } = {}) =>
  renderWithTooltips(VideoVersionsMenu, {
    asset,
    draftKey: props.draftKey ?? JSON.stringify(rotate),
    hasUnsavedChanges: props.hasUnsavedChanges ?? false,
    onApply: props.onApply ?? vi.fn(),
  });
const openMenu = async (view: ReturnType<typeof render>) => {
  const trigger = view.getByRole('button', { name: 'frameleaf_editor_tool_versions' });
  await fireEvent.click(trigger);
  return view.findByRole('menu', { name: 'editor_video_versions' });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVideoEditVersions).mockResolvedValue([version()]);
  vi.mocked(websocketEvents.on).mockReturnValue(unsubscribe);
});

it('opens as the prototype popover with Original and saved versions, checked by the draft', async () => {
  const view = render({ draftKey: '[{"parameters":{"angle":90},"action":"rotate"}]' });
  const trigger = view.getByRole('button', { name: 'frameleaf_editor_tool_versions' });
  expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await openMenu(view);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(view.getByRole('menuitemradio', { name: /frameleaf_editor_version_original/ })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // jsonb reorders parameter keys; the draft still matches the saved recipe.
  expect(await view.findByRole('menuitemradio', { name: /editor_video_saved_version/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await fireEvent.keyDown(view.getByRole('menu'), { key: 'Escape' });
  expect(view.queryByRole('menu')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it('labels the menu, groups the version choices and keeps notes outside the menu', async () => {
  const view = render();
  const trigger = view.getByRole('button', { name: 'frameleaf_editor_tool_versions' });
  const menu = await openMenu(view);
  expect(trigger).toHaveAttribute('aria-controls', menu.id);
  const group = view.getByRole('group', { name: 'editor_video_versions' });
  expect(menu).toContainElement(group);
  expect(group.querySelectorAll('[role="menuitemradio"]')).toHaveLength(2);
  expect(menu.querySelector('h3, p')).toBeNull();
  expect(view.getByRole('separator')).toBeInTheDocument();
});

it.each([
  { isEdited: true, versions: [], current: false },
  { isEdited: false, versions: [], current: true },
  { isEdited: true, versions: [version({ edits: [] })], current: true },
])('marks Original current only when it is (%j)', async ({ isEdited, versions, current }) => {
  vi.mocked(getVideoEditVersions).mockResolvedValue(versions);
  const view = renderWithTooltips(VideoVersionsMenu, {
    asset: { ...asset, isEdited },
    draftKey: '[]',
    hasUnsavedChanges: false,
    onApply: vi.fn(),
  });
  await openMenu(view);
  await waitFor(() => expect(getVideoEditVersions).toHaveBeenCalled());
  const original = view.getByRole('menuitemradio', { name: /frameleaf_editor_version_original/ });
  await waitFor(() => expect(original.textContent?.includes('editor_video_version_current')).toBe(current));
});

it('reverts the draft to the original only after confirming unsaved changes, and hides when already original', async () => {
  const onApply = vi.fn();
  modalShow.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const view = render({ hasUnsavedChanges: true, onApply });
  const revert = view.getByRole('button', { name: 'frameleaf_editor_revert' });
  await fireEvent.click(revert);
  await waitFor(() => expect(modalShow).toHaveBeenCalledOnce());
  expect(onApply).not.toHaveBeenCalled();
  await fireEvent.click(revert);
  await waitFor(() => expect(onApply).toHaveBeenCalledWith([]));
  expect(removeAssetEdits).not.toHaveBeenCalled();

  const original = render({ draftKey: '[]' });
  expect(original.queryAllByRole('button', { name: 'frameleaf_editor_revert' })).toHaveLength(1);
});

it('loads a chosen version into the draft instead of publishing it', async () => {
  const older = [{ action: AssetEditAction.Rotate, parameters: { angle: 180 } }];
  vi.mocked(getVideoEditVersions).mockResolvedValue([
    version(),
    version({ id: 'older', edits: older, isCurrent: false, isRequested: false }),
  ]);
  const onApply = vi.fn();
  const view = render({ onApply });
  await openMenu(view);
  const items = await view.findAllByRole('menuitemradio', { name: /editor_video_saved_version/ });
  await fireEvent.click(items[1]);
  await waitFor(() => expect(onApply).toHaveBeenCalledWith(older));
  expect(restoreVideoEditVersion).not.toHaveBeenCalled();
  expect(removeAssetEdits).not.toHaveBeenCalled();
  expect(view.queryByRole('menu')).not.toBeInTheDocument();
});

it('asks before replacing an unsaved draft and keeps it when canceled', async () => {
  const onApply = vi.fn();
  modalShow.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const view = render({ hasUnsavedChanges: true, draftKey: '[{"action":"crop"}]', onApply });
  await openMenu(view);
  await fireEvent.click(view.getByRole('menuitemradio', { name: /frameleaf_editor_version_original/ }));
  await waitFor(() => expect(modalShow).toHaveBeenCalledOnce());
  expect(onApply).not.toHaveBeenCalled();
  await openMenu(view);
  await fireEvent.click(view.getByRole('menuitemradio', { name: /frameleaf_editor_version_original/ }));
  await waitFor(() => expect(onApply).toHaveBeenCalledWith([]));
});

it('queues a separate master export and offers only ready master downloads', async () => {
  const view = render();
  await openMenu(view);
  const exportItem = view.getByRole('menuitem', { name: 'editor_video_export_master' });
  await waitFor(() => expect(exportItem).toHaveAttribute('aria-disabled', 'false'));
  vi.mocked(getVideoEditVersions).mockResolvedValue([
    version(),
    version({ id: 'export', purpose: VideoEditVersionPurpose.Export, isCurrent: false, isRequested: false }),
    version({ id: 'pending', status: VideoEditVersionStatus.Pending, isCurrent: false, isRequested: false }),
    version({ id: 'reverted', edits: [], purpose: VideoEditVersionPurpose.Revert, isRequested: false }),
  ]);
  await fireEvent.click(exportItem);
  await waitFor(() =>
    expect(exportVideoEditVersion).toHaveBeenCalledWith({
      id: asset.id,
      videoEditExportDto: { profile: VideoEditExportProfile.Master },
    }),
  );
  await openMenu(view);
  await waitFor(() =>
    expect(
      view
        .getAllByRole('menuitem', { name: /frameleaf_editor_download_master/ })
        .map((link) => link.getAttribute('href')),
    ).toEqual([
      `/api/assets/${asset.id}/edit-versions/current/download?`,
      `/api/assets/${asset.id}/edit-versions/export/download?`,
    ]),
  );
});

it.each([
  { dirty: true, versions: [version()] },
  { dirty: false, versions: [] },
  { dirty: false, versions: [version({ edits: [] })] },
  {
    dirty: false,
    versions: [version(), version({ id: 'pending', isCurrent: false, status: VideoEditVersionStatus.Pending })],
  },
])('blocks export without a settled saved recipe: %j', async ({ dirty, versions }) => {
  vi.mocked(getVideoEditVersions).mockResolvedValue(versions);
  const view = render({ hasUnsavedChanges: dirty });
  await openMenu(view);
  await waitFor(() => expect(getVideoEditVersions).toHaveBeenCalled());
  await fireEvent.click(view.getByRole('menuitem', { name: 'editor_video_export_master' }));
  expect(view.getByRole('menuitem', { name: 'editor_video_export_master' })).toHaveAttribute('aria-disabled', 'true');
  expect(exportVideoEditVersion).not.toHaveBeenCalled();
});

it('reports a failed history read inside the menu', async () => {
  vi.mocked(getVideoEditVersions).mockRejectedValue(new Error('offline'));
  const view = render();
  await openMenu(view);
  expect(await view.findByRole('alert')).toHaveTextContent('editor_video_versions_error');
});

it('refreshes only for this asset completion or failure and unsubscribes on unmount', async () => {
  const view = render();
  await waitFor(() => expect(getVideoEditVersions).toHaveBeenCalledOnce());
  const listeners = Object.fromEntries(vi.mocked(websocketEvents.on).mock.calls) as Record<
    string,
    (event: unknown) => void
  >;
  listeners.AssetEditReadyV2({ asset: { id: 'another-asset' } });
  listeners.VideoEditVersionFailedV1({ assetId: 'another-asset', versionId: null });
  expect(getVideoEditVersions).toHaveBeenCalledOnce();
  listeners.AssetEditReadyV2({ asset: { id: asset.id } });
  await waitFor(() => expect(getVideoEditVersions).toHaveBeenCalledTimes(2));
  listeners.VideoEditVersionFailedV1({ assetId: asset.id, versionId: 'failed' });
  await waitFor(() => expect(getVideoEditVersions).toHaveBeenCalledTimes(3));
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});
