import { flushSync } from 'react-dom'
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store'
import { useProjectStore } from '@/features/projects/stores/project-store'

/** Feed touch gestures to Freecut's existing mouse-based clip tools, with their linked edits/history. */
export function installTimelineTouchEditing(): () => void {
  const scope = window
  let gesture:
    | {
        id: number
        target: Element
        point: MouseEventInit
        context: string
        projectId: string | undefined
        begin?: () => void
      }
    | undefined
  const pointOf = (event: PointerEvent): MouseEventInit => ({
    clientX: event.clientX,
    clientY: event.clientY,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  })
  const mouse = (target: EventTarget, type: string, event: MouseEventInit) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...event }))
  const down = (event: PointerEvent) => {
    const target = event.target
    if (
      gesture ||
      event.defaultPrevented ||
      event.pointerType !== 'touch' ||
      !event.isPrimary ||
      !(target instanceof Element) ||
      !target.closest('[data-timeline-item]') ||
      target.closest('input, textarea, select, a') ||
      (target instanceof HTMLElement ? target : target.parentElement)?.isContentEditable
    )
      return
    event.preventDefault() // Suppress the browser's duplicate compatibility mouse sequence.
    const point = pointOf(event)
    const clip = target.closest('[data-timeline-item]')!
    // Touch has no hover: reveal the existing trim handle before routing its press.
    flushSync(() => mouse(clip, 'mouseover', point))
    flushSync(() => mouse(clip, 'mousemove', point))
    const active = (gesture = {
      id: event.pointerId,
      target,
      point,
      context: useTimelineCommandStore.getState().activeContextKey,
      projectId: useProjectStore.getState().currentProject?.id,
      begin: undefined as (() => void) | undefined,
    })
    active.begin = () => {
      if (gesture !== active) return
      if (
        !clip.isConnected ||
        useTimelineCommandStore.getState().activeContextKey !== active.context ||
        useProjectStore.getState().currentProject?.id !== active.projectId
      ) {
        gesture = undefined
        return
      }
      const hit = scope.document.elementFromPoint?.(point.clientX!, point.clientY!)
      active.target = hit?.closest('[data-timeline-item]') === clip ? hit! : target
      active.begin = undefined
      mouse(active.target, 'mousedown', { ...point, button: 0, buttons: 1 })
    }
    // Let hover layout finish before hit-testing; retiring/cancelled gestures never start.
    scope.requestAnimationFrame(() => {
      active.begin?.()
      if (gesture === active && active.point !== point)
        mouse(scope, 'mousemove', { ...active.point, buttons: 1 })
    })
  }
  const move = (event: PointerEvent) => {
    if (event.pointerId !== gesture?.id) return
    event.preventDefault()
    if (
      useTimelineCommandStore.getState().activeContextKey !== gesture!.context ||
      useProjectStore.getState().currentProject?.id !== gesture!.projectId
    ) {
      gesture = undefined
      return
    }
    gesture!.point = pointOf(event)
    if (gesture!.begin) return
    mouse(scope, 'mousemove', { ...gesture!.point, buttons: 1 })
  }
  const finish = (cancelled: boolean, event?: PointerEvent) => {
    if (!gesture || (event && event.pointerId !== gesture.id)) return
    if (gesture.begin) {
      if (cancelled) {
        gesture = undefined
        return
      }
      gesture.begin()
      if (!gesture) return
    }
    const { target, context, projectId } = gesture
    const history = useTimelineCommandStore.getState()
    const point = cancelled ? gesture.point : pointOf(event!)
    gesture = undefined
    if (
      history.activeContextKey !== context ||
      useProjectStore.getState().currentProject?.id !== projectId
    )
      return
    if (!cancelled) mouse(scope, 'mousemove', { ...point, buttons: 1 })
    mouse(target.isConnected ? target : scope, 'mouseup', { ...point, button: 0, buttons: 0 })
    // The tools own cancellation snapshots. Undo only this gesture's entries, even at the history cap.
    const current = useTimelineCommandStore.getState()
    if (
      cancelled &&
      current.activeContextKey === history.activeContextKey &&
      useProjectStore.getState().currentProject?.id === projectId
    ) {
      const previous = new Set(history.undoStack)
      for (const entry of current.undoStack) if (!previous.has(entry)) current.undo()
      useTimelineCommandStore.setState({
        undoStack: history.undoStack,
        redoStack: history.redoStack,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
      })
    }
  }
  const up = (event: PointerEvent) => finish(false, event)
  const cancel = (event: PointerEvent) => finish(true, event)
  const blur = () => finish(true)
  scope.addEventListener('pointerdown', down)
  scope.addEventListener('pointermove', move, { capture: true, passive: false })
  scope.addEventListener('pointerup', up, true)
  scope.addEventListener('pointercancel', cancel, true)
  scope.addEventListener('blur', blur)
  return () => {
    gesture = undefined // The retiring editor's own tool hooks clean up without committing a release.
    scope.removeEventListener('pointerdown', down)
    scope.removeEventListener('pointermove', move, true)
    scope.removeEventListener('pointerup', up, true)
    scope.removeEventListener('pointercancel', cancel, true)
    scope.removeEventListener('blur', blur)
  }
}
