import { describe, expect, it } from 'vite-plus/test'
import {
  acceptsWrite,
  beginMount,
  confirmEcho,
  loadFinished,
  markLoaded,
  reconcileHostGraph,
  saveMayStart,
  sendEditorDraft,
  shouldReloadFromHost,
  shouldResendDraft,
  supersededEditLost,
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
    mount: { generation: 0, projectId: 'p', revision: 3, graphVersion: 0, loaded: true },
    pendingSend: false,
    pendingSuperseded: false,
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
  pendingSaves: Array<{ projectId: string; content: string }> = []
  pendingSends: EditorMount[] = []
  staged: Array<{ base: number; graph: string; lineage: number }> = []
  private counter = 0

  /** `perMountFiles: false` models the frame without per-mount project files (every mount writes `p`). */
  constructor(private readonly perMountFiles = true) {}

  edit() {
    if (!this.live.loaded || this.live !== this.state.mount) return
    const next = `e${(this.counter += 1)}`
    this.parent.set(next, this.store)
    this.store = next
  }

  /**
   * `saveTimeline` (settled timer, Freecut's interval autosave, Ctrl+S, media deletion) of the
   * instance on screen. The gate judges it as it starts; one it lets through snapshots the store now.
   */
  startSave() {
    if (!saveMayStart(this.state, this.live.projectId)) return
    this.pendingSaves.push({ projectId: this.live.projectId, content: this.store })
  }

  /**
   * `loadTimeline`'s own migration write, which no gate sees: while the rendered instance loads, it
   * rewrites its file with the normalized head it then hydrates.
   */
  migrate() {
    const mount = this.live
    if (mount !== this.state.mount || mount.loaded) return
    const migrated = `${this.seeded.get(mount)}~`
    this.parent.set(migrated, this.seeded.get(mount)!)
    this.seeded.set(mount, migrated)
    this.pendingSaves.push({ projectId: mount.projectId, content: migrated })
    this.landSave(this.pendingSaves.length - 1)
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
    const mount = beginMount(this.state, projectId, this.host.revision, 0)
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

  /** The rendered instance's `loadTimeline` succeeds: the store holds the (migrated) head it read. */
  hydrate() {
    if (this.live !== this.state.mount || this.live.loaded) return
    this.store = this.seeded.get(this.live) ?? this.store
    loadFinished(this.state, this.live.projectId, true)
  }

  /** The rendered instance's `loadTimeline` fails: the store keeps the replaced timeline. */
  failLoad() {
    if (this.live !== this.state.mount || this.live.loaded) return
    loadFinished(this.state, this.live.projectId, false)
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

  it('refuses a Freecut interval autosave the new instance starts while it is still loading', async () => {
    const frame = new Frame()
    frame.edit()
    frame.reload()
    frame.render()
    // The store still holds the old instance's timeline; a save now would snapshot it.
    frame.startSave()
    expect(frame.pendingSaves).toEqual([])
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
      mount: { generation: 0, projectId: 'p', revision: 3, graphVersion: 0, loaded: true },
      pendingSend: false,
      pendingSuperseded: false,
      disposed: false,
    }
    const mount = beginMount(state, 'p-m1', 4, 0)
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
        const pick = Math.floor(random() * 10)
        if (pick === 0) frame.edit()
        else if (pick === 1) frame.startSave()
        else if (pick === 2) frame.landSave(Math.floor(random() * frame.pendingSaves.length))
        else if (pick === 3) frame.reload()
        else if (pick === 4) frame.render()
        else if (pick === 5) frame.hydrate()
        else if (pick === 6) frame.echo()
        else if (pick === 8) frame.migrate()
        else if (pick === 9 && random() < 0.3) frame.failLoad()
        else if (pick === 7) await frame.flushSends()
      }
      while (frame.pendingSaves.length > 0) frame.landSave()
      await frame.flushSends()
      frame.assertBasesNeverNewer()
    }
  })

  // A save that starts while the new mount loads would snapshot the replaced timeline from Freecut's
  // global stores and, landing after the load, be taken for the new mount's own write.
  it('never lets a save started while loading land after the load completes', async () => {
    const frame = new Frame()
    frame.edit()
    frame.reload()
    frame.render()
    frame.startSave() // snapshots the old timeline: the stores are not hydrated yet
    frame.hydrate()
    frame.landSave()
    await frame.flushSends()
    expect(frame.staged).toEqual([])
  })

  it('keeps a mount whose load failed from ever saving or sending', async () => {
    const frame = new Frame()
    frame.edit() // the old instance's timeline, still in the stores after the failed load
    frame.reload()
    frame.render()
    frame.failLoad()
    expect(frame.state.mount.loaded).toBe(false)
    frame.startSave() // Freecut's autosave with the stale dirty flag
    frame.landSave()
    await frame.flushSends()
    expect(frame.pendingSaves).toEqual([])
    expect(frame.staged).toEqual([])
    expect(loadFinished(frame.state, 'elsewhere', true)).toBe('ignored')
  })
})

