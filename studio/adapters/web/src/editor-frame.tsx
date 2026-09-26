/**
 * The Freecut editor inside Frameleaf (FL-88, `STU-201`).
 *
 * This document is the complete, unmodified Freecut editor — its router, panels, hotkeys, dialogs,
 * timeline, preview, effects, color and compose workspaces — started with Frameleaf's adapters in
 * place of Freecut's browser assumptions:
 *
 * - **Workspace.** `VirtualWorkspace` replaces the File System Access folder, so the editor needs
 *   no picker and runs the same in Safari, Firefox and Chromium. `WorkspaceGate` is not mounted.
 * - **Project.** The host's stored graph is the Freecut project document, written into the workspace
 *   before the editor route loads it. Every save the editor makes is forwarded to the host as a
 *   draft (`stageDraft`); the host stores it as a revision with the lease and revision rules of
 *   FL-89. A graph that changes elsewhere (a restore, a reload, a canonical command) reloads the
 *   editor from the new revision. A draft built before the host's own latest graph is refused, so it
 *   never replaces the host's change (FL-174, `graphVersion`).
 * - **Media.** The bin is the library selection the host authorized (`library-media.ts`), plus
 *   whatever the person imports inside the editor, which follows every remount (FL-174).
 * - **Navigation.** Leaving the editor route asks the host to navigate; the host runs its own
 *   unsaved-work guard.
 * - **Lifetime.** `dispose` unmounts React, releases every media URL and the workspace, and the
 *   host then removes this document, which ends whatever audio, GPU and worker state remains.
 *
 * Nothing here is given a token, an API base URL or an SDK, and saves, commands and navigation go
 * through the host port. That is a design rule, not a sandbox: this document is same-origin with the
 * session's cookies, and its media requests use them.
 */
