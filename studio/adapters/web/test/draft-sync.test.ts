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

/**
 * A model of the editor frame around the draft rules, faithful to what Freecut does:
 *
 * - One global timeline store, shared by every editor instance (Freecut's zustand stores).
 * - `saveTimeline` snapshots that store when it starts and writes later (after its thumbnail work)
 *   into the project file of the instance that started it; a replaced instance's save can land
 *   after the new one has loaded.
 * - A new instance loads in two steps: it renders (the store still holds the old timeline, and any
 *   save it makes now, like a migration write, snapshots that old timeline), then hydrates.
 * - The host stores a draft only when its base is the head.
 *
 * Every content string knows its parent (the timeline it was edited from) and the revision it was
 * stored as, if any; its lineage is the newest stored revision among itself and its ancestors. The
 * one property: a draft's base is never newer than the lineage of the graph it carries.
 */
class Frame {
  host = { revision: 3, content: 'r3' }
  parent = new Map<string, string>()
  storedAs = new Map<string, number>([['r3', 3]])
  state: DraftSendState = {
    hostContent: 'r3',
    mount: { generation: 0, projectId: 'p', revision: 3, loaded: true },
    pendingSend: false,
    disposed: false,
  }
  files = new Map<string, string>([['p', 'r3']])
  /** The global timeline store. */
  store = 'r3'
  /** Mounts in order; the last rendered one is the editor on screen. */
  mounts: EditorMount[] = [this.state.mount]
  /** The graph each mount was seeded with: what its `loadTimeline` reads. */
  seeded = new Map<EditorMount, string>([[this.state.mount, 'r3']])
  live: EditorMount = this.state.mount
  pendingSaves: Array<{ projectId: string; content: string; whileLoading: boolean }> = []
  pendingSends: EditorMount[] = []
  staged: Array<{ base: number; graph: string; lineage: number }> = []
  private counter = 0

  /**
   * `perMountFiles: false` models the frame without per-mount project files (every mount writes
   * `p`). `loadingSavesLandLate: false` lands every save started while loading before that load
   * completes; `true` lets one land afterwards (the known gap, see the `it.fails` reproduction).
   */
  constructor(
    private readonly perMountFiles = true,
    private readonly loadingSavesLandLate = false,
  ) {}

  edit() {
    if (!this.live.loaded || this.live !== this.state.mount) return
    const next = `e${(this.counter += 1)}`
    this.parent.set(next, this.store)
    this.store = next
  }

  /** `saveTimeline` (settled timer, interval autosave, migration) of the instance on screen. */
  startSave() {
    this.pendingSaves.push({
      projectId: this.live.projectId,
      content: this.store,
      whileLoading: !this.live.loaded,
    })
  }

  /** A save's `updateProject` lands; `watchDrafts` sees the write. */
  landSave(index = 0) {
    const [save] = this.pendingSaves.splice(index, 1)
    if (!save) return
    this.files.set(save.projectId, save.content)
    const mount = this.state.mount
    if (save.projectId === mount.projectId && acceptsWrite(this.state, mount))
      this.pendingSends.push(mount)
  }

  send(mount: EditorMount, read?: Promise<string | null>) {
    return sendEditorDraft(this.state, mount, {
      read: (from) =>
        read ?? Promise.resolve(JSON.stringify(this.files.get(from.projectId) ?? null)),
      contentOf: (graph) => String(graph),
      stage: async (graph, base) => {
        const content = String(graph)
        this.staged.push({ base, graph: content, lineage: this.lineageOf(content) })
        if (base !== this.host.revision) return { status: 'rejected' }
        this.stored(content)
        return { status: 'staged' }
      },
      dirty: () => undefined,
    })
  }

  async flushSends() {
    await Promise.all(this.pendingSends.splice(0).map((mount) => this.send(mount)))
  }

  private stored(content: string) {
    this.host = { revision: this.host.revision + 1, content }
    this.storedAs.set(content, this.host.revision)
  }

  lineageOf(content: string): number {
    const parent = this.parent.get(content)
    return Math.max(this.storedAs.get(content) ?? -1, parent ? this.lineageOf(parent) : -1)
  }

  /** Another window's save (or a restore, or a canonical command) reaches the host; remount begins. */
  reload() {
    this.stored(`t${(this.counter += 1)}`)
    const projectId = this.perMountFiles ? `p-m${this.state.mount.generation + 1}` : 'p'
    const mount = beginMount(this.state, projectId, this.host.revision)
    this.state.hostContent = this.host.content
    this.files.set(projectId, this.host.content)
    this.seeded.set(mount, this.host.content)
    this.mounts.push(mount)
    return mount
  }

  /** Seeding finished and the new instance renders; its timeline starts loading. */
  render() {
    const newest = this.mounts.at(-1)!
    if (newest !== this.state.mount || newest === this.live) return
    this.live = newest
  }

  /**
   * The rendered instance's `loadTimeline` finishes: the store holds the graph it read, which is the
   * seeded head (Freecut reads the file when the load starts, before a save made while loading lands).
   */
  hydrate() {
    if (this.live !== this.state.mount || this.live.loaded) return
    if (!this.loadingSavesLandLate)
      for (let index = this.pendingSaves.length - 1; index >= 0; index -= 1)
        if (this.pendingSaves[index]!.whileLoading) this.landSave(index)
    this.store = this.seeded.get(this.live) ?? this.store
    markLoaded(this.state, this.live)
  }

