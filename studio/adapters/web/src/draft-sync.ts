/**
 * When the editor frame reloads from the host's graph, and when it sends its own again (FL-88).
 */

/**
 * Reload only for a graph this editor did not write (a restore, a reload the person chose, a
 * canonical command) and never while the host holds the person's undecided edits: after a take
 * over finds a newer head, the editor keeps showing what the person made until they choose
 * Reload, Take over or Save as copy.
 */
export const shouldReloadFromHost = (input: {
  incoming: string
  hostContent: string
  current: string
  draftHeld: boolean
}): boolean =>
  !input.draftHeld && input.incoming !== input.hostContent && input.incoming !== input.current

/** A draft the host could not take yet goes again once it is online and holds the lease. */
export const shouldResendDraft = (input: {
  pending: boolean
  online: boolean
  hasLease: boolean
}): boolean => input.pending && input.online && input.hasLease

/*
 * INVARIANT (FL-89). A draft's base revision is the revision of the graph that the currently
 * mounted, fully loaded editor instance started from; the host's echo of that instance's own
 * content is the only other thing that moves it. Any write from another instance, or made while an
 * instance is still loading, is dropped.
 *
 * How it holds: every editor mount has its own Freecut project id, so an older instance's late
 * saves (Freecut's interval autosave, a `saveTimeline` still generating its thumbnail) land in that
 * instance's own file, which nothing reads. A write is attributed to the mount whose file it is,
 * accepted only while that mount is current and loaded, and sent with that mount's revision.
 */

/** One editor instance: the graph it started from and whether its timeline has finished loading. */
export interface EditorMount {
  readonly generation: number
  /** The Freecut project id this instance reads and writes (`projects/<id>/project.json`). */
  readonly projectId: string
  /** The revision its graph was loaded from, advanced only by the echo of its own content. */
  revision: number
  loaded: boolean
}

export interface DraftSendState {
  /** Content of the graph the host holds, so an echo of our own draft is not reloaded. */
  hostContent: string
  mount: EditorMount
  pendingSend: boolean
  disposed: boolean
}

/** Replace the current mount. Every timer the old instance scheduled must be cancelled by the caller first. */
export function beginMount(
  state: DraftSendState,
  projectId: string,
  revision: number,
): EditorMount {
  state.mount = { generation: state.mount.generation + 1, projectId, revision, loaded: false }
  // The edits a refused draft carried belonged to the old instance; there is nothing to resend.
  state.pendingSend = false
  return state.mount
}

/** The mount's timeline finished loading: from now on its writes are drafts. */
export function markLoaded(state: DraftSendState, mount: EditorMount): void {
  if (state.mount === mount) mount.loaded = true
}

/**
 * Whether a Freecut save of `projectId` may start now. A save snapshots the global timeline stores
 * when it starts and writes later, so it is judged here, at the start: only the current mount, once
 * loaded, may save. A save started while that mount loads would snapshot the replaced timeline.
 */
export const saveMayStart = (state: DraftSendState, projectId: string): boolean =>
  state.mount.projectId === projectId && acceptsWrite(state, state.mount)

/** Whether a write from this mount may become a draft. */
export const acceptsWrite = (state: DraftSendState, mount: EditorMount): boolean =>
  !state.disposed && state.mount === mount && mount.loaded

/** The host confirmed a revision whose graph is exactly what the current mount shows. */
export function confirmEcho(
  state: DraftSendState,
  content: string,
  current: string,
  revision: number,
): void {
  const { mount } = state
  if (mount.loaded && content === current && revision > mount.revision) mount.revision = revision
}

export interface DraftSendIo {
  read: (mount: EditorMount) => Promise<string | null>
  contentOf: (graph: unknown) => string
  stage: (graph: unknown, baseRevision: number) => Promise<{ status: string }>
  dirty: (dirty: boolean) => void
}

/**
 * Send what `mount` wrote as a draft, based on the revision that mount started from. A mount that is
 * no longer current (or not yet loaded) at any step is dropped: its graph is not the editor's.
 */
export async function sendEditorDraft(
  state: DraftSendState,
  mount: EditorMount,
  io: DraftSendIo,
): Promise<void> {
  if (!acceptsWrite(state, mount)) return
  const base = mount.revision
  const text = await io.read(mount)
  if (!text || !acceptsWrite(state, mount)) return
  let graph: unknown
  try {
    graph = JSON.parse(text)
  } catch {
    return
  }
  const content = io.contentOf(graph)
  if (content === state.hostContent) return
  const result = await io.stage(graph, base).catch(() => ({ status: 'rejected' }))
  // A remount meanwhile owns hostContent and pendingSend now; the host judged this draft on its base.
  if (!acceptsWrite(state, mount)) return
  if (result.status === 'staged') {
    state.hostContent = content
    state.pendingSend = false
    io.dirty(false)
  } else {
    // Kept in the editor and sent again when the host can take it; the host's banner says why.
    state.pendingSend = true
    io.dirty(true)
  }
}
