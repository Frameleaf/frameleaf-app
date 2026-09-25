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
 *   editor from the new revision.
 * - **Media.** The bin is the library selection the host authorized (`library-media.ts`).
 * - **Navigation.** Leaving the editor route asks the host to navigate; the host runs its own
 *   unsaved-work guard.
 * - **Lifetime.** `dispose` unmounts React, releases every media URL and the workspace, and the
 *   host then removes this document, which ends whatever audio, GPU and worker state remains.
 *
 * Nothing here receives a token, an API base URL or an SDK: the only channel out is the host port.
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
import type {
  StudioFrameHello,
  StudioFrameServiceCalls,
  StudioFrameServiceName,
  StudioFrameToHostMessage,
  StudioHostToFrameMessage,
} from '@frameleaf/host/frame-protocol'
import { STUDIO_FRAME_PROTOCOL_VERSION } from '@frameleaf/host/frame-protocol'
import type { StudioHostContext } from '@frameleaf/host/host-contract'
import { ENGINE_REVISION } from './engine-revision'
import { VirtualWorkspace } from './virtual-workspace'
import { createLibraryMediaSeeder, type LibraryMediaSeeder } from './library-media'
import { canonicalJson } from './canonical-commands'
import { installBrowserShims } from './browser-shims'
import { RemotePreview, localPreviewSupport } from './remote-preview'

installBrowserShims()

const LazyToaster = lazy(async () => {
  const { Toaster } = await import('@/components/ui/sonner')
  return { default: Toaster }
})

/* ------------------------------------------------------------------ */
/* Host port                                                            */
/* ------------------------------------------------------------------ */

let port: MessagePort | null = null
let nextCallId = 1
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

const post = (message: StudioFrameToHostMessage) => port?.postMessage(message)

function call<Name extends StudioFrameServiceName>(
  name: Name,
  ...args: StudioFrameServiceCalls[Name]['args']
): Promise<StudioFrameServiceCalls[Name]['result']> {
  if (!port) return Promise.reject(new Error('The Studio host is not connected'))
  const callId = nextCallId++
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve: resolve as (value: unknown) => void, reject })
    post({ type: 'service', callId, name, args })
  })
}

/* ------------------------------------------------------------------ */
/* Session                                                              */
/* ------------------------------------------------------------------ */

