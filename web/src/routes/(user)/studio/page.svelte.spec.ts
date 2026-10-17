import { createStudioExport, getMediaOperation } from '@frameleaf/sdk';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { deferredPromise } from '@test-data/deferred';
import { userAdminFactory } from '@test-data/factories/user-factory';
import type { PageData } from './$types';
import StudioPage from './+page.svelte';

const harness = vi.hoisted(() => ({
  exportDialog: undefined as { onExport: (choice: object) => void } | undefined,
}));

vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn(), goto: vi.fn(), replaceState: vi.fn() }));
vi.mock('$lib/components/shared-components/navigation-bar/NavigationBar.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/StudioHost.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/StudioBundleExportDialog.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/Dialog.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/StudioExportDialog.svelte', () => ({
  default: (_anchor: unknown, props: NonNullable<typeof harness.exportDialog>) => {
    harness.exportDialog = props;
  },
}));
vi.mock('$lib/frameleaf/studio/frame-engine', () => ({ registerFrameStudioEngine: vi.fn() }));
vi.mock('$lib/frameleaf/studio/engine-loader', () => ({
  loadStudioEngine: vi.fn().mockResolvedValue({ status: 'unavailable' }),
  pinnedFreecutRevision: 'test',
}));
vi.mock('$lib/frameleaf/studio/capabilities', () => ({
  createStudioHostRefresh: () => ({ refresh: vi.fn(async () => {}), invalidate: vi.fn(), dispose: vi.fn() }),
}));
vi.mock('$lib/frameleaf/studio/workspace', () => ({
  loadStudioWorkspace: vi.fn().mockResolvedValue(undefined),
  saveStudioWorkspaceLayout: vi.fn(),
}));
vi.mock('$lib/frameleaf/studio/preview-transport', () => ({ createStudioPreviewTransport: () => ({}) }));
vi.mock('$lib/frameleaf/studio/preview-stream-transport', () => ({ createStudioPreviewStreamTransport: () => ({}) }));
vi.mock('$lib/frameleaf/studio/project-imports', () => ({
  createStudioRetentionApi: vi.fn(() => ({})),
  loadStudioProjectImports: vi.fn().mockResolvedValue([]),
  uploadStudioProjectImport: vi.fn(),
}));
vi.mock('$lib/frameleaf/studio/import-retention', () => ({
  onStudioImportSessionRetired: () => () => {},
  reconcileRetainedImports: vi.fn().mockResolvedValue({ items: [] }),
  submitRetainedImport: vi.fn(),
}));
vi.mock('$lib/frameleaf/studio/project-session', () => ({
  STUDIO_DRAFT_PROJECT_ID: 'draft',
  createStudioProjectSession: (options: { onChange: (state: object) => void }) => {
    const state = {
      project: {
        id: 'project-1',
        name: 'Trip',
        revision: 3,
        graphDigest: null,
        leaseEpoch: 1,
        leaseExpiresAt: null,
        graph: null,
        hasLease: true,
      },
      status: 'saved',
      access: 'owner',
      hasDraft: false,
    };
    return {
      state,
      open: vi.fn(async () => options.onChange(state)),
      dispose: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      comments: vi.fn().mockResolvedValue({ items: [] }),
      setOnline: vi.fn(),
    };
  },
}));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  createStudioExport: vi.fn(),
  getMediaOperation: vi.fn(),
}));

const data = {
  projectId: 'project-1',
  assets: [],
  restoredVersions: [],
  returnTo: null,
  at: null,
  unavailableAssetCount: 0,
  meta: { title: 'Studio' },
} as unknown as PageData;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('stops following an export once the page is gone, even with a status read in flight', async () => {
  vi.useFakeTimers();
  authManager.setUser(userAdminFactory.build());
  const running = { id: 'op-1', status: 'running' };
  const inFlight = deferredPromise<typeof running>();
  vi.mocked(createStudioExport).mockResolvedValue({ operation: running } as never);
  vi.mocked(getMediaOperation)
    .mockReturnValueOnce(inFlight.promise as never)
    .mockResolvedValue(running as never);

  const view = render(StudioPage, { data });
  await vi.advanceTimersByTimeAsync(0);
  await tick();
  harness.exportDialog!.onExport({});
  await vi.advanceTimersByTimeAsync(1000);
  expect(getMediaOperation).toHaveBeenCalledTimes(1);

  view.unmount();
  inFlight.resolve(running);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(getMediaOperation).toHaveBeenCalledTimes(1);
});
