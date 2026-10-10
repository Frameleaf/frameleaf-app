import { StudioProjectAccess, StudioProjectShelf, type StudioProjectDetailDto } from '@frameleaf/sdk';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import type { Component } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TestWrapper from '$lib/components/TestWrapper.svelte';
import { pinnedFreecutRevision, type StudioEngineResolution } from '$lib/frameleaf/studio/engine-loader';
import { emptyStudioCapabilities, type StudioHostServices } from '$lib/frameleaf/studio/host-contract';
import {
  createStudioProjectSession,
  type StudioProjectApi,
  type StudioProjectSession,
  type StudioProjectSessionState,
} from '$lib/frameleaf/studio/project-session';
import StudioHost from './StudioHost.svelte';

addMessages('dev', { frameleaf_studio_project_name: 'Project name', frameleaf_studio_read_only: 'View only' });

const lease = {
  heldByYou: true,
  heldByAnother: false,
  leaseMs: 90_000,
  renewMs: 30_000,
  autosaveDebounceMs: 1500,
  expiresAt: '2026-10-09T20:00:00Z',
};
const detail = (access: StudioProjectAccess): StudioProjectDetailDto => ({
  id: 'fl112-project',
  ownerId: 'owner',
  name: 'FL-112 access',
  spaceId: 'space',
  revision: 1,
  access,
  lease,
  createdAt: '2026-10-09T12:00:00Z',
  updatedAt: '2026-10-09T12:00:00Z',
  envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: pinnedFreecutRevision, graph: { tracks: [] } },
  digest: 'digest',
  withheld: false,
  resources: {
    complete: true,
    refusedCount: 0,
    unsupportedSources: [],
    hiddenSources: [],
    hdrSources: [],
    hdrProxySources: [],
    checkedAt: '2026-10-09T12:00:00Z',
  },
  shelf: StudioProjectShelf.Active,
  archivedAt: null,
  deletedAt: null,
  purgeAfter: null,
  lastOpenedAt: null,
  thumbnailAssetId: null,
  duplicatedFromId: null,
  importedFromBundle: false,
});
const sessions: StudioProjectSession[] = [];
afterEach(async () => {
  cleanup();
  const disposing = [...sessions];
  sessions.length = 0;
  await Promise.all(disposing.map((session) => session.dispose()));
});
async function open(
  access: StudioProjectAccess,
  engine: 'missing-workers' | 'absent' | 'failed' | 'ready' = 'missing-workers',
) {
  const stored = detail(access);
  const api = {
    get: vi.fn().mockResolvedValue(stored),
    acquireLease: vi.fn().mockResolvedValue(lease),
    releaseLease: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn(async (_id: string, name: string) => ({ name })),
    create: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    history: vi.fn(),
    comments: vi.fn(),
    addComment: vi.fn(),
    updateComment: vi.fn(),
  } satisfies StudioProjectApi;
  let state!: StudioProjectSessionState;
  const session = createStudioProjectSession({
    api,
    clientId: 'client',
    projectId: stored.id,
    name: '',
    engineRevision: pinnedFreecutRevision,
    setTimer: () => () => {},
    onChange: (next) => {
      state = next;
    },
  });
  sessions.push(session);
  await session.open();
  const instance = { update: vi.fn(), dispose: vi.fn() };
  const loadEngine = vi.fn<() => Promise<StudioEngineResolution>>().mockResolvedValue(
    engine === 'ready'
      ? {
          status: 'available',
          module: { engineRevision: pinnedFreecutRevision, features: [], mount: async () => instance },
        }
      : {
          status: 'absent',
          reason: engine === 'failed' ? 'load-failed' : 'not-built',
          messageKey: 'frameleaf_studio_engine_absent_body',
        },
  );
  const props = () => ({
    project: state.project,
    assets: [],
    auth: {
      userId: access === StudioProjectAccess.Owner ? 'owner' : 'member',
      name: 'Person',
      avatarUrl: null,
      locale: 'en',
    },
    capabilities:
      engine === 'missing-workers'
        ? emptyStudioCapabilities()
        : { ...emptyStudioCapabilities(), gpuWorker: true, renderWorker: true },
    services: {} as StudioHostServices,
    onBack: vi.fn(),
    accessLost: false,
    session,
    saveStatus: state.status,
    access: state.access,
    onRename: state.access === 'owner' ? (name: string) => session.rename(name) : undefined,
    loadEngine,
  });
  const Wrapper = TestWrapper as Component<{ component: typeof StudioHost; componentProps: ReturnType<typeof props> }>;
  const view = render(Wrapper, { component: StudioHost, componentProps: props() });
  const refresh = (changes: Partial<ReturnType<typeof props>> = {}) =>
    view.rerender({ component: StudioHost, componentProps: { ...props(), ...changes } });
  if (engine === 'ready') {
    await waitFor(() => expect(view.queryByTestId('studio-state')).toBeNull());
  } else {
    await waitFor(() => expect(view.getByTestId('studio-state')).toHaveAttribute('data-phase', 'unavailable'));
  }
  return { ...view, api, session, refresh, state: () => state, loadEngine, instance };
}
describe('project authorization is independent of editor availability (FL-112)', () => {
  for (const engine of ['missing-workers', 'absent', 'failed', 'ready'] as const) {
    it(`owner can rename the stored project with ${engine}`, async () => {
      const view = await open(StudioProjectAccess.Owner, engine);
      const input = view.getByRole('textbox', { name: 'Project name' });
      expect(input).toHaveValue('FL-112 access');
      await fireEvent.input(input, { target: { value: 'Renamed project' } });
      await fireEvent.blur(input);
      await waitFor(() => expect(view.api.rename).toHaveBeenCalledWith('fl112-project', 'Renamed project'));
      expect(view.state().project.name).toBe('Renamed project');
      if (engine !== 'ready') {
        expect(view.getByTestId('studio-state')).toHaveAttribute('data-phase', 'unavailable');
      }
      expect(view.api.save).not.toHaveBeenCalled();
    });
    for (const member of ['shared', 'viewer']) {
      it(`${member} sees View only with ${engine} and cannot rename or acquire a lease`, async () => {
        const view = await open(StudioProjectAccess.Reviewer, engine);
        expect(view.getByRole('heading', { level: 1, name: 'FL-112 access' })).toBeVisible();
        expect(view.queryByRole('textbox', { name: 'Project name' })).toBeNull();
        expect(view.getByText('View only')).toBeVisible();
        expect(view.api.rename).not.toHaveBeenCalled();
        expect(view.api.acquireLease).not.toHaveBeenCalled();
        expect(view.api.save).not.toHaveBeenCalled();
      });
    }
  }
});

