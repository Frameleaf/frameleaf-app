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

/**
 * What `update` does with the host's graph (FL-174). `graphVersion` counts the graphs the host put in
 * place itself (a canonical command, undo, Reload, a restore); a newer one than the mount's means the
 * editor's graph lacks the host's change. The editor then shows the host's graph: it reloads unless it
 * already shows exactly that graph, in which case its edits are built on it and the mount takes the
 * version. The host puts a graph in place only while it holds no undecided edits of the person's, so
 * this reload is never held back. Otherwise the rules of `shouldReloadFromHost` apply. `hold` means
 * the host holds the person's undecided edits: nothing is reloaded or confirmed.
 */
export function reconcileHostGraph(
  state: DraftSendState,
  input: { incoming: string; current: string; draftHeld: boolean; graphVersion: number },
): 'remount' | 'echo' | 'hold' {
  const { mount } = state
  if (input.graphVersion > mount.graphVersion) {
    if (input.incoming !== input.current) return 'remount'
    mount.graphVersion = input.graphVersion
  } else if (shouldReloadFromHost({ ...input, hostContent: state.hostContent })) {
    return 'remount'
  }
  return input.draftHeld ? 'hold' : 'echo'
}

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
  /**
   * The host's `graphVersion` its graph was loaded from (FL-174), advanced only when the host's newer
   * graph is exactly what this instance shows. Sent with every draft.
   */
  graphVersion: number
  loaded: boolean
}

export interface DraftSendState {
  /** Content of the graph the host holds, so an echo of our own draft is not reloaded. */
  hostContent: string
  mount: EditorMount
  pendingSend: boolean
  /**
   * The pending send was refused as `superseded`: the host replaced the graph after this mount
   * loaded (FL-174). If the mount is replaced before it can go again, that edit is lost.
   */
  pendingSuperseded: boolean
  /**
   * The current mount wrote work that became a draft to send and the host has not taken yet
   * (FL-174). Set by the frame when it accepts a write; cleared when a send is staged or finds the
   * host already holds it, and by `beginMount`.
   */
  writePending?: boolean
  /** The mount generation whose lost edits were last reported, so the person is told once per mount. */
  lostReportedFor?: number
  /** What that instance showed when it was reported; a later edit there is reported again. */
  lostReportedMark?: string
  disposed: boolean
}

/** Replace the current mount. Every timer the old instance scheduled must be cancelled by the caller first. */
export function beginMount(
  state: DraftSendState,
  projectId: string,
  revision: number,
  graphVersion: number,
): EditorMount {
  state.mount = {
    generation: state.mount.generation + 1,
    projectId,
    revision,
    graphVersion,
    loaded: false,
  }
  // The edits a refused draft carried belonged to the old instance; there is nothing to resend.
  state.pendingSend = false
  state.pendingSuperseded = false
  state.writePending = false
  return state.mount
}

/**
 * Whether replacing the current mount now loses an edit the host refused as `superseded` (FL-174):
 * one it could not resend on the host's graph. The person is told; asked before `beginMount`.
 */
export const supersededEditLost = (state: DraftSendState): boolean =>
  !state.disposed && state.pendingSend && state.pendingSuperseded

/**
 * Whether replacing the current mount now loses edits the host never took (FL-174). Besides a
 * refused superseded send: once the mount has loaded, any refused send still waiting, a write whose
 * draft has not been taken (`writePending`, a send possibly still in flight), and `unsent` work the
 * frame knows of: a dirty timeline or a draft or settled-save timer the remount cancels. Asked before
 * `beginMount`.
 *
 * The edits are not flushed as a draft first: a remount puts in place a graph the host chose (its own
 * change, the person's Reload or a restore), and a draft built before it must not replace it; the
 * host would refuse it as superseded in any case. The person is told instead.
 */
export const editsLostOnRemount = (state: DraftSendState, unsent: boolean): boolean =>
  supersededEditLost(state) ||
  (!state.disposed &&
    state.mount.loaded &&
    (unsent || state.pendingSend || state.writePending === true))

/**
 * Whether to tell the person that edits of mount `generation` were lost (FL-174). True once per
 * mount, so a remount and a refusal arriving after it do not both show the notice, unless `mark`
 * (what that instance shows) changed since it was reported: the replaced instance stays on screen,
 * and editable, until the new one renders, and an edit made there after the notice is lost too.
 * Without a mark, a report for the same mount is never repeated.
 */
