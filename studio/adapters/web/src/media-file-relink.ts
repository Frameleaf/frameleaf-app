import { updateProjectItem } from '@/features/timeline/stores/actions/project-item-actions'
import { captureSnapshot, restoreSnapshot } from '@/features/timeline/stores/commands/snapshot'
import { useCompositionNavigationStore } from '@/features/timeline/stores/composition-navigation-store'
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store'
import type { TimelineItem } from '@/types/timeline'
import type { Project } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'
import { createMedia, getMedia, updateMedia } from '@/infrastructure/storage'
import { replaceMediaSource } from '@/infrastructure/storage/workspace-fs/media-source'
import { mediaDir } from '@/infrastructure/storage/workspace-fs/paths'
import type {
  StudioEditorScope,
  StudioEditorCommitResult,
  StudioProjectImportRef,
  StudioProjectImportUpload,
} from '@frameleaf/host/host-contract'
import { relinkMediaGraph } from '@frameleaf/host/media-relink'
import { MEDIA_FILE_PICKER_TYPES } from '@/features/media-library/utils/media-file-picker'
import { probeProjectImport, projectImportRecord } from './library-media'
import type { VirtualWorkspace } from './virtual-workspace'

/** The portable picker carries bytes, never a persistent local filesystem handle. */
export function selectRelinkFile(signal: AbortSignal): Promise<File | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = Object.entries(MEDIA_FILE_PICKER_TYPES[0]!.accept)
    .flatMap(([mime, extensions]) => [mime, ...extensions])
    .join(',')
  return new Promise((resolve, reject) => {
    const finish = (file?: File) => {
      input.onchange = null
      input.oncancel = null
      signal.removeEventListener('abort', abort)
      input.remove()
      resolve(file)
    }
    const abort = () => finish()
    input.oncancel = abort
    input.onchange = () => {
      const file = input.files?.[0]
      const supported =
        file &&
        Object.entries(MEDIA_FILE_PICKER_TYPES[0]!.accept).some(
          ([mime, extensions]) =>
            extensions.some((extension) => file.name.toLowerCase().endsWith(extension)) ||
            (mime.endsWith('/*') ? file.type.startsWith(mime.slice(0, -1)) : file.type === mime),
        )
      if (file && !supported) reject(new Error('Choose a supported image, audio or video file'))
      finish(supported ? file : undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      input.click()
    } catch (error) {
      reject(error)
      finish()
    }
  })
}

export interface RelinkCapture {
  scope: StudioEditorScope
  revision: number
  graph: Project
  signal: AbortSignal
  current(): boolean
}