describe('project chrome authorization transitions', () => {
  it('shows no stale project details or controls while the session loads or access is unknown', async () => {
    const view = await open(StudioProjectAccess.Owner);
    for (const changes of [{ saveStatus: 'loading' as const }, { access: null, onRename: undefined }]) {
      await view.refresh(changes);
      expect(view.queryByRole('textbox', { name: 'Project name' })).toBeNull();
      expect(view.queryByRole('heading', { name: 'FL-112 access' })).toBeNull();
      expect(view.queryByText('View only')).toBeNull();
    }
    expect(view.api.rename).not.toHaveBeenCalled();
  });

  it('hides the previously admitted project after a real session reload is refused', async () => {
    const view = await open(StudioProjectAccess.Owner);
    view.api.get.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404, data: {} }));
    await view.session.reload();
    await view.refresh();
    expect(view.state().status).toBe('forbidden');
    expect(view.queryByRole('textbox', { name: 'Project name' })).toBeNull();
    expect(view.queryByRole('heading', { name: 'FL-112 access' })).toBeNull();
    expect(view.queryByText('View only')).toBeNull();
    expect(view.api.rename).not.toHaveBeenCalled();
  });

  it('sign-out or relock hides name and permissions and disposes the running editor', async () => {
    const view = await open(StudioProjectAccess.Owner, 'ready');
    await view.refresh({ accessLost: true });
    await waitFor(() => expect(view.instance.dispose).toHaveBeenCalledTimes(1));
    expect(view.queryByRole('textbox', { name: 'Project name' })).toBeNull();
    expect(view.queryByRole('heading', { name: 'FL-112 access' })).toBeNull();
    expect(view.queryByText('View only')).toBeNull();
    expect(view.getByTestId('studio-state')).toHaveAttribute('data-phase', 'forbidden');
  });

  it('keeps a refused rename at the stored name without graph saves or bypassing the server', async () => {
    const view = await open(StudioProjectAccess.Owner);
    view.api.rename.mockRejectedValueOnce(new Error('Forbidden'));
    const input = view.getByRole('textbox', { name: 'Project name' });
    await fireEvent.input(input, { target: { value: 'Refused name' } });
    await fireEvent.blur(input);
    await waitFor(() => expect(input).toHaveValue('FL-112 access'));
    expect(view.state().project.name).toBe('FL-112 access');
    expect(view.api.rename).toHaveBeenCalledTimes(1);
    expect(view.api.save).not.toHaveBeenCalled();
  });

  it('shows the lost-lease decision instead of a saved claim when workers are unavailable', async () => {
    const view = await open(StudioProjectAccess.Owner);
    await view.refresh({ saveStatus: 'lease-lost', project: { ...view.state().project, hasLease: false } });
    expect(view.container.querySelector('[data-state="lease-lost"]')).toBeVisible();
    expect(view.container.querySelector('[data-state="saved"]')).toBeNull();
    expect(view.getByTestId('studio-state')).toHaveAttribute('data-phase', 'unavailable');
    expect(view.api.save).not.toHaveBeenCalled();
  });
});
