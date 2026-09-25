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