/** Prepare immutable source B, commit its complete graph, then publish on the same captured mount. */
export function createMediaFileRelinker(options: {
  workspace: VirtualWorkspace
  capture(): RelinkCapture
  imports(): readonly StudioProjectImportRef[]
  upload(upload: StudioProjectImportUpload): Promise<StudioProjectImportRef>
  commit(graph: Project, capture: RelinkCapture): Promise<StudioEditorCommitResult>
  lock(capture: RelinkCapture): () => void
  publish(
    graph: Project,
    media: MediaMetadata,
    capture: RelinkCapture,
    revision: number,
  ): Promise<void>
  guard?(capture: RelinkCapture): void
  probe?: typeof probeProjectImport
  select?: typeof selectRelinkFile
}): (mediaId: string) => Promise<boolean> {
  let running = false
  return async (mediaId) => {
    if (running) throw new Error('A file is already being relinked')
    running = true
    let release: (() => void) | undefined
    let replacement: Awaited<ReturnType<typeof replaceMediaSource>> | undefined
    let committed = false
    let capture: RelinkCapture
    const assertCurrent = () => {
      if (capture.signal.aborted || !capture.current())
        throw new Error('The editor changed before the replacement could be kept')
    }
    try {
      capture = options.capture()
      assertCurrent()
      const file = await (options.select ?? selectRelinkFile)(capture.signal)
      if (!file) return false
      assertCurrent()
      const original = await getMedia(mediaId)
      if (!original) throw new Error('The missing source is no longer in this project')
      const checksum = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('')
      assertCurrent()
      const prior = options.imports().find((entry) => entry.id === mediaId)
      const same = !!prior?.checksum && prior.checksum === checksum
      const id = same ? mediaId : crypto.randomUUID()
      const admitted = await options.upload({
        id,
        fileName: same ? prior!.name : file.name,
        file,
        scope: capture.scope,
      })
      assertCurrent()
      if (admitted.id !== id || admitted.checksum !== checksum || admitted.sizeBytes !== file.size)
        throw new Error('The admitted source does not match the selected bytes')
      const media = same
        ? original
        : {
            ...projectImportRecord(admitted, Date.now()),
            ...(await (options.probe ?? probeProjectImport)(admitted, capture.signal)),
            contentHash: checksum,
          }
      assertCurrent()
      const graph = same
        ? structuredClone(capture.graph)
        : (relinkMediaGraph(capture.graph, mediaId, media) as Project)
      release = options.lock(capture)
      assertCurrent()
      if (same) replacement = await replaceMediaSource(mediaId, file, original.fileName)
      else {
        // This UUID is a new admitted import, so no old hash cache or another media's source is touched.
        if (await getMedia(id)) await updateMedia(id, media)
        else await createMedia(media)
        assertCurrent()
        options.workspace.putFile([...mediaDir(id), media.fileName], file)
      }
      assertCurrent()
      const result = await options.commit(graph, capture)
      if (result.status !== 'saved') throw new Error(result.reason)
      committed = true
      assertCurrent()
      await options.publish(graph, media, capture, result.revision)
      assertCurrent()
      await replacement?.discard()
      replacement = undefined
      return true
    } catch (error) {
      if (replacement) {
        try {
          await replacement.restore()
        } catch (rollback) {
          throw new AggregateError(
            [error, rollback],
            'Relink failed and the previous source could not be restored',
          )
        }
      }
      if (committed) {
        options.guard?.(capture!)
        throw new Error(
          'The replacement was saved, but this editor could not load it. Reload the stored revision.',
          { cause: error },
        )
      }
      throw error
    } finally {
      release?.()
      running = false
    }
  }
}

/** Use the project-wide item action so active sequences, Main holders and nested stashes agree. */
export function publishRelinkSources(before: Project, next: Project): void {
  const previousItems = [before.timeline, ...(before.timeline?.compositions ?? [])].flatMap(
    (owner) => owner?.items ?? [],
  )
  const nextItems = [next.timeline, ...(next.timeline?.compositions ?? [])].flatMap(
    (owner) => owner?.items ?? [],
  )
  const previous = new Map(previousItems.map((item) => [item.id, item]))
  const history = useTimelineCommandStore.getState()
  const snapshot = captureSnapshot()
  const navigation = useCompositionNavigationStore.getState()
  try {
    history.execute({ type: 'RELINK_MEDIA' }, () => {
      for (const item of nextItems) {
        const old = previous.get(item.id)
        if (!old || old.mediaId === item.mediaId) continue
        const updates: Record<string, unknown> = {}
        for (const key of new Set([...Object.keys(old), ...Object.keys(item)])) {
          const value = (item as unknown as Record<string, unknown>)[key]
          if (
            JSON.stringify((old as unknown as Record<string, unknown>)[key]) !==
            JSON.stringify(value)
          )
            updates[key] = value
        }
        if (!updateProjectItem(item.id, updates as Partial<TimelineItem>))
          throw new Error('A source reader changed during relink')
      }
      // Nested project actions made their own entries; keep one atomic relink entry above the prior history.
      useTimelineCommandStore.setState({
        undoStack: history.undoStack,
        redoStack: history.redoStack,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        stacksByContext: history.stacksByContext,
        activeContextKey: history.activeContextKey,
      })
    })
  } catch (error) {
    restoreSnapshot(snapshot)
    useCompositionNavigationStore.setState(navigation)
    useTimelineCommandStore.setState(history)
    throw error
  }
}