/** The graph without the stamps Freecut refreshes on every save, for "did anything change". */
const contentOf = (graph: unknown): string => {
  if (!graph || typeof graph !== 'object') return canonicalJson(graph)
  const { updatedAt: _updatedAt, ...rest } = graph as Record<string, unknown>
  return canonicalJson(rest)
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

interface Session {
  context: StudioHostContext
  workspace: VirtualWorkspace
  media: LibraryMediaSeeder
  root: Root
  engineProjectId: string
  /** Content of the graph the host holds, so an echo of our own draft is not reloaded. */
  hostContent: string
  /** Bumped to remount the editor route after the project changed underneath it. */
  generation: number
  render: () => void
  unsubscribe: Array<() => void>
  draftTimer: ReturnType<typeof setTimeout> | null
  disposed: boolean
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
async function seedProject(state: Session): Promise<void> {
  const { context, workspace, engineProjectId } = state
  const graph = context.project.graph as Project | null
  if (graph && typeof graph === 'object') {
    workspace.putFile(
      projectJsonPath(engineProjectId),
      JSON.stringify({ ...graph, id: engineProjectId }, null, 2),
    )
    // Keep the index honest so Freecut's project listing agrees with the file.
    if (!(await getProject(engineProjectId)))
      throw new Error('The stored project could not be read by the editor')
    return
  }
  const created = await newProjectFor(context, engineProjectId)
  await createProject(created)
}

function EditorApp({ state }: { state: Session }) {
  const [router] = useState(() => {
    const history = createMemoryHistory({ initialEntries: [`/editor/${state.engineProjectId}`] })
    // Anything but this project's editor route belongs to the host: projects list, landing page,
    // another project. The host decides, with its own unsaved-work guard.
    history.block({
      blockerFn: ({ nextLocation }) => {
        if (nextLocation.pathname === `/editor/${state.engineProjectId}`) return false
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

/** Forward the editor's saves to the host as drafts; debounce bursts of store writes. */
function watchDrafts(state: Session) {
  const target = projectJsonPath(state.engineProjectId).join('/')
  state.unsubscribe.push(
    state.workspace.onWrite((path) => {
      if (path.join('/') !== target) return
      if (state.draftTimer) clearTimeout(state.draftTimer)
      state.draftTimer = setTimeout(() => void sendDraft(state), 250)
    }),
  )
}

async function sendDraft(state: Session) {
  state.draftTimer = null
  if (state.disposed) return
  const text = await state.workspace.readText(projectJsonPath(state.engineProjectId))
  if (!text) return
  let graph: unknown
  try {
    graph = JSON.parse(text)
  } catch {
    return
  }
  const content = contentOf(graph)
  if (content === state.hostContent) return
  const result = await call('stageDraft', graph, ['editor.save']).catch(
    () => ({ status: 'rejected', reason: 'offline' }) as const,
  )
  if (result.status === 'staged') {
    state.hostContent = content
    post({ type: 'dirty', dirty: false })
  } else {
    // Kept in the editor, not stored: the host's banner already says why (lease, access, network).
    post({ type: 'dirty', dirty: true })
  }
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
      if (!settings.isDirty || settings.isTimelineLoading) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (!state.disposed && useTimelineSettingsStore.getState().isDirty) {
          void saveTimeline(state.engineProjectId).catch((error: unknown) =>
            post({
              type: 'notify',
              message: error instanceof Error ? error.message : String(error),
              tone: 'error',
            }),
          )
        }
      }, 1500)
    }),
    () => {
      if (timer) clearTimeout(timer)
    },
  )
}

/** The playhead, as an exact rational instant, for review comments pinned in the host (FL-93). */
function watchPlayhead(state: Session) {
  let last = -1
  state.unsubscribe.push(
    usePlaybackStore.subscribe((playback) => {
      if (playback.isPlaying || playback.currentFrame === last) return
      last = playback.currentFrame
      const fps = useTimelineSettingsStore.getState().fps || 30
      const rate = Number.isInteger(fps)
        ? { num: fps, den: 1 }
        : { num: Math.round(fps * 1000), den: 1000 }
      post({ type: 'playhead', time: { num: last * rate.den, den: rate.num } })
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
      projectId: engineProjectId,
      onChange: () => void useMediaLibraryStore.getState().loadMediaItems(),
    }),
    root: createRoot(container),
    engineProjectId,
    hostContent: contentOf(context.project.graph),
    generation: 0,
    render: () => undefined,
    unsubscribe: [],
    draftTimer: null,
    disposed: false,
  }
  session = state

  // The bin first (the handoff needs frame rates), then the project that uses it.
  await state.media.seed(context.assets)
  await seedProject(state)

  state.render = () =>
    state.root.render(
      <StrictMode>
        <EditorApp key={state.generation} state={state} />
      </StrictMode>,
    )
  state.render()
  watchDrafts(state)
  watchDirty(state)
  watchPlayhead(state)

  // A brand-new project is stored as its first draft right away, so "make a movie" is kept.
  if (!context.project.graph) void sendDraft(state)
}

async function update(context: StudioHostContext): Promise<void> {
  const state = session
  if (!state || state.disposed) return
  const previous = state.context
  state.context = context
  applyTheme(context)
  if (context.auth.locale !== previous.auth.locale)
    await changeAppLanguage(context.auth.locale).catch(() => undefined)
  await state.media.seed(context.assets)

  const incoming = contentOf(context.project.graph)
  if (
    context.project.graph &&
    incoming !== state.hostContent &&
    incoming !== contentOf(await currentGraph(state))
  ) {
    // A revision this editor did not write: a restore, a reload after a conflict, or a canonical
    // command applied by the host. Reload the editor from it.
    state.hostContent = incoming
    state.workspace.putFile(
      projectJsonPath(state.engineProjectId),
      JSON.stringify({ ...(context.project.graph as object), id: state.engineProjectId }, null, 2),
    )
    usePlaybackStore.getState().pause()
    state.generation += 1
  } else if (context.project.graph) {
    state.hostContent = incoming
  }
  state.render()
}

async function currentGraph(state: Session): Promise<unknown> {
  const text = await state.workspace.readText(projectJsonPath(state.engineProjectId))
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
  if (state.draftTimer) clearTimeout(state.draftTimer)
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
    case 'service-result': {
      const waiting = pending.get(message.callId)
      if (!waiting) return
      pending.delete(message.callId)
      if (message.ok) waiting.resolve(message.value)
      else waiting.reject(new Error(message.error))
      return
    }
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== window.location.origin) return
  const data = event.data as { source?: string } | null
  if (data?.source !== 'frameleaf-studio-host' || !event.ports[0] || port) return
  port = event.ports[0]
  port.onmessage = (portEvent) => void onHostMessage(portEvent.data as StudioHostToFrameMessage)
})

const hello: StudioFrameHello = {
  source: 'frameleaf-studio-frame',
  kind: 'editor',
  protocolVersion: STUDIO_FRAME_PROTOCOL_VERSION,
  engineRevision: ENGINE_REVISION,
}
window.parent.postMessage(hello, window.location.origin)