  /** The host's context arrives with its head (update()'s echo branch). */
  echo() {
    this.state.hostContent = this.host.content
    const current = this.files.get(this.state.mount.projectId) ?? ''
    confirmEcho(this.state, this.host.content, current, this.host.revision)
  }

  assertBasesNeverNewer() {
    for (const { base, lineage } of this.staged) expect(base).toBeLessThanOrEqual(lineage)
  }
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

  it('drops the replaced instance’s pending send and late saveTimeline around a slow seed', async () => {
    const frame = new Frame()
    frame.edit()
    frame.startSave()
    frame.landSave() // written and queued as a draft of mount 0...
    frame.edit()
    frame.startSave() // ...and another save still generating its thumbnail
    frame.reload()
    await frame.flushSends() // the queued send runs while the new mount is still seeding
    frame.render()
    frame.hydrate()
    frame.landSave() // the old instance's updateProject lands after the new mount loaded
    await frame.flushSends()
    expect(frame.staged).toEqual([])
    expect(frame.host).toEqual({ revision: 4, content: 't3' })
  })

  it('drops a Freecut interval autosave the new instance makes while it is still loading', async () => {
    const frame = new Frame()
    frame.edit()
    frame.reload()
    frame.render()
    // The store still holds the old instance's timeline; the save snapshots it into the new file.
    frame.startSave()
    frame.landSave()
    await frame.flushSends()
    expect(frame.staged).toEqual([])
    frame.hydrate()
    frame.edit()
    frame.startSave()
    frame.landSave()
    await frame.flushSends()
    expect(frame.staged).toEqual([{ base: 4, graph: 'e3', lineage: 4 }])
    expect(frame.host.revision).toBe(5)
  })

  it('drops a send whose mount a restore or canonical-command reload replaced mid-send', async () => {
    const frame = new Frame()
    frame.edit()
    frame.startSave()
    frame.landSave()
    frame.pendingSends.length = 0
    // The read is still pending when the restore lands.
    const reading = deferred<string | null>()
    const sending = frame.send(frame.state.mount, reading.promise)
    frame.reload()
    reading.resolve(JSON.stringify('e1'))
    await sending
    expect(frame.staged).toEqual([])

    // A canonical-command reload while the host is staging leaves the new mount in charge.
    frame.render()
    frame.hydrate()
    frame.edit()
    const staged = deferred<{ status: string }>()
    const mount = frame.state.mount
    const pending = sendEditorDraft(frame.state, mount, {
      read: async () => JSON.stringify(frame.store),
      contentOf: String,
      stage: () => staged.promise,
      dirty: () => undefined,
    })
    await Promise.resolve()
    await Promise.resolve()
    frame.reload()
    staged.resolve({ status: 'rejected' })
    await pending
    expect(frame.state).toMatchObject({ hostContent: frame.host.content, pendingSend: false })
  })

  it('never lets a mount that is still loading turn a write into a draft', async () => {
    const state: DraftSendState = {
      hostContent: 'r3',
      mount: { generation: 0, projectId: 'p', revision: 3, loaded: true },
      pendingSend: false,
      disposed: false,
    }
    const mount = beginMount(state, 'p-m1', 4)
    expect(acceptsWrite(state, mount)).toBe(false)
    let reads = 0
    const io = {
      read: async () => {
        reads += 1
        return JSON.stringify('migrated')
      },
      contentOf: String,
      stage: async () => ({ status: 'staged' }),
      dirty: () => undefined,
    }
    await sendEditorDraft(state, mount, io)
    expect(reads).toBe(0)
    markLoaded(state, mount)
    expect(acceptsWrite(state, mount)).toBe(true)
    await sendEditorDraft(state, mount, io)
    expect(reads).toBe(1)
  })

  it('never sends a base newer than the graph it carries, under any interleaving', async () => {
    let seed = 0x5eed
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    for (let run = 0; run < 400; run += 1) {
      const frame = new Frame()
      for (let step = 0; step < 50; step += 1) {
        const pick = Math.floor(random() * 8)
        if (pick === 0) frame.edit()
        else if (pick === 1) frame.startSave()
        else if (pick === 2) frame.landSave(Math.floor(random() * frame.pendingSaves.length))
        else if (pick === 3) frame.reload()
        else if (pick === 4) frame.render()
        else if (pick === 5) frame.hydrate()
        else if (pick === 6) frame.echo()
        else await frame.flushSends()
      }
      while (frame.pendingSaves.length > 0) frame.landSave()
      await frame.flushSends()
      frame.assertBasesNeverNewer()
    }
  })

  // Known gap (reported, not fixed here): a save that starts while the new mount is loading snapshots
  // the replaced instance's timeline from Freecut's global stores; if its write lands after the load
  // completes, the mount is loaded and current, so the stale graph goes out with the new head.
  it.fails('drops a save started while loading that lands after the load completes', async () => {
    const frame = new Frame(true, true)
    frame.edit()
    frame.reload()
    frame.render()
    frame.startSave() // snapshots the old timeline: the stores are not hydrated yet
    frame.hydrate()
    frame.landSave()
    await frame.flushSends()
    expect(frame.staged).toEqual([])
  })
})
