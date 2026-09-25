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

/** The part of the editor frame's session a draft send reads and updates. */
export interface DraftSendState {
  hostContent: string
  hostRevision: number
  /** Bumped whenever the host's graph replaces the editor's (reload, restore, canonical command). */
  generation: number
  pendingSend: boolean
  disposed: boolean
}

export interface DraftSendIo {
  read: () => Promise<string | null>
  contentOf: (graph: unknown) => string
  stage: (graph: unknown, baseRevision: number) => Promise<{ status: string }>
  dirty: (dirty: boolean) => void
}

/**
 * Send the editor's graph as a draft. The revision and generation are taken before anything is
 * awaited: a reload landing mid-send replaces the graph being read, so that send is dropped, and a
 * graph is never sent with the revision of a head it was not loaded from.
 */
export async function sendEditorDraft(state: DraftSendState, io: DraftSendIo): Promise<void> {
  if (state.disposed) return
  const { generation, hostRevision } = state
  const text = await io.read()
  if (!text || state.generation !== generation) return
  let graph: unknown
  try {
    graph = JSON.parse(text)
  } catch {
    return
  }
  const content = io.contentOf(graph)
  if (content === state.hostContent) return
  const result = await io.stage(graph, hostRevision).catch(() => ({ status: 'rejected' }))
  // A reload meanwhile owns hostContent and pendingSend now; the host judged this draft on its base.
  if (state.generation !== generation) return
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
