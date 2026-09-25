import { describe, expect, it } from 'vite-plus/test'
import {
  acceptsWrite,
  beginMount,
  confirmEcho,
  markLoaded,
  sendEditorDraft,
  shouldReloadFromHost,
  shouldResendDraft,
  type DraftSendState,
  type EditorMount,
} from '../src/draft-sync'

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

/** One editor instance: the timeline it shows and every timeline it has shown (its lineage). */
interface Instance {
  mount: EditorMount
  timeline: string
  history: Set<string>
}

/**
 * A model of the editor frame around the draft rules: per-mount project files, instances that keep
 * writing to their own file after they are replaced, a host that stores a draft only on its head.
 */
class Frame {
  host = { revision: 3, content: 'r3' }
  /** Every stored revision's content. */
  revisions = new Map<number, string>([[3, 'r3']])
  state: DraftSendState = {
    hostContent: 'r3',
    mount: { generation: 0, projectId: 'p', revision: 3, loaded: true },
    pendingSend: false,
    disposed: false,
  }
  files = new Map<string, string>([['p', 'r3']])
  instances: Instance[] = [{ mount: this.state.mount, timeline: 'r3', history: new Set(['r3']) }]
  live: Instance = this.instances[0]!
  /** Each stage: its base, and the newest revision the producing instance's timeline descends from. */
  staged: Array<{ base: number; descendsFrom: number }> = []
  sends: Array<Promise<void>> = []
  private edits = 0

  instanceOf(mount: EditorMount) {
    return this.instances.find((instance) => instance.mount === mount)!
  }

  edit() {
    this.edits += 1
    this.live.timeline = `edit-${this.edits}`
    this.live.history.add(this.live.timeline)
  }

  /** The newest stored revision whose content this instance has shown: its edits build on it. */
  descendsFrom(instance: Instance) {
    let newest = -1
    for (const [revision, content] of this.revisions)
      if (instance.history.has(content)) newest = Math.max(newest, revision)
    return newest
  }

  store(content: string) {
    this.host = { revision: this.host.revision + 1, content }
    this.revisions.set(this.host.revision, content)
  }

  /** Freecut's save (settled timer or interval autosave) of an instance, into its own file. */
  save(instance: Instance) {
    this.files.set(instance.mount.projectId, instance.timeline)
    // watchDrafts: only the current mount's file, only once it is loaded.
    const mount = this.state.mount
    if (instance.mount.projectId === mount.projectId && acceptsWrite(this.state, mount))
      this.sends.push(this.send(mount))
  }

  send(mount: EditorMount, read?: Promise<string | null>) {
    return sendEditorDraft(this.state, mount, {
      // Freecut's project.json: the timeline stands in for the whole document.
      read: (from) =>
        read ?? Promise.resolve(JSON.stringify(this.files.get(from.projectId) ?? null)),
      contentOf: (graph) => String(graph),
      stage: async (graph, base) => {
        this.staged.push({ base, descendsFrom: this.descendsFrom(this.instanceOf(mount)) })
        if (base !== this.host.revision) return { status: 'rejected' }
        this.store(String(graph))
        return { status: 'staged' }
      },
      dirty: () => undefined,
    })
  }

  /** Another window saves, and the host pushes its head: the reload branch begins a new mount. */
  reload(content = `theirs-${this.host.revision + 1}`) {
    this.store(content)
    const mount = beginMount(
      this.state,
      `p-m${this.state.mount.generation + 1}`,
      this.host.revision,
    )
    this.state.hostContent = content
    this.files.set(mount.projectId, content)
    this.instances.push({ mount, timeline: content, history: new Set([content]) })
    return mount
  }

  /** Seeding finished: the new instance renders and its timeline loads. */
  seedResolve() {
    const newest = this.instances.at(-1)!
    if (newest === this.live || newest.mount !== this.state.mount) return
    this.live = newest
    markLoaded(this.state, newest.mount)
  }

  /** The host's context arrives: the echo path (update()'s else branch). */
  echo() {
    const current = this.files.get(this.state.mount.projectId) ?? ''
    confirmEcho(this.state, this.host.content, current, this.host.revision)
  }
}

/** The one property: a staged base is never newer than what the producing instance descends from. */
const assertBasesNeverNewer = (frame: Frame) => {
  for (const { base, descendsFrom } of frame.staged) expect(base).toBeLessThanOrEqual(descendsFrom)
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

  it('drops a pending saveTimeline of the replaced instance that lands during a slow seed', async () => {
    const frame = new Frame()
    const old = frame.live
    frame.edit()
    frame.reload()
    // The old instance's settled save fires while the new one is still seeding.
    frame.save(old)
    await Promise.all(frame.sends)
    expect(frame.staged).toEqual([])
    frame.seedResolve()
    // Even after the new mount has loaded, the old instance writes only its own file.
    frame.save(old)
    await Promise.all(frame.sends)
    expect(frame.staged).toEqual([])
    expect(frame.host).toEqual({ revision: 4, content: 'theirs-4' })
  })

  it('ignores a Freecut interval autosave of the old instance during the remount', async () => {
    const frame = new Frame()
    const old = frame.live
    frame.reload()
    frame.edit() // still the old instance: the new one has not rendered yet
    frame.save(old)
    frame.seedResolve()
    frame.save(old)
    await Promise.all(frame.sends)
    expect(frame.staged).toEqual([])
    // The new instance's own writes are drafts, based on the head it loaded.
    frame.edit()
    frame.save(frame.live)
    await Promise.all(frame.sends)
    expect(frame.staged).toEqual([{ base: 4, descendsFrom: 4 }])
    expect(frame.host.revision).toBe(5)
  })

  it('drops a send whose mount a restore or canonical-command reload replaced mid-send', async () => {
    const frame = new Frame()
    frame.edit()
    const reading = deferred<string | null>()
    const mount = frame.state.mount
    const sending = frame.send(mount, reading.promise)
    frame.reload('restored-4')
    reading.resolve(JSON.stringify(frame.live.timeline))
    await sending
    expect(frame.staged).toEqual([])

    // A reload during staging leaves the new mount in charge of hostContent and pendingSend.
    frame.seedResolve()
    frame.edit()
    const staged = deferred<{ status: string }>()
    const sendState = frame.state
    const pending = sendEditorDraft(sendState, sendState.mount, {
      read: async () => JSON.stringify(frame.live.timeline),
      contentOf: String,
      stage: () => staged.promise,
      dirty: () => undefined,
    })
    await Promise.resolve()
    await Promise.resolve()
    frame.reload('command-5')
    staged.resolve({ status: 'rejected' })
    await pending
    expect(frame.state).toMatchObject({ hostContent: 'command-5', pendingSend: false })
  })

  it('never sends a base newer than the sending mount loaded, under any interleaving', async () => {
    let seed = 0x5eed
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    for (let run = 0; run < 300; run += 1) {
      const frame = new Frame()
      for (let step = 0; step < 40; step += 1) {
        const pick = Math.floor(random() * 6)
        if (pick === 0) frame.edit()
        else if (pick === 1) {
          // A save timer of any instance still alive in memory, the replaced ones included.
          const instance = frame.instances[Math.floor(random() * frame.instances.length)]!
          frame.save(instance)
        } else if (pick === 2) frame.reload()
        else if (pick === 3) frame.seedResolve()
        else if (pick === 4) frame.echo()
        else await Promise.all(frame.sends.splice(0))
      }
      await Promise.all(frame.sends.splice(0))
      assertBasesNeverNewer(frame)
    }
  })
})
