import { describe, expect, it } from 'vite-plus/test'
import {
  acceptsWrite,
  beginMount,
  cancelMountTimer,
  confirmEcho,
  loadFinished,
  markLoaded,
  reconcileHostGraph,
  releaseMountTimers,
  saveMayStart,
  sendEditorDraft,
  shouldReloadFromHost,
  editsLostOnRemount,
  reportLost,
  shouldResendDraft,
  supersededEditLost,
  type DraftSendState,
  type EditorMount,
  type MountTimer,
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
    // `watchDrafts` accepted the write: a draft the host has not taken yet.
    this.state.writePending = true
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
      const replaced = this.state.mount.generation
      if (editsLostOnRemount(this.state, false) && reportLost(this.state, replaced)) this.lost += 1
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
    expect(supersededEditLost(frame.state)).toBe(true)

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

  it('tells the person once when the remount replaces an edit whose refusal is still on its way', async () => {
    const frame = new CommandFrame()
    frame.edit()
    frame.send()
    await settle()
    frame.command()
    frame.arrive()
    frame.update() // the remount happens before the answer arrives: e1 was never taken
    expect(frame.lost).toBe(1)
    frame.answer() // the refusal of the same mount's edit is not told again
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

type ModelUpdate = { graph: string; version: number; revision: number; draftHeld: boolean }

/**
 * FL-174, the whole loop: the project session, the server, and the editor frame with Freecut's own
 * behaviour, every step interleavable.
 *
 * - **Server.** Another window may save at any time (`external`); this tab learns of it only by a
 *   refused save (a conflict), a take over or a Reload.
 * - **Session.** Commands and undo stage the host's own graph and advance `graphVersion`, as do
 *   Reload, a restore and a take over that finds a moved head with no draft. Autosave stores the
 *   draft when its base is the head and turns into a conflict otherwise. The lease can be lost and
 *   taken over; a conflict or a lost lease holds the person's edits (`draftHeld`). Editor drafts
 *   follow the session's rules: refused when superseded, otherwise they join the draft, carried over
 *   the editor's own saves it has not heard of.
 * - **Frame.** One global timeline store, dirty until a save lands. Saves start through the gate and
 *   land later, in order, in the file of the instance that started them; a landed write of the
 *   current mount becomes a draft after a timer. An update remounts or confirms as `update()` does,
 *   and a remount is asynchronous: the old instance stays on screen, and editable, until the new one
 *   is seeded and rendered, and the new one saves nothing until its timeline has loaded.
 *
 * Every graph knows its parent. Two properties:
 * - the host's graph always descends from the latest graph the host put in place itself;
 * - every edit the person makes is either taken by the host (an ancestor of a graph it accepted) or
 *   its editor instance told the person its edits were lost. Nothing disappears silently.
 */
class StudioModel {
  parent = new Map<string, string>()
  private counter = 0

  server = { revision: 3, graph: 'r3' }
  host = {
    revision: 3,
    graph: 'r3',
    draft: null as string | null,
    draftBase: 3,
    draftFromEditor: false,
    graphVersion: 0,
    status: 'saved' as 'saved' | 'conflict' | 'lease-lost',
  }
  /** The editor's own saves, base → stored revision (`followEditorSaves` in the session). */
  editorSaves = new Map<number, number>()
  lastReplacement = 'r3'
  accepted: string[] = []

  state: DraftSendState = {
    hostContent: 'r3',
    mount: { generation: 0, projectId: 'p', revision: 3, graphVersion: 0, loaded: true },
    pendingSend: false,
    pendingSuperseded: false,
    disposed: false,
  }
  files = new Map<string, string>([['p', 'r3']])
  store = 'r3'
  dirty = false
  /** The instance on screen: what the person edits and what Freecut's saves are started for. */
  live: EditorMount = this.state.mount
  seeding: { mount: EditorMount; graph: string } | null = null
  pendingSaves: Array<{ projectId: string; content: string }> = []
  sendTimers: EditorMount[] = []
  /** Every edit: the instance it was made in and when. */
  edits = new Map<string, { generation: number; at: number }>()
  /** When each instance last told the person its edits were lost. */
  reports = new Map<number, number>()
  private clock = 0
  updates: ModelUpdate[] = []
  arrivals: Array<{
    graph: string
    base: number
    version: number
    resolve: (answer: StageAnswer) => void
  }> = []
  answers: Array<() => void> = []

  private node(prefix: string, parent: string) {
    const id = `${prefix}${(this.counter += 1)}`
    this.parent.set(id, parent)
    return id
  }

  get hostGraph() {
    return this.host.draft ?? this.host.graph
  }

  private post() {
    this.updates.push({
      graph: this.hostGraph,
      version: this.host.graphVersion,
      revision: this.host.revision,
      draftHeld: this.host.draft !== null && this.host.status !== 'saved',
    })
  }

  private replaceWith(graph: string, revision: number) {
    this.host.draft = null
    this.host.graph = graph
    this.host.revision = revision
    this.host.graphVersion += 1
    this.lastReplacement = graph
    this.editorSaves.clear()
  }

  /* Host and server */

  /** A canonical command (`c`) or undo (`u`): the host's own graph, staged as its draft. */
  hostChange(kind: 'c' | 'u') {
    if (this.host.status !== 'saved') return
    const graph = this.node(kind, this.hostGraph)
    if (this.host.draft === null) this.host.draftBase = this.host.revision
    this.host.draft = graph
    this.host.draftFromEditor = false
    this.host.graphVersion += 1
    this.lastReplacement = graph
    this.post()
  }

  save() {
    if (this.host.draft === null || this.host.status !== 'saved') return
    if (this.host.draftBase !== this.server.revision) {
      this.host.status = 'conflict'
      this.post()
      return
    }
    this.server = { revision: this.server.revision + 1, graph: this.host.draft }
    if (this.host.draftFromEditor) this.editorSaves.set(this.host.draftBase, this.server.revision)
    this.host.graph = this.host.draft
    this.host.revision = this.server.revision
    this.host.draft = null
    this.post()
  }

  external() {
    this.server = {
      revision: this.server.revision + 1,
      graph: this.node('x', this.server.graph),
    }
  }

  loseLease() {
    if (this.host.status !== 'saved') return
    this.host.status = 'lease-lost'
    this.post()
  }

  takeOver() {
    if (this.host.status !== 'lease-lost') return
    if (this.host.draft !== null) {
      this.host.status = this.server.revision === this.host.draftBase ? 'saved' : 'conflict'
    } else {
      if (this.server.revision !== this.host.revision)
        this.replaceWith(this.server.graph, this.server.revision)
      this.host.status = 'saved'
    }
    this.post()
  }

  /** The person's Reload: the draft is discarded and the head replaces what the editor shows. */
  reload() {
    this.replaceWith(this.server.graph, this.server.revision)
    this.host.status = 'saved'
    this.post()
  }

  restore() {
    if (this.host.status !== 'saved' || this.host.draft !== null) return
    if (this.server.revision !== this.host.revision) return
    const graph = this.node('s', this.server.graph)
    this.server = { revision: this.server.revision + 1, graph }
    this.replaceWith(graph, this.server.revision)
    this.post()
  }

  private follow(base: number) {
    let revision = base
    while (this.editorSaves.has(revision)) revision = this.editorSaves.get(revision)!
    return revision
  }

  /** The session judges the oldest editor draft as it arrives; the answer travels back later. */
  arrive() {
    const arrival = this.arrivals.shift()
    if (!arrival) return
    let answer: StageAnswer = { status: 'staged' }
    if (arrival.version < this.host.graphVersion) {
      answer = { status: 'rejected', reason: 'superseded' }
    } else {
      const base = this.host.draft === null ? this.host.revision : this.host.draftBase
      this.host.draftBase = Math.min(base, this.follow(arrival.base))
      this.host.draft = arrival.graph
      this.host.draftFromEditor = true
      this.accepted.push(arrival.graph)
      this.post()
    }
    this.answers.push(() => arrival.resolve(answer))
  }

  answer() {
    this.answers.shift()?.()
  }

  /* Editor frame */

  edit() {
    if (!this.live.loaded) return
    const graph = this.node('e', this.store)
    this.store = graph
    this.dirty = true
    this.edits.set(graph, { generation: this.live.generation, at: (this.clock += 1) })
  }

  private reported(generation: number) {
    this.reports.set(generation, (this.clock += 1))
  }

  startSave() {
    if (!this.dirty || !saveMayStart(this.state, this.live.projectId)) return
    this.pendingSaves.push({ projectId: this.live.projectId, content: this.store })
  }

  landSave() {
    const save = this.pendingSaves.shift()
    if (!save) return
    this.files.set(save.projectId, save.content)
    // Freecut marks the (global) timeline clean after every save; the persistence shim marks it dirty
    // again when the stores changed while the save wrote.
    this.dirty = this.store !== save.content
    const mount = this.state.mount
    if (save.projectId === mount.projectId && acceptsWrite(this.state, mount)) {
      this.state.writePending = true
      this.sendTimers.push(mount)
    }
  }

  fireSend() {
    const mount = this.sendTimers.shift()
    if (mount) this.send(mount)
  }

  private send(mount: EditorMount) {
    void sendEditorDraft(this.state, mount, {
      read: (from) => Promise.resolve(JSON.stringify(this.files.get(from.projectId) ?? null)),
      contentOf: String,
      stage: (graph, base, version) =>
        new Promise<StageAnswer>((resolve) =>
          this.arrivals.push({ graph: String(graph), base, version, resolve }),
        ),
      dirty: () => undefined,
      lost: () => this.reported(mount.generation),
    })
  }

  update() {
    const update = this.updates.shift()
    if (!update) return
    const current = this.files.get(this.state.mount.projectId) ?? ''
    const outcome = reconcileHostGraph(this.state, {
      incoming: update.graph,
      current,
      draftHeld: update.draftHeld,
      graphVersion: update.version,
    })
    if (outcome === 'remount') {
      const replaced = this.state.mount
      const lost = editsLostOnRemount(this.state, this.sendTimers.length > 0 || this.dirty)
      this.sendTimers = []
      const mount = beginMount(
        this.state,
        `p-m${replaced.generation + 1}`,
        update.revision,
        update.version,
      )
      this.state.hostContent = update.graph
      const mark = lost && replaced === this.live ? this.store : undefined
      if (lost && reportLost(this.state, replaced.generation, mark))
        this.reported(replaced.generation)
      this.seeding = { mount, graph: update.graph }
    } else if (outcome === 'echo') {
      this.state.hostContent = update.graph
      confirmEcho(this.state, update.graph, current, update.revision)
    }
    if (shouldResendDraft({ pending: this.state.pendingSend, online: true, hasLease: true }))
      this.send(this.state.mount)
  }

  /** The remount's seeding finishes and the new instance renders (the end of `remount`). */
  seed() {
    const seeding = this.seeding
    if (!seeding) return
    this.seeding = null
    if (seeding.mount !== this.state.mount) return
    this.files.set(seeding.mount.projectId, seeding.graph)
    if (this.dirty && reportLost(this.state, this.live.generation, this.store))
      this.reported(this.live.generation)
    this.live = seeding.mount
  }

  /** The rendered instance's timeline loads: the store holds the seeded graph. */
  hydrate() {
    if (this.live !== this.state.mount || this.live.loaded || this.seeding) return
    this.store = this.files.get(this.live.projectId) ?? this.store
    this.dirty = false
    loadFinished(this.state, this.live.projectId, true)
  }

  /* Properties */

  descends(content: string, ancestor: string): boolean {
    for (let at: string | undefined = content; at !== undefined; at = this.parent.get(at)) {
      if (at === ancestor) return true
    }
    return false
  }

  assertHostChangeKept() {
    expect(this.descends(this.hostGraph, this.lastReplacement)).toBe(true)
  }

  /** An edit the host never took was reported lost by its instance after it was made. */
  assertNoEditDisappeared() {
    for (const [edit, { generation, at }] of this.edits) {
      const kept = this.accepted.some((graph) => this.descends(graph, edit))
      if (!kept) expect(this.reports.get(generation) ?? 0, `edit ${edit}`).toBeGreaterThan(at)
    }
  }

  private get busy() {
    return (
      this.updates.length +
        this.arrivals.length +
        this.answers.length +
        this.pendingSaves.length +
        this.sendTimers.length >
        0 ||
      this.seeding !== null ||
      (this.live.loaded === false && this.live === this.state.mount)
    )
  }

  /** Deliver everything in flight, then save and send what the person has on screen. */
  async drain() {
    for (let round = 0; round < 500; round += 1) {
      this.update()
      this.arrive()
      this.answer()
      this.seed()
      this.hydrate()
      this.landSave()
      this.fireSend()
      await settle()
      this.assertHostChangeKept()
      if (this.busy) continue
      if (!this.dirty) return
      this.startSave()
    }
    throw new Error('the model did not settle')
  }
}

describe('the Studio host and editor under every interleaving (FL-174)', () => {
  it('keeps the host’s own graph and never loses an edit without telling the person', async () => {
    let seed = 0x5afe
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    let lostAtAll = 0
    for (let run = 0; run < 150; run += 1) {
      const model = new StudioModel()
      for (let step = 0; step < 80; step += 1) {
        const pick = Math.floor(random() * 20)
        if (pick <= 2) model.edit()
        else if (pick === 3) model.startSave()
        else if (pick === 4) model.landSave()
        else if (pick === 5) model.fireSend()
        else if (pick === 6) model.arrive()
        else if (pick === 7) model.answer()
        else if (pick === 8) model.update()
        else if (pick === 9) model.seed()
        else if (pick === 10) model.hydrate()
        else if (pick === 11) model.hostChange('c')
        else if (pick === 12) model.hostChange('u')
        else if (pick === 13) model.save()
        else if (pick === 14 && random() < 0.3) model.external()
        else if (pick === 15 && random() < 0.3) model.loseLease()
        else if (pick === 16) model.takeOver()
        else if (pick === 17 && random() < 0.3) model.reload()
        else if (pick === 18 && random() < 0.3) model.restore()
        await settle()
        model.assertHostChangeKept()
      }
      await model.drain()
      model.assertHostChangeKept()
      model.assertNoEditDisappeared()
      // Settled: the editor shows the host's latest graph, at its version.
      expect(model.state.mount.graphVersion).toBe(model.host.graphVersion)
      lostAtAll += model.reports.size
    }
    // The interleavings reach the lost-edit path, so the second property is exercised.
    expect(lostAtAll).toBeGreaterThan(0)
  })
})

describe('per-mount timers (FL-187)', () => {
  /**
   * `watchDrafts` and `watchDirty`'s own debounce, faithfully: a later write supersedes the timer
   * before it, exactly as `if (pending) clearTimeout(pending); pending = mountTimer(...)` did before
   * this story added `cancelMountTimer`. Every armed timer is cleared before the test ends, so none
   * of it outlives the test.
   */
  const armAndSupersede = (timers: Set<MountTimer>, edits: number): MountTimer => {
    let pending: MountTimer | null = null
    for (let i = 0; i < edits; i += 1) {
      cancelMountTimer(timers, pending)
      const armed = setTimeout(() => timers.delete(armed), 250)
      pending = armed
      timers.add(armed)
    }
    return pending as MountTimer
  }

  it('drops a debounce a later write supersedes instead of leaving it tracked', () => {
    const timers = new Set<MountTimer>()
    const first = setTimeout(() => undefined, 1000)
    timers.add(first)
    const second = setTimeout(() => undefined, 1000)
    cancelMountTimer(timers, first)
    timers.add(second)
    // Only the timer actually still pending is tracked; the superseded one left no trace.
    expect(timers.size).toBe(1)
    expect(timers.has(second)).toBe(true)
    cancelMountTimer(timers, second)
    expect(timers.size).toBe(0)
  })

  it('cancelling a timer twice, or one that already fired, is a no-op', () => {
    const timers = new Set<MountTimer>()
    cancelMountTimer(timers, null)
    const timer = setTimeout(() => undefined, 1000)
    timers.add(timer)
    timers.delete(timer) // fired naturally, as `mountTimer` removes it before running
    cancelMountTimer(timers, timer)
    expect(timers.size).toBe(0)
  })

  it('N writes debounced into one send leave a single armed timer, not N', () => {
    const timers = new Set<MountTimer>()
    const last = armAndSupersede(timers, 20)
    expect(timers.size).toBe(1)
    expect(timers.has(last)).toBe(true)
    releaseMountTimers(timers)
  })

  it('remounting N times, each superseding a pending timer, leaves nothing armed', () => {
    const timers = new Set<MountTimer>()
    for (let generation = 0; generation < 8; generation += 1) {
      armAndSupersede(timers, 3)
      // The remount itself releases whatever the replaced mount still had armed (`remount` calls this
      // before starting the next mount).
      releaseMountTimers(timers)
    }
    expect(timers.size).toBe(0)
  })
})
