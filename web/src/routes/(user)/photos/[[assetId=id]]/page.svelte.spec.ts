import * as sdk from '@immich/sdk';
import { AssetVisibility, type ArchiveOperationResponseDto } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import ArchiveOperationsModal from '$lib/modals/ArchiveOperationsModal.svelte';
import { toTimelineAsset } from '$lib/utils/timeline-util';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory, toResponseDto } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../../i18n/en.json';
import Photos from './+page.svelte';

// Hoist the SDK boundary before the UI package loads its own SDK consumers.
vi.mock('@immich/sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@immich/sdk')>();
  return Object.fromEntries(
    Object.entries(original).map(([key, value]) => [key, typeof value === 'function' ? vi.fn() : value]),
  );
});
const sdkMock = vi.mocked(sdk);

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: {} } }));
vi.mock('$app/navigation', () => ({
  afterNavigate: vi.fn(),
  beforeNavigate: vi.fn(),
  goto: vi.fn(),
  onNavigate: vi.fn(),
}));
vi.mock('$lib/elements/HotModuleReload.svelte', async () => {
  const { default: component } = await import('@test-data/components/MockText.svelte');
  return { default: component };
});
vi.mock('$lib/managers/memory-manager.svelte', () => ({ memoryManager: { memories: [], setFilters: vi.fn() } }));

it('uses the route-owned library scope and destroys it exactly once when leaving the route', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue([]);
  sdkMock.getNotifications.mockResolvedValue([]);
  sdkMock.getStorage.mockResolvedValue({
    diskAvailable: '1 GiB',
    diskAvailableRaw: 1024,
    diskSize: '1 GiB',
    diskSizeRaw: 1024,
    diskUsagePercentage: 0,
    diskUse: '0 B',
    diskUseRaw: 0,
  });
  sdkMock.getAllAlbums.mockResolvedValue([]);
  sdkMock.getAuthStatus.mockResolvedValue({ isElevated: false, password: true, pinCode: false });
  authManager.setUser(userAdminFactory.build());
  authManager.setPreferences(preferencesFactory.build());
  const destroy = vi.spyOn(TimelineManager.prototype, 'destroy');
  const view = renderWithTooltips(Photos, {});
  await waitFor(() =>
    expect(sdkMock.getTimeBuckets).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: AssetVisibility.Timeline, withPartners: true, withStacked: true }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
  view.unmount();
  expect(destroy).toHaveBeenCalledOnce();
  destroy.mockRestore();
});

it('prepares and confirms the route query independently of a selected partner asset', async () => {
  addMessages('dev', { archive_operations: en.archive_operations });
  vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
  vi.stubGlobal('visualViewport', getVisualViewportMock());
  Element.prototype.animate = getAnimateMock();
  const partner = toTimelineAsset(assetFactory.build({ ownerId: 'partner-owner' }));
  sdkMock.getTimeBuckets.mockResolvedValue([{ count: 1, timeBucket: '2024-01-01' }]);
  sdkMock.getTimeBucket.mockResolvedValue(toResponseDto(partner));
  sdkMock.getNotifications.mockResolvedValue([]);
  sdkMock.getStorage.mockResolvedValue({
    diskAvailable: '1 GiB',
    diskAvailableRaw: 1024,
    diskSize: '1 GiB',
    diskSizeRaw: 1024,
    diskUsagePercentage: 0,
    diskUse: '0 B',
    diskUseRaw: 0,
  });
  sdkMock.getAllAlbums.mockResolvedValue([]);
  sdkMock.getAuthStatus.mockResolvedValue({ isElevated: false, password: true, pinCode: false });
  authManager.setUser(userAdminFactory.build());
  authManager.setPreferences(preferencesFactory.build());
  const view = renderWithTooltips(Photos, {});
  await tick();
  await tick();
  assetMultiSelectManager.selectAsset(partner);
  const show = vi.spyOn(modalManager, 'show').mockResolvedValue(undefined as never);
  const action = await screen.findByRole('button', { name: 'Archive all matching from your library' });
  expect(assetMultiSelectManager.isAllUserOwned).toBe(false);
  await fireEvent.click(action);
  expect(show).toHaveBeenCalledWith(ArchiveOperationsModal, expect.anything());
  const props = show.mock.calls[0][1] as unknown as {
    matchingQuery: () => Parameters<typeof sdkMock.prepareArchiveOperation>[0]['archiveOperationPrepareDto']['query'];
    currentMatchingQuery: () => Parameters<
      typeof sdkMock.prepareArchiveOperation
    >[0]['archiveOperationPrepareDto']['query'];
  };
  const prepared = {
    id: 'prepared-route-receipt',
    requestKey: 'server-recorded-request',
    prepared: true,
    scope: 'matching-owned-timeline',
    count: 23,
    pending: 23,
    cancelled: false,
    undo: false,
    succeeded: 0,
    skipped: 0,
    revoked: 0,
    error: 0,
    undone: 0,
    conflict: 0,
  } as ArchiveOperationResponseDto;
  sdkMock.prepareArchiveOperation.mockResolvedValue(prepared);
  sdkMock.confirmArchiveOperation.mockResolvedValue({ ...prepared, prepared: false });
  sdkMock.getArchiveOperations.mockResolvedValue([]);
  expect(props.matchingQuery).toBeTypeOf('function');
  const modal = render(ArchiveOperationsModal, { ...props, onClose: vi.fn() });
  await waitFor(() => expect(sdkMock.prepareArchiveOperation).toHaveBeenCalled());
  const request = sdkMock.prepareArchiveOperation.mock.calls.at(-1)![0].archiveOperationPrepareDto;
  expect(request.query).toMatchObject({
    scope: { kind: 'library' },
    filters: { visibility: AssetVisibility.Timeline, withStacked: true, withPartners: true },
  });
  expect(request).not.toHaveProperty('ids');
  expect(screen.getByText('23 matching assets · Your normal Timeline only')).toBeVisible();
  expect(sdkMock.confirmArchiveOperation).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole('button', { name: 'Confirm archive' }));
  await waitFor(() =>
    expect(sdkMock.confirmArchiveOperation).toHaveBeenCalledWith(
      { id: prepared.id, archiveOperationConfirmDto: { requestKey: prepared.requestKey } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
  modal.unmount();
  view.unmount();
  assetMultiSelectManager.clear();
  show.mockRestore();
});
