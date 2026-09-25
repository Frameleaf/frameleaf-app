/**
 * Freecut's timeline persistence, unchanged, behind Frameleaf's gate (FL-89).
 *
 * Every Freecut save path (the editor's Ctrl+S and interval autosave, media deletion, the frame's
 * settled-save timer) calls `saveTimeline` from this module, through the timeline store facade or
 * directly, so the gate sees each save as it starts: a save the gate refuses never snapshots the
 * stores and never writes. `loadTimeline` reports how each load ended, so a mount counts as loaded
 * only after its own load succeeded.
 */
import {
  loadTimeline as engineLoadTimeline,
  saveTimeline as engineSaveTimeline,
} from '@/features/timeline/stores/timeline-persistence'
import { persistenceGate } from '../persistence-gate'

export * from '@/features/timeline/stores/timeline-persistence'

export async function saveTimeline(projectId: string): Promise<void> {
  if (!persistenceGate.mayStartSave(projectId)) return
  await engineSaveTimeline(projectId)
}

export function loadTimeline(
  ...args: Parameters<typeof engineLoadTimeline>
): ReturnType<typeof engineLoadTimeline> {
  const load = engineLoadTimeline(...args)
  load.then(
    () => persistenceGate.loadFinished(args[0], null),
    (error: unknown) => persistenceGate.loadFinished(args[0], error ?? new Error('load failed')),
  )
  return load
}