/** Let every continuation of a settled step run (reads, stage answers, a resend). */
const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

type StageAnswer = { status: string; reason?: string }

/**
 * FL-174: the host's own graph (a canonical command or undo, staged as the host's draft) against the
 * editor's drafts, with every message in flight on its own:
 *
 * - The host keeps one draft. A command replaces it with the command's graph, built on the draft, and
 *   advances `graphVersion`; an editor draft replaces it too, unless it was loaded from an older
 *   version (`superseded`), which is what the project session does.
 * - Each change of the host's graph posts an update carrying that graph and version; updates reach
 *   the frame in order, later than the host made them.
 * - The editor's drafts reach the host, and the host's answers reach the editor, later still.
 *
 * Every content string knows its parent. The one property: the host's graph always descends from
 * every command issued, so no command's effect is ever replaced by an editor graph that lacks it.
 */
class CommandFrame {
  parent = new Map<string, string>()
  host = { revision: 3, head: 'r3', draft: null as string | null, graphVersion: 0 }
  state: DraftSendState = {
    hostContent: 'r3',
    mount: { generation: 0, projectId: 'p', revision: 3, graphVersion: 0, loaded: true },
    pendingSend: false,
    pendingSuperseded: false,
    disposed: false,
  }
  files = new Map<string, string>([['p', 'r3']])
  commands: string[] = []
  updates: Array<{ graph: string; version: number; revision: number }> = []
  arrivals: Array<{ graph: string; version: number; resolve: (answer: StageAnswer) => void }> = []
  answers: Array<() => void> = []
  lost = 0
  private counter = 0

  get hostGraph() {
    return this.host.draft ?? this.host.head
  }

  private posted() {
    this.updates.push({
      graph: this.hostGraph,
      version: this.host.graphVersion,
      revision: this.host.revision,
    })
  }

  /** The person edits; the settled save writes the mount's own file. */
  edit() {
    const mount = this.state.mount
    if (!mount.loaded) return
    const next = `e${(this.counter += 1)}`
    this.parent.set(next, this.files.get(mount.projectId) ?? '')
    this.files.set(mount.projectId, next)
  }

  /** `watchDrafts` sends what the mount wrote. */
  send() {
    void sendEditorDraft(this.state, this.state.mount, {
      read: (from) => Promise.resolve(JSON.stringify(this.files.get(from.projectId) ?? null)),
      contentOf: String,
      stage: (graph, _base, version) =>
        new Promise<StageAnswer>((resolve) =>
          this.arrivals.push({ graph: String(graph), version, resolve }),
        ),
      dirty: () => undefined,
      lost: () => {
        this.lost += 1
      },
    })
  }

