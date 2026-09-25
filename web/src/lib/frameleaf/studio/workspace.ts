import { getStudioWorkspace, saveStudioWorkspace, type StudioWorkspaceDto } from '@immich/sdk';
import type { StudioWorkspaceSaveResult, StudioWorkspaceView } from '$lib/frameleaf/studio/host-contract';

/**
 * The host side of the Studio workspace layout (FL-91, `STU-204`): Freecut's workspace folder,
 * kept per account on the server. The engine only ever sees the view and the save result; the
 * SDK, the token and the status codes stay here.
 */

type WorkspaceApi = {
  get: () => Promise<StudioWorkspaceDto>;
  save: (layout: Record<string, unknown>, engineRevision: string) => Promise<StudioWorkspaceDto>;
};

const defaultApi: WorkspaceApi = {
  get: () => getStudioWorkspace(),
  save: (layout, engineRevision) => saveStudioWorkspace({ studioWorkspaceSaveDto: { layout, engineRevision } }),
};

/** Read by shape, like the project session: the SDK's `HttpError` carries `status`. */
const httpStatus = (error: unknown): number | null => {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
};

/**
 * The stored layout, or `unavailable` when it cannot be read. A read failure never blocks the
 * editor: the engine starts from its defaults and is told nothing it lays out is being kept.
 * An account with no stored layout is `ready` with a null layout, which is a real answer.
 */
export const loadStudioWorkspace = async (api: WorkspaceApi = defaultApi): Promise<StudioWorkspaceView> => {
  try {
    const stored = await api.get();
    return { state: 'ready', layout: stored.layout, savedAt: stored.savedAt };
  } catch {
    return { state: 'unavailable', reason: 'storage-unavailable' };
  }
};

/** The layout must be a JSON object, as the server stores it; anything else is refused here. */
const isLayoutObject = (layout: unknown): layout is Record<string, unknown> =>
  typeof layout === 'object' && layout !== null && !Array.isArray(layout);

/**
 * Keep the engine's layout. `503` (the fork schema mid-handoff) and no network are `unavailable`:
 * nothing was stored and the engine is told so. Any other failure, such as a refused payload,
 * rejects, because the contract allows the engine to assume nothing about a failed save.
 */
export const saveStudioWorkspaceLayout = async (
  layout: unknown,
  engineRevision: string,
  api: WorkspaceApi = defaultApi,
): Promise<StudioWorkspaceSaveResult> => {
  if (!isLayoutObject(layout)) {
    throw new TypeError('The workspace layout must be a JSON object');
  }
  try {
    const saved = await api.save(layout, engineRevision);
    return saved.savedAt ? { status: 'saved', savedAt: saved.savedAt } : { status: 'unavailable' };
  } catch (error) {
    const status = httpStatus(error);
    if (status === 503 || status === null) {
      return { status: 'unavailable' };
    }
    throw error;
  }
};
