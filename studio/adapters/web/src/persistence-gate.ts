/**
 * The frame's hold on Freecut's timeline persistence (FL-89). `shims/timeline-persistence.ts`
 * consults it at the start of every save and reports every load; `editor-frame.tsx` installs the
 * rules (see the invariant in `draft-sync.ts`). Until then saves pass and loads go unreported, as in
 * the stand-alone command frame and tests.
 */
export interface PersistenceGate {
  mayStartSave(projectId: string): boolean
  loadFinished(projectId: string, error: unknown): void
}

let gate: PersistenceGate = { mayStartSave: () => true, loadFinished: () => undefined }

export function setPersistenceGate(next: PersistenceGate): void {
  gate = next
}

export const persistenceGate: PersistenceGate = {
  mayStartSave: (projectId) => gate.mayStartSave(projectId),
  loadFinished: (projectId, error) => gate.loadFinished(projectId, error),
}