  /** The host decides the oldest editor draft as it arrives; the answer travels back later. */
  arrive() {
    const arrival = this.arrivals.shift()
    if (!arrival) return
    if (arrival.version < this.host.graphVersion) {
      this.answers.push(() => arrival.resolve({ status: 'rejected', reason: 'superseded' }))
      return
    }
    this.host.draft = arrival.graph
    this.posted()
    this.answers.push(() => arrival.resolve({ status: 'staged' }))
  }

  answer() {
    this.answers.shift()?.()
  }

  /** A canonical command (or undo) applied by the host to its graph and staged as its own draft. */
  command() {
    const next = `c${(this.counter += 1)}`
    this.parent.set(next, this.hostGraph)
    this.host.draft = next
    this.host.graphVersion += 1
    this.commands.push(next)
    this.posted()
  }

  /** Autosave stores the host's draft. */
  save() {
    if (this.host.draft === null) return
    this.host.head = this.host.draft
    this.host.draft = null
    this.host.revision += 1
    this.posted()
  }

  /** The oldest update reaches the frame: `update()` in `editor-frame.tsx`. */
  update() {
    const update = this.updates.shift()
    if (!update) return
    const current = this.files.get(this.state.mount.projectId) ?? ''
    const outcome = reconcileHostGraph(this.state, {
      incoming: update.graph,
      current,
      draftHeld: false,
      graphVersion: update.version,
    })
    if (outcome === 'remount') {
      if (supersededEditLost(this.state)) this.lost += 1
      const projectId = `p-m${this.state.mount.generation + 1}`
      beginMount(this.state, projectId, update.revision, update.version)
      this.state.hostContent = update.graph
      this.files.set(projectId, update.graph)
    } else if (outcome === 'echo') {
      this.state.hostContent = update.graph
      confirmEcho(this.state, update.graph, current, update.revision)
    }
    if (shouldResendDraft({ pending: this.state.pendingSend, online: true, hasLease: true }))
      this.send()
  }

  hydrate() {
    const mount = this.state.mount
    if (!mount.loaded) loadFinished(this.state, mount.projectId, true)
  }

  descends(content: string, ancestor: string): boolean {
    for (let at: string | undefined = content; at !== undefined; at = this.parent.get(at)) {
      if (at === ancestor) return true
    }
    return false
  }

  assertCommandsKept() {
    for (const command of this.commands) expect(this.descends(this.hostGraph, command)).toBe(true)
  }

  async drain() {
    this.hydrate()
    while (this.updates.length + this.arrivals.length + this.answers.length > 0) {
      this.update()
      this.arrive()
      this.answer()
      this.hydrate()
      await settle()
    }
  }
}

