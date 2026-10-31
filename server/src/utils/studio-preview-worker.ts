import type { AuthenticatedRenderWorker, RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { MediaOperationDestination, MediaOperationKind } from 'src/enum.js';
import { evaluateApprovedRenderSession } from 'src/utils/gpu-working-budget-policy.js';

export const supportsLocalRenderKind = ({ worker, session }: AuthenticatedRenderWorker, kind: MediaOperationKind) =>
  worker.destination === MediaOperationDestination.Local &&
  worker.kinds.includes(kind) &&
  session.scopes.includes(kind);

/** Use the same qualification as exports, with the operation's own local scope. */
export const hasStudioPreviewWorker = async (repository: RenderWorkerRepository, kind: MediaOperationKind) => {
  for (const entry of await repository.listLiveSessions()) {
    if (!supportsLocalRenderKind(entry, kind)) continue;
    const capabilities = await repository.getSessionCapabilities(entry.session.id);
    if (capabilities && evaluateApprovedRenderSession({ ...entry, capabilities, now: new Date() }).valid) return true;
  }
  return false;
};
