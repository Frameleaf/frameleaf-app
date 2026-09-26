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
  buildTimelineFromStores,
  loadTimeline as engineLoadTimeline,
  saveTimeline as engineSaveTimeline,
} from '@/features/timeline/stores/timeline-persistence'
import { useTimelineSettingsStore } from '@/features/timeline/stores/timeline-settings-store'
import { persistenceGate } from '../persistence-gate'

export * from '@/features/timeline/stores/timeline-persistence'

/**
 * The edit content of the timeline in the stores: what a save stores, without the view state (the
 * playhead, zoom and scroll) that changes without an edit.
 */
export const timelineEditContent = (): string => {
  const {
    currentFrame: _currentFrame,
    zoomLevel: _zoomLevel,
    scrollPosition: _scrollPosition,
    ...content
  } = buildTimelineFromStores()
  return JSON.stringify(content)
}

/**
 * Freecut's save snapshots the stores when it starts and marks the (global) timeline clean when it
 * ends, even if the stores changed while it wrote (FL-174). An edit made meanwhile would then be
 * neither saved nor dirty, so nothing would send it and a remount would drop it without a word; the
 * same goes for a newer editor instance whose edits a replaced instance's late save marks clean. When
 * the stores changed during the save, the timeline is marked dirty again: the frame's settled save
 * then stores the edit, and a remount reports it if it cannot.
 */
export async function saveTimeline(projectId: string): Promise<void> {
  if (!persistenceGate.mayStartSave(projectId)) return
  const before = timelineEditContent()
  await engineSaveTimeline(projectId)
  if (timelineEditContent() !== before) useTimelineSettingsStore.getState().markDirty()
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