describe('host commands and editor drafts (FL-174)', () => {
  it('refuses an editor draft that reaches the host after a command and before the remount', async () => {
    const frame = new CommandFrame()
    frame.edit() // e1, on r3
    frame.send()
    await settle()
    frame.command() // c2, the command applied to r3 and staged by the host; its update is on its way
    frame.arrive() // e1 arrives: loaded from version 0 while the host is at 1
    expect(frame.hostGraph).toBe('c2')
    frame.answer()
    await settle()
    expect(frame.state).toMatchObject({ pendingSend: true, pendingSuperseded: true })

    // The update: the editor does not show c2, so it remounts to it. e1 is gone and the person is told.
    frame.update()
    expect(frame.state.mount).toMatchObject({ projectId: 'p-m1', graphVersion: 1, loaded: false })
    expect(frame.lost).toBe(1)
    expect(frame.state.pendingSend).toBe(false)

    // The new instance's edits are built on the command and are taken.
    frame.hydrate()
    frame.edit() // e3, on c2
    frame.send()
    await settle()
    frame.arrive()
    frame.answer()
    await settle()
    expect(frame.hostGraph).toBe('e3')
    frame.assertCommandsKept()
  })

  it('tells the person when the refusal arrives after the remount already replaced the editor', async () => {
    const frame = new CommandFrame()
    frame.edit()
    frame.send()
    await settle()
    frame.command()
    frame.arrive()
    frame.update() // the remount happens before the answer arrives
    expect(frame.lost).toBe(0)
    frame.answer()
    await settle()
    expect(frame.lost).toBe(1)
    expect(frame.state.pendingSend).toBe(false)
    expect(frame.hostGraph).toBe('c2')
  })

  it('sends again at once when the mount took the host’s newer graph while the refusal travelled', async () => {
    const state: DraftSendState = {
      hostContent: 'r3',
      mount: { generation: 0, projectId: 'p', revision: 3, graphVersion: 0, loaded: true },
      pendingSend: false,
      pendingSuperseded: false,
      disposed: false,
    }
    const sent: Array<{ graph: string; version: number }> = []
    const answer = deferred<StageAnswer>()
    let file = 'e1'
    const sending = sendEditorDraft(state, state.mount, {
      read: async () => JSON.stringify(file),
      contentOf: String,
      stage: (graph, _base, version) => {
        sent.push({ graph: String(graph), version })
        return sent.length === 1 ? answer.promise : Promise.resolve({ status: 'staged' })
      },
      dirty: () => undefined,
    })
    await settle()
    // The host's newer graph is exactly what the editor shows by now (e2): the mount takes version 1.
    file = 'e2'
    expect(
      reconcileHostGraph(state, {
        incoming: 'e2',
        current: 'e2',
        draftHeld: false,
        graphVersion: 1,
      }),
    ).toBe('echo')
    expect(state.mount.graphVersion).toBe(1)
    answer.resolve({ status: 'rejected', reason: 'superseded' })
    await sending
    expect(sent).toEqual([
      { graph: 'e1', version: 0 },
      { graph: 'e2', version: 1 },
    ])
    expect(state).toMatchObject({ pendingSend: false, pendingSuperseded: false, hostContent: 'e2' })
  })

  it('reloads for the host’s own newer graph even while it holds undecided edits', () => {
    const state: DraftSendState = {
      hostContent: 'mine',
      mount: { generation: 0, projectId: 'p', revision: 3, graphVersion: 0, loaded: true },
      pendingSend: false,
      pendingSuperseded: false,
      disposed: false,
    }
    const held = { incoming: 'head', current: 'mine', draftHeld: true }
    expect(reconcileHostGraph(state, { ...held, graphVersion: 0 })).toBe('hold')
    expect(reconcileHostGraph(state, { ...held, graphVersion: 1 })).toBe('remount')
    expect(state.mount.graphVersion).toBe(0)
    expect(reconcileHostGraph(state, { ...held, draftHeld: false, graphVersion: 0 })).toBe(
      'remount',
    )
    expect(
      reconcileHostGraph(state, {
        incoming: 'mine',
        current: 'mine',
        draftHeld: false,
        graphVersion: 0,
      }),
    ).toBe('echo')
  })

  it('never lets an editor graph replace a command’s effect, under any interleaving', async () => {
    let seed = 0x174
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    for (let run = 0; run < 200; run += 1) {
      const frame = new CommandFrame()
      for (let step = 0; step < 60; step += 1) {
        const pick = Math.floor(random() * 9)
        if (pick === 0) frame.edit()
        else if (pick === 1) frame.send()
        else if (pick === 2) frame.arrive()
        else if (pick === 3) frame.answer()
        else if (pick === 4) frame.command()
        else if (pick === 5) frame.save()
        else if (pick === 6) frame.update()
        else if (pick === 7) frame.hydrate()
        await settle()
        frame.assertCommandsKept()
      }
      await frame.drain()
      frame.assertCommandsKept()

      // Once everything has arrived, the editor is on the host's latest graph and its edits are taken.
      frame.edit()
      frame.send()
      await settle()
      await frame.drain()
      expect(frame.state.mount.graphVersion).toBe(frame.host.graphVersion)
      expect(frame.hostGraph).toBe(frame.files.get(frame.state.mount.projectId))
      frame.assertCommandsKept()
    }
  })
})