export function reportLost(state: DraftSendState, generation: number, mark?: string): boolean {
  if (state.disposed) return false
  if (
    state.lostReportedFor === generation &&
    (mark === undefined || mark === state.lostReportedMark)
  )
    return false
  if (state.lostReportedFor !== generation || mark !== undefined) state.lostReportedMark = mark
  state.lostReportedFor = generation
  return true
}

/** The mount's timeline finished loading: from now on its writes are drafts. */
export function markLoaded(state: DraftSendState, mount: EditorMount): void {
  if (state.mount === mount) mount.loaded = true
}

/** A timer the current mount armed (a draft debounce, a settled-save timer). */
export type MountTimer = ReturnType<typeof setTimeout>

/**
 * Cancel a timer the current mount armed and stop tracking it (FL-187). A timer left to fire removes
 * itself from `timers`, but one a later edit supersedes (`watchDrafts`, `watchDirty` debounce a burst
 * of writes into one) is only ever cleared, never removed on its own; without this, `timers` keeps a
 * dead entry for every superseded debounce, for as long as the mount lives.
 */
export function cancelMountTimer(timers: Set<MountTimer>, timer: MountTimer | null): void {
  if (timer === null) return
  clearTimeout(timer)
  timers.delete(timer)
}

/** Cancel every timer the current mount armed (FL-187): a remount or a dispose owns none of them. */
export function releaseMountTimers(timers: Set<MountTimer>): void {
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
}

/**
 * Freecut's `loadTimeline` for `projectId` ended. Only a load that succeeded, for the current mount,
 * makes it loaded: that load read the mount's own file, which holds the seeded head (no save may
 * write it before then). A failed load leaves the stores on the replaced timeline, so the mount stays
 * unloaded: it may not save and nothing it writes is sent.
 */
export function loadFinished(
  state: DraftSendState,
  projectId: string,
  ok: boolean,
): 'loaded' | 'failed' | 'ignored' {
  const { mount } = state
  if (state.disposed || mount.projectId !== projectId || mount.loaded) return 'ignored'
  if (!ok) return 'failed'
  markLoaded(state, mount)
  return 'loaded'
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
  stage: (
    graph: unknown,
    baseRevision: number,
    graphVersion: number,
  ) => Promise<{ status: string; reason?: string }>
  dirty: (dirty: boolean) => void
  /** A refused edit's mount was replaced by the host's graph before it could go again (FL-174). */
  lost?: () => void
}

const isSuperseded = (result: { status: string; reason?: string }): boolean =>
  result.status === 'rejected' && result.reason === 'superseded'

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
  // Taken before the read, like the base: the graph read next was built on this version or a newer one.
  const version = mount.graphVersion
  const text = await io.read(mount)
  if (!text || !acceptsWrite(state, mount)) return
  let graph: unknown
  try {
    graph = JSON.parse(text)
  } catch {
    return
  }
  const content = io.contentOf(graph)
  if (content === state.hostContent) {
    if (state.mount === mount) state.writePending = false
    return
  }
  const result: { status: string; reason?: string } = await io
    .stage(graph, base, version)
    .catch(() => ({ status: 'rejected' }))
  // A remount meanwhile owns hostContent and pendingSend now; the host judged this draft on its base.
  if (!acceptsWrite(state, mount)) {
    // The host's own graph replaced this mount before the refused edit could go again (FL-174).
    if (isSuperseded(result) && reportLost(state, mount.generation)) io.lost?.()
    return
  }
  if (result.status === 'staged') {
    state.hostContent = content
    state.pendingSend = false
    state.pendingSuperseded = false
    state.writePending = false
    io.dirty(false)
  } else if (isSuperseded(result) && mount.graphVersion > version) {
    // The mount took the host's newer graph meanwhile (it already showed it), so what it shows now is
    // built on the host's change: send that instead.
    await sendEditorDraft(state, mount, io)
  } else if (result.status === 'rejected' && result.reason === 'invalid') {
    // The host could not read this draft at all (a malformed build); the same draft would be refused
    // again, so it is not queued for another send. The edit stays unsent, and a remount reports it.
    state.pendingSend = false
    io.dirty(true)
  } else {
    // Kept in the editor and sent again when the host can take it; the host's banner says why. A
    // superseded one goes again once the mount takes the host's graph, or is lost with the mount.
    state.pendingSend = true
    state.pendingSuperseded = isSuperseded(result)
    io.dirty(true)
  }
}
