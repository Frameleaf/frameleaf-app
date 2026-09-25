/**
 * Whether the host takes an editor draft (FL-88, FL-89).
 *
 * The project session keeps a draft through going offline, losing the lease and a conflict, and
 * sends it when the connection or the lease comes back; only the person's own choice (reload,
 * take over, save as copy) resolves a conflict. So a draft is refused only when this session may
 * not hold one at all: access is gone, the person only reviews, the project is still loading, or
 * the draft is not a document.
 */
import type { StudioDraftResult } from './host-contract';
import type { StudioProjectAccess, StudioProjectStatus } from './project-session';

export interface StudioDraftGate {
  accessLost: boolean;
  forbidden: boolean;
  authenticated: boolean;
  access: StudioProjectAccess | null;
  status: StudioProjectStatus;
}

export const decideStudioDraft = (
  gate: StudioDraftGate,
  graph: unknown,
): { stage: true } | { stage: false; result: StudioDraftResult } => {
  if (gate.accessLost || gate.forbidden || !gate.authenticated) {
    return { stage: false, result: { status: 'rejected', reason: 'forbidden' } };
  }
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return { stage: false, result: { status: 'rejected', reason: 'invalid' } };
  }
  if (gate.access === 'reviewer' || gate.status === 'review' || gate.status === 'loading') {
    return { stage: false, result: { status: 'rejected', reason: 'lease-lost' } };
  }
  return { stage: true };
};

/**
 * The editor keeps what it shows while the host holds edits the person has not decided about: a
 * conflict or a lost lease. A graph that arrives meanwhile (the head a take-over read) must not
 * replace those edits in the editor; Reload, Take over and Save as copy decide. With no draft
 * (after Reload) nothing is held, so the editor shows the head it will be judged against.
 */
export const studioDraftHeld = (status: StudioProjectStatus | undefined, hasDraft: boolean): boolean =>
  hasDraft && (status === 'conflict' || status === 'lease-lost');