import { StrictMode, Suspense, lazy, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { changeAppLanguage, i18nReady } from '@/i18n'
import '@/index.css'
import { routeTree } from '@/routeTree.gen'
import { ErrorBoundary } from '@/app/error-boundary'
import { RouteErrorScreen } from '@/app/route-error'
import { GlobalTooltip } from '@/components/ui/global-tooltip'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { bootstrapWorkspace } from '@/infrastructure/storage/workspace-fs/bootstrap'
import { projectJsonPath } from '@/infrastructure/storage/workspace-fs/paths'
import { createProject, getProject } from '@/infrastructure/storage'
import { blobUrlManager } from '@/infrastructure/browser/blob-url-manager'
import { useTimelineSettingsStore } from '@/features/timeline/stores/timeline-settings-store'
import { saveTimeline } from '@/features/timeline/stores/timeline-persistence'
import { useMediaLibraryStore } from '@/features/media-library/stores/media-library-store'
import { usePlaybackStore } from '@/shared/state/playback'
import { createProjectObject } from '@/features/projects/utils/project-helpers'
import type { Project } from '@/types/project'
import type { StudioHostToFrameMessage } from '@frameleaf/host/frame-protocol'
import { STUDIO_FRAME_PROTOCOL_VERSION } from '@frameleaf/host/frame-protocol'
import type { StudioHostContext } from '@frameleaf/host/host-contract'
import { call, connectToHost, post } from './host-port'
import { setPersistenceGate } from './persistence-gate'
import { VirtualWorkspace } from './virtual-workspace'
import {
  acceptsWrite,
  beginMount,
  cancelMountTimer,
  confirmEcho,
  editsLostOnRemount,
  loadFinished,
  reconcileHostGraph,
  releaseMountTimers,
  reportLost,
  saveMayStart,
  sendEditorDraft,
  shouldResendDraft,
  type DraftSendState,
  type EditorMount,
} from './draft-sync'
import {
  createLibraryMediaSeeder,
  followRetiredImports,
  retireProject,
  type LibraryMediaSeeder,
} from './library-media'
import { canonicalJson } from './canonical-commands'
import { hideFileSystemPickers, installBrowserShims } from './browser-shims'
import { RemotePreview, frameToTime, localPreviewSupport } from './remote-preview'
import { timelineEditContent } from './shims/timeline-persistence'

installBrowserShims()
hideFileSystemPickers()

const LazyToaster = lazy(async () => {
  const { Toaster } = await import('@/components/ui/sonner')
  return { default: Toaster }
})

/* ------------------------------------------------------------------ */
/* Session                                                              */
/* ------------------------------------------------------------------ */

/**
 * The graph without the stamps Freecut refreshes on every save, for "did anything change". The id
 * is left out too: each editor mount reads the same graph under its own Freecut project id.
 */
const contentOf = (graph: unknown): string => {
  if (!graph || typeof graph !== 'object') return canonicalJson(graph)
  const { updatedAt: _updatedAt, id: _id, ...rest } = graph as Record<string, unknown>
  return canonicalJson(rest)
}

/** The host's count of graphs it put in place itself (FL-174); absent means 0. */
const graphVersionOf = (context: StudioHostContext): number => {
  const version = context.project.graphVersion
  return Number.isSafeInteger(version) && (version as number) >= 0 ? (version as number) : 0
}

/** The Freecut project id inside the stored graph, or a stable one for a project that has none. */
const engineProjectIdOf = (context: StudioHostContext): string => {
  const graph = context.project.graph as { id?: unknown } | null
  if (graph && typeof graph.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(graph.id))
    return graph.id
  return `frameleaf-${context.project.id.replace(/[^A-Za-z0-9_-]/g, '')}`
}

const THEME_MAP: Record<string, string> = {
  '--primary': '--fl-accent',
  '--primary-foreground': '--fl-accent-text',
  '--ring': '--fl-accent',
  '--background': '--fl-viewer-canvas',
  '--card': '--fl-viewer-panel',
  '--popover': '--fl-viewer-raised',
  '--foreground': '--fl-viewer-text',
  '--card-foreground': '--fl-viewer-text',
  '--popover-foreground': '--fl-viewer-text',
  '--muted-foreground': '--fl-viewer-muted',
  '--border': '--fl-viewer-border',
  '--destructive': '--fl-danger',
}

/**
 * Frameleaf's tokens on this document's root. The editor is a dark, monitor-style surface in
 * both themes (`design/frameleaf/template/src/studio.css`), so the viewer tokens drive it.
 */
function applyTheme(context: StudioHostContext) {
  const root = document.documentElement
  root.classList.add('dark')
  root.dataset.frameleafTheme = context.theme.theme
  for (const [name, value] of Object.entries(context.theme.tokens))
    root.style.setProperty(name, value)
  for (const [engineName, hostName] of Object.entries(THEME_MAP)) {
    const value = context.theme.tokens[hostName]
    if (value) root.style.setProperty(engineName, value)
  }
}

/** The editor frame's session; `mount` and the draft rules live in `draft-sync.ts`. */
interface Session extends DraftSendState {
  context: StudioHostContext
  workspace: VirtualWorkspace
  media: LibraryMediaSeeder
  root: Root
  /** The Freecut project id the host's graph carries; every draft is sent under it. */
  engineProjectId: string
  render: () => void
  unsubscribe: Array<() => void>
  /** Timers the current mount scheduled (draft debounce, settled-save); a remount cancels them. */
  mountTimers: Set<ReturnType<typeof setTimeout>>
  /**
   * Project ids of replaced mounts. An import that was still running in a replaced instance links
   * its media to that instance's project; `watchImports` carries it to the current one (FL-174).
   */
  retiredProjectIds: Set<string>
  /** The mount generation whose editor instance is on screen; a remount renders a new one last. */
  renderedGeneration: number
}

let session: Session | null = null

/** A new project for an empty handle: the host's name, a 1080p30 canvas, the handoff on V1. */
async function newProjectFor(context: StudioHostContext, id: string): Promise<Project> {
  const project = createProjectObject(
    { name: context.project.name, width: 1920, height: 1080, fps: 30 },
    id,
  )
  const handoff = context.handoffAssetIds.filter((assetId) =>
    context.assets.some((asset) => asset.id === assetId && !asset.isOffline),
  )
  if (handoff.length === 0) return project
  // The handoff becomes the starting cut through the same canonical commands a native client
  // would send, so a "make a movie" project is built exactly as the engine would build it.
  const { applyCanonicalCommands } = await import('./canonical-commands')
  const { getAllMedia } = await import('@/infrastructure/storage')
  const withTrack = {
    ...project,
    timeline: {
      tracks: [
        {
          id: 'track-v1',
          name: 'V1',
          kind: 'video',
          height: 80,
          locked: false,
          syncLock: true,
          visible: true,
          muted: false,
          solo: false,
          order: 0,
          items: [],
        },
        {
          id: 'track-a1',
          name: 'A1',
          kind: 'audio',
          height: 60,
          locked: false,
          syncLock: true,
          visible: true,
          muted: false,
          solo: false,
          order: 1,
          items: [],
        },
      ],
      items: [],
      transitions: [],
      keyframes: [],
    },
  } as unknown as Project
  const media = await getAllMedia()
  // Stills run five seconds, videos their own length, end to end, on the 30 fps grid of the new
  // project (the same frame count `clip.add` gives a video), so no clip overlaps the next.
  const fps = project.metadata.fps
  let atFrames = 0
  const envelopes = handoff.map((assetId, index) => {
    const record = media.find((entry) => entry.id === assetId)
    const isVideo = !!record && record.mimeType.startsWith('video/')
    const envelope = {
      id: 'clip.add',
      payload: {
        trackId: 'track-v1',
        assetId,
        at: { num: atFrames, den: fps },
        ...(isVideo ? {} : { duration: { num: 5, den: 1 } }),
      },
      revision: 0,
      idempotencyKey: `handoff:${context.project.id}:${index}`,
      issuedAt: 0,
    }
    atFrames += isVideo ? Math.max(1, Math.round(record.duration * fps)) : 5 * fps
    return envelope
  })
  const outcome = await applyCanonicalCommands(withTrack, envelopes, media)
  return outcome.status === 'applied' ? outcome.project : project
}

/** Write the host's graph where Freecut reads its project, creating one when there is none. */
async function seedProject(state: Session, mount: EditorMount): Promise<void> {
  const { context, workspace } = state
  const graph = context.project.graph as Project | null
  if (graph && typeof graph === 'object') {
    workspace.putFile(
      projectJsonPath(mount.projectId),
      JSON.stringify({ ...graph, id: mount.projectId }, null, 2),
    )
    // Keep the index honest so Freecut's project listing agrees with the file.
    if (!(await getProject(mount.projectId)))
      throw new Error('The stored project could not be read by the editor')
    return
  }
  const created = await newProjectFor(context, mount.projectId)
  await createProject(created)
}

function EditorApp({ state, projectId }: { state: Session; projectId: string }) {
  const [router] = useState(() => {
    const history = createMemoryHistory({ initialEntries: [`/editor/${projectId}`] })
    // Anything but this project's editor route belongs to the host: projects list, landing page,
    // another project. The host decides, with its own unsaved-work guard.
    history.block({
      blockerFn: ({ nextLocation }) => {
        if (nextLocation.pathname === `/editor/${projectId}`) return false
        post({ type: 'navigate', target: { kind: 'library' } })
        return true
      },
    })
    return createRouter({ routeTree, history, defaultErrorComponent: RouteErrorScreen })
  })
  const [showToaster, setShowToaster] = useState(true)

  useEffect(() => {
    const show = () => setShowToaster(true)
    window.addEventListener('freecut:ensure-toaster', show)
    return () => window.removeEventListener('freecut:ensure-toaster', show)
  }, [])

  return (
    <ErrorBoundary level="app">
      <TooltipProvider delayDuration={300}>
        <RouterProvider router={router} />
        <GlobalTooltip />
        <RemotePreview context={state.context} call={call} />
        {showToaster && (
          <Suspense fallback={null}>
            <LazyToaster />
          </Suspense>
        )}
      </TooltipProvider>
    </ErrorBoundary>
  )
}

/** A timer that belongs to the current mount; `remount` cancels it before anything else. */
function mountTimer(state: Session, run: () => void, ms: number) {
  const timer = setTimeout(() => {
    state.mountTimers.delete(timer)
    run()
  }, ms)
  state.mountTimers.add(timer)
  return timer
}

/**
 * Forward the editor's saves to the host as drafts; debounce bursts of store writes. A write is
 * attributed to the mount whose file it is, so a late save of a replaced instance (its own project
 * file) or a write made while the mount is loading never becomes a draft.
 */
function watchDrafts(state: Session) {
  let pending: ReturnType<typeof setTimeout> | null = null
  state.unsubscribe.push(
    state.workspace.onWrite((path) => {
      const mount = state.mount
      if (path.join('/') !== projectJsonPath(mount.projectId).join('/')) return
      if (!acceptsWrite(state, mount)) return
      // Work the host has not taken yet; a remount before it is taken reports it lost (FL-174).
      state.writePending = true
      // A burst of writes debounces into one send; the timer a later write supersedes is dropped
      // from `mountTimers` too, not only cleared, so it does not sit there for the rest of the
      // mount's life (FL-187).
      cancelMountTimer(state.mountTimers, pending)
      pending = mountTimer(
        state,
        () => {
          pending = null
          void sendDraft(state, mount)
        },
        250,
      )
    }),
  )
}

function sendDraft(state: Session, mount: EditorMount): Promise<void> {
  return sendEditorDraft(state, mount, {
    read: (from) => state.workspace.readText(projectJsonPath(from.projectId)),
    contentOf,
    // The host's graph keeps one Freecut id whichever mount wrote it.
    stage: (graph, baseRevision, graphVersion) =>
      call(
        'stageDraft',
        { ...(graph as object), id: state.engineProjectId },
        ['editor.save'],
        baseRevision,
        graphVersion,
      ),
    dirty: (dirty) => post({ type: 'dirty', dirty }),
    lost: () => notifySuperseded(state),
  })
}

/**
 * Tell the person edits the host never took were not kept when the editor was replaced (FL-174).
 * Dropped once this document is disposed (FL-187): a notice arriving after the whole engine has torn
 * down would name a project the person is no longer looking at, on a channel nothing reads any more.
 */
function notifySuperseded(state: Session) {
  if (state.disposed) return
  const message = state.context.strings?.editSuperseded
  if (message) post({ type: 'notify', message, tone: 'error' })
}

/** Carry imports a replaced instance finishes to the current mount (`followRetiredImports`). */
function watchImports(state: Session) {
  state.unsubscribe.push(
    followRetiredImports({
      workspace: state.workspace,
      media: state.media,
      retired: state.retiredProjectIds,
      current: () => state.mount.projectId,
      // Freecut's own removal: unlinks the media and frees its record once no project links it.
      release: async (projectId, mediaId) => {
        const { importMediaLibraryService } =
          await import('@/features/timeline/deps/media-library-service')
        const { mediaLibraryService } = await importMediaLibraryService()
        await mediaLibraryService.deleteMediaFromProject(projectId, mediaId)
      },
      onError: (error) => {
        // Dropped once disposed (FL-187), for the same reason as `notifySuperseded`.
        if (state.disposed) return
        post({
          type: 'notify',
          message: error instanceof Error ? error.message : String(error),
          tone: 'error',
        })
      },
    }),
  )
}

/**
 * Freecut saves on an interval measured in minutes. Frameleaf keeps a revision per burst of edits
 * (FL-89 autosave), so a settled dirty timeline is saved through Freecut's own `saveTimeline`.
 */
function watchDirty(state: Session) {
  let timer: ReturnType<typeof setTimeout> | null = null
  state.unsubscribe.push(
    useTimelineSettingsStore.subscribe((settings, previous) => {
      if (settings.isDirty === previous.isDirty && !settings.isDirty) return
      post({ type: 'dirty', dirty: settings.isDirty })
      const mount = state.mount
      if (!settings.isDirty || settings.isTimelineLoading || !acceptsWrite(state, mount)) return
      // Same debounce-supersede rule as `watchDrafts`: drop the superseded timer, don't just clear it
      // (FL-187).
      cancelMountTimer(state.mountTimers, timer)
      timer = mountTimer(
        state,
        () => {
          timer = null
          if (acceptsWrite(state, mount) && useTimelineSettingsStore.getState().isDirty) {
            void saveTimeline(mount.projectId).catch((error: unknown) =>
              post({
                type: 'notify',
                message: error instanceof Error ? error.message : String(error),
                tone: 'error',
              }),
            )
          }
        },
        1500,
      )
    }),
  )
}

/**
 * How a load Freecut ran for `projectId` ended (reported by `shims/timeline-persistence.ts`). A
 * failed load leaves the stores on the replaced timeline: the editor is not usable, so the dirty
 * flag is cleared (nothing autosaves it) and the host is told; the mount never becomes loaded.
 */
function onLoadFinished(state: Session, projectId: string, error: unknown) {
  const mount = state.mount
  const outcome = loadFinished(state, projectId, error === null)
  if (outcome === 'loaded') {
    // A brand-new project is stored as its first draft as soon as it has loaded, so "make a movie"
    // is kept.
    if (mount.generation === 0 && !state.context.project.graph) void sendDraft(state, mount)
  } else if (outcome === 'failed') {
    useTimelineSettingsStore.getState().markClean()
    post({
      type: 'fatal',
      error: `The editor could not load this revision: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

/**
 * Put the host's graph in front of the person with a fresh editor instance. Everything the old
 * instance scheduled is cancelled first, before anything is awaited; its later writes go to its
 * own project file and are never sent.
 */
async function remount(state: Session, context: StudioHostContext, incoming: string) {
  const replaced = state.mount
  // Edits the old instance made that the host never took are lost with it; the person is told once
  // (FL-174). Asked before the timers that would have sent them are cancelled.
  const lost = editsLostOnRemount(
    state,
    state.mountTimers.size > 0 || useTimelineSettingsStore.getState().isDirty,
  )
  releaseMountTimers(state.mountTimers)
  const mount = beginMount(
    state,
    `${state.engineProjectId}-m${replaced.generation + 1}`,
    context.project.revision,
    graphVersionOf(context),
  )
  retireProject(state.retiredProjectIds, replaced.projectId)
  state.hostContent = incoming
  usePlaybackStore.getState().pause()
  // What the replaced instance shows now, so an edit it takes after this notice is told again.
  const mark =
    lost && replaced.generation === state.renderedGeneration ? timelineEditContent() : undefined
  if (lost && reportLost(state, replaced.generation, mark)) notifySuperseded(state)
  await seedProject(state, mount)
  if (state.disposed) return
  // Before the new instance renders, so its bin and its orphaned-clip check at load already see the
  // media the person imported inside the editor, not only the library selection (FL-174). Done even
  // when a newer remount has begun: that one carries this mount's links on from here.
  await state.media.associate(mount.projectId, replaced.projectId)
  if (state.disposed || state.mount !== mount) return
  // The instance on screen until now stayed editable while this one was seeded; edits it made since
  // can no longer be saved (the persistence gate refuses a replaced mount) and go with it.
  if (
    useTimelineSettingsStore.getState().isDirty &&
    reportLost(state, state.renderedGeneration, timelineEditContent())
  )
    notifySuperseded(state)
  state.renderedGeneration = mount.generation
  state.render()
}

/**
 * Start where the quick editor was (FL-113): once, after the timeline has loaded, the playhead goes
 * to the frame nearest the handed-over instant. Later context updates never move it.
 */
function startAtHandoffPlayhead(state: Session, at: { num: number; den: number } | null) {
  if (!at || !(at.den > 0) || at.num <= 0) return
  const apply = () => {
    const settings = useTimelineSettingsStore.getState()
    if (settings.isTimelineLoading) return false
    const fps = settings.fps || 30
    usePlaybackStore.getState().setCurrentFrame(Math.round((at.num / at.den) * fps))
    return true
  }
  if (apply()) return
  const stop = useTimelineSettingsStore.subscribe(() => {
    if (apply()) stop()
  })
  state.unsubscribe.push(stop)
}

/** The playhead, as an exact rational instant, for review comments pinned in the host (FL-93). */
function watchPlayhead(state: Session) {
  let last = -1
  state.unsubscribe.push(
    usePlaybackStore.subscribe((playback) => {
      if (playback.isPlaying || playback.currentFrame === last) return
      last = playback.currentFrame
      const fps = useTimelineSettingsStore.getState().fps || 30
      post({ type: 'playhead', time: frameToTime(last, fps) })
    }),
  )
}

async function mount(context: StudioHostContext): Promise<void> {
  applyTheme(context)
  await i18nReady
  await changeAppLanguage(context.auth.locale).catch(() => undefined)

  const workspace = new VirtualWorkspace()
  const handle = workspace.handle()
  setWorkspaceRoot(handle)
  await bootstrapWorkspace(handle)

  const container = document.getElementById('root')
  if (!container) throw new Error('The editor document has no root element')

  const engineProjectId = engineProjectIdOf(context)
  const state: Session = {
    context,
    workspace,
    media: createLibraryMediaSeeder({
      workspace,
      projectId: () => state.mount.projectId,
      onChange: () => void useMediaLibraryStore.getState().loadMediaItems(),
    }),
    root: createRoot(container),
    engineProjectId,
    hostContent: contentOf(context.project.graph),
    mount: {
      generation: 0,
      projectId: engineProjectId,
      revision: context.project.revision,
      graphVersion: graphVersionOf(context),
      loaded: false,
    },
    render: () => undefined,
    unsubscribe: [],
    mountTimers: new Set(),
    retiredProjectIds: new Set(),
    renderedGeneration: 0,
    pendingSend: false,
    pendingSuperseded: false,
    disposed: false,
  }
  session = state
  const first = state.mount
  // Every Freecut save is judged when it starts (see `shims/timeline-persistence.ts`).
  setPersistenceGate({
    mayStartSave: (projectId) => saveMayStart(state, projectId),
    loadFinished: (projectId, error) => onLoadFinished(state, projectId, error),
  })

  // The bin first (the handoff needs frame rates), then the project that uses it.
  await state.media.seed(context.assets)
  await seedProject(state, first)

  state.render = () =>
    state.root.render(
      <StrictMode>
        <EditorApp key={state.mount.generation} state={state} projectId={state.mount.projectId} />
      </StrictMode>,
    )
  state.render()
  watchDrafts(state)
  watchImports(state)
  watchDirty(state)
  watchPlayhead(state)
  startAtHandoffPlayhead(state, context.handoffPlayhead ?? null)
}

async function update(context: StudioHostContext): Promise<void> {
  const state = session
  if (!state || state.disposed) return
  const previous = state.context
  state.context = context
  applyTheme(context)
  // The graph is settled first, so the echo of a save is not held up behind video probing; the
  // mount rules keep this correct whatever the order.
  const incoming = contentOf(context.project.graph)
  const current = contentOf(await currentGraph(state))
  const outcome = context.project.graph
    ? reconcileHostGraph(state, {
        incoming,
        current,
        draftHeld: context.draftHeld === true,
        graphVersion: graphVersionOf(context),
      })
    : 'hold'
  if (outcome === 'remount') {
    // A revision this editor did not write: a restore, a reload after a conflict, or a canonical
    // command applied by the host. A fresh editor instance loads it.
    await remount(state, context, incoming)
  } else if (outcome === 'echo') {
    state.hostContent = incoming
    confirmEcho(state, incoming, current, context.project.revision)
  }
  if (context.auth.locale !== previous.auth.locale)
    await changeAppLanguage(context.auth.locale).catch(() => undefined)
  await state.media.seed(context.assets)
  if (
    shouldResendDraft({
      pending: state.pendingSend,
      online: context.online,
      hasLease: context.project.hasLease,
    })
  ) {
    void sendDraft(state, state.mount)
  }
  state.render()
}

async function currentGraph(state: Session): Promise<unknown> {
  const text = await state.workspace.readText(projectJsonPath(state.mount.projectId))
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

async function dispose(): Promise<void> {
  const state = session
  session = null
  if (!state || state.disposed) return
  state.disposed = true
  setPersistenceGate({ mayStartSave: () => false, loadFinished: () => undefined })
  releaseMountTimers(state.mountTimers)
  for (const stop of state.unsubscribe.splice(0)) stop()
  usePlaybackStore.getState().pause()
  state.root.unmount()
  state.media.dispose()
  blobUrlManager.releaseAll()
  state.workspace.dispose()
  setWorkspaceRoot(null)
}

/* ------------------------------------------------------------------ */
/* Connection                                                           */
/* ------------------------------------------------------------------ */

async function onHostMessage(message: StudioHostToFrameMessage) {
  switch (message.type) {
    case 'mount': {
      if (message.protocolVersion !== STUDIO_FRAME_PROTOCOL_VERSION) {
        post({
          type: 'mount-failed',
          error: `Protocol ${message.protocolVersion} is not supported`,
        })
        return
      }
      try {
        await mount(message.context)
        post({ type: 'mounted', support: localPreviewSupport() })
      } catch (error) {
        post({
          type: 'mount-failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    case 'update': {
      await update(message.context).catch((error: unknown) =>
        post({ type: 'fatal', error: error instanceof Error ? error.message : String(error) }),
      )
      return
    }
    case 'dispose': {
      await dispose()
      post({ type: 'disposed' })
      return
    }
    default:
      return
  }
}

connectToHost('editor', (message) => void onHostMessage(message))
