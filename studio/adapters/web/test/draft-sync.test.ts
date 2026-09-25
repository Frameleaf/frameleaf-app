import { describe, expect, it, vi } from 'vite-plus/test'
import {
  sendEditorDraft,
  shouldReloadFromHost,
  shouldResendDraft,
  type DraftSendState,
} from '../src/draft-sync'

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const sender = (text: Promise<string | null>) => {
  const state: DraftSendState = {
    hostContent: 'head-n',
    hostRevision: 3,
    generation: 0,
    pendingSend: false,
    disposed: false,
  }
  const io = {
    read: () => text,
    contentOf: (graph: unknown) => JSON.stringify(graph),
    stage: vi.fn(async () => ({ status: 'staged' })),
    dirty: vi.fn(),
  }
  return { state, io }
}

/** What `update()`'s reload branch does to the session when the host's head replaces the editor. */
const reload = (state: DraftSendState, revision: number, content: string) => {
  state.hostContent = content
  state.hostRevision = revision
  state.generation += 1
  state.pendingSend = false
}

describe('editor frame draft sync (FL-88)', () => {
  it('reloads for a graph it did not write', () => {
    expect(
      shouldReloadFromHost({
        incoming: 'head',
        hostContent: 'mine',
        current: 'mine',
        draftHeld: false,
      }),
    ).toBe(true)
    expect(
      shouldReloadFromHost({
        incoming: 'mine',
        hostContent: 'old',
        current: 'mine',
        draftHeld: false,
      }),
    ).toBe(false)
  })

  it('keeps the person’s edits while the host holds them undecided (take-over conflict)', () => {
    expect(
      shouldReloadFromHost({
        incoming: 'head',
        hostContent: 'mine',
        current: 'mine',
        draftHeld: true,
      }),
    ).toBe(false)
  })

  it('sends a refused draft again when the connection and the lease are back', () => {
    expect(shouldResendDraft({ pending: true, online: true, hasLease: true })).toBe(true)
    expect(shouldResendDraft({ pending: true, online: false, hasLease: true })).toBe(false)
    expect(shouldResendDraft({ pending: true, online: true, hasLease: false })).toBe(false)
    expect(shouldResendDraft({ pending: false, online: true, hasLease: true })).toBe(false)
  })

  it('drops a send whose graph a reload replaced while it was being read', async () => {
    const text = deferred<string | null>()
    const { state, io } = sender(text.promise)
    const sending = sendEditorDraft(state, io)
    reload(state, 4, 'head-n+1')
    text.resolve(JSON.stringify({ stale: true }))
    await sending
    expect(io.stage).not.toHaveBeenCalled()
    expect(state).toMatchObject({ hostContent: 'head-n+1', hostRevision: 4 })
  })

  it('sends with the revision captured before the read, never one a reload set meanwhile', async () => {
    const text = deferred<string | null>()
    const { state, io } = sender(text.promise)
    const sending = sendEditorDraft(state, io)
    // A save echo of the same generation moves the revision but not the editor's graph.
    state.hostRevision = 4
    text.resolve(JSON.stringify({ mine: true }))
    await sending
    expect(io.stage).toHaveBeenCalledWith({ mine: true }, 3)
    expect(state.pendingSend).toBe(false)
    expect(io.dirty).toHaveBeenLastCalledWith(false)
  })

  it('leaves the reload in charge when it lands while the host is staging', async () => {
    const staged = deferred<{ status: string }>()
    const { state, io } = sender(Promise.resolve(JSON.stringify({ mine: true })))
    io.stage.mockImplementationOnce(() => staged.promise)
    const sending = sendEditorDraft(state, io)
    await Promise.resolve()
    await Promise.resolve()
    reload(state, 4, 'head-n+1')
    staged.resolve({ status: 'rejected' })
    await sending
    expect(io.stage).toHaveBeenCalledWith({ mine: true }, 3)
    expect(state).toMatchObject({ hostContent: 'head-n+1', pendingSend: false })
    expect(io.dirty).not.toHaveBeenCalled()
  })
})
