// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { UpscaleService, type Anime4kRetention } from '@/features/media-library/services/upscale-service'
import type { GeneratedMediaCompletion } from '@/features/media-library/services/media-asset-helpers'
import type { UpscaleResult } from '@/features/media-library/upscale-constants'
import type { MediaMetadata } from '@/types/storage'
import { writeBlob } from '@/infrastructure/storage/workspace-fs/fs-primitives'
import { submitRetainedImport, type RetentionApi } from '@frameleaf/host/import-retention'
import type { StudioEditorScope, StudioProjectImportRef, StudioPublicationReceipt } from '@frameleaf/host/host-contract'
import { createCompletionRetention, type CompletionUpload } from '../src/import-retention'
import { watchLocalImports } from '../src/project-imports'
import { VirtualWorkspace } from '../src/virtual-workspace'

const mediaLibrary = vi.hoisted(() => ({
  importGeneratedVideo: vi.fn(),
  deleteMediaFromProject: vi.fn(),
}))
vi.mock('@/features/media-library/services/media-library-service', () => ({ mediaLibraryService: mediaLibrary }))

const deferred = <T>() => {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((accept) => {
      resolve = accept
    }),
    resolve: (value: T) => resolve(value),
  }
}
const id = 'b7c1d2e3-0000-4000-8000-000000000001'
const publicationId = 'b7c1d2e3-0000-4000-8000-000000000002'
const scope: StudioEditorScope = {
  userId: '0198a1c2-0000-7000-8000-00000000000a',
  projectId: '0198a1c2-0000-7000-8000-0000000000aa',
  graphVersion: 1,
}
const result: UpscaleResult = {
  variant: 'liveAction',
  width: 3840,
  height: 2160,
  sourceWidth: 1920,
  sourceHeight: 1080,
  fps: 30000 / 1001,
  codec: 'avc',
  frameCount: 30,
}
const media: MediaMetadata = {
  id,
  storageType: 'opfs',
  fileName: 'generated.mp4',
  fileSize: 8,
  mimeType: 'video/mp4',
  duration: 1,
  width: result.width,
  height: result.height,
  fps: result.fps,
  codec: 'avc',
  bitrate: 1,
  tags: [],
  createdAt: 1,
  updatedAt: 1,
}
const imported: StudioProjectImportRef = {
  id,
  kind: 'video',
  name: media.fileName,
  mimeType: media.mimeType,
  sizeBytes: media.fileSize,
  url: '/file',
}
const receipt: StudioPublicationReceipt = {
  importId: id,
  publicationId,
  state: 'registered',
  createdAt: '',
  expiresAt: '',
  cleanupPending: false,
}

/** Real producer and completion bridge; only the media persistence and host API boundaries are stubbed. */
const setup = (stage: 'registration' | 'upload', committed = false) => {
  const service = new UpscaleService()
  const workspace = new VirtualWorkspace()
  const registration = deferred<StudioPublicationReceipt>()
  const upload = deferred<StudioProjectImportRef>()
  const started = deferred<void>()
  const controller = new AbortController()
  let current = true
  const cancel = vi.fn(async () => ({
    status: committed ? ('already-published' as const) : ('cancelled' as const),
    receipt: committed
      ? { ...receipt, state: 'published' as const, imported }
      : { ...receipt, state: 'aborted' as const },
  }))
  const api: RetentionApi = {
    register: vi.fn(async () => {
      if (stage === 'registration') {
        started.resolve()
        return registration.promise
      }
      return receipt
    }),
    upload: vi.fn(async () => {
      started.resolve()
      return upload.promise
    }),
    discover: vi.fn(),
    cancel,
  }
  const kept = vi.fn()
  const genericUpload = vi.fn(async () => imported)
  const watch = watchLocalImports({
    workspace,
    media: { known: () => false, kept: vi.fn() },
    upload: genericUpload,
    refused: vi.fn(),
  })
  const retention = createCompletionRetention({
    workspace,
    watch,
    current: () => current,
    kept,
    upload: (value) => submitRetainedImport(api, scope, () => current && !controller.signal.aborted, value),
    cancel: (heldId) => {
      controller.abort()
      return api.cancel(scope.projectId, heldId, publicationId)
    },
  })
  // Match editor-frame's captured completion callback, including its disposal on settlement.
  const bridge: Anime4kRetention = {
    root: workspace.handle(),
    isCurrent: () => current,
    hold: (heldId) => retention.hold(heldId),
    cancel: (heldId) => retention.cancel(heldId),
    async complete(file, completed, facts) {
      try {
        const value: CompletionUpload = {
          id: completed.id,
          publicationId,
          scope,
          file,
          fileName: file.name,
          processingProvenance: {
            version: 1,
            family: 'anime4k',
            evidence: 'client-reported',
            variant: facts.variant,
            source: { namespace: 'freecut-media', id: 'source-1', projectId: scope.projectId },
            input: { width: facts.sourceWidth, height: facts.sourceHeight },
            output: {
              width: facts.width,
              height: facts.height,
              fps: facts.fps,
              frameCount: facts.frameCount,
              codec: facts.codec,
            },
          },
        }
        await retention.complete(value)
      } finally {
        retention.dispose()
      }
    },
  }
  const job = {
    mediaId: 'source-1',
    projectId: scope.projectId,
    fileName: 'source.mp4',
    variant: result.variant,
    source: new Blob(['source']),
    sourceFps: 30,
    jobId: 'job-1',
    retention: bridge,
  }
  const internals = service as unknown as {
    jobsByMediaId: Map<string, typeof job>
    importResult(activeJob: typeof job, result: UpscaleResult): Promise<void>
  }
  internals.jobsByMediaId.set(job.mediaId, job)
  mediaLibrary.importGeneratedVideo.mockImplementationOnce(
    async (file: File, _projectId: string, options: { completion: GeneratedMediaCompletion }) => {
      await options.completion.hold(id)
      await writeBlob(workspace.handle(), ['media', id, file.name], new Uint8Array(await file.arrayBuffer()))
      await options.completion.complete(file, media)
      return media
    },
  )
  const mediaCreated = vi.fn()
  service.onMediaCreated(mediaCreated)
  const completion = internals.importResult(job, result)
  let settled = false
  void completion.then(() => {
    settled = true
  })
  return {
    service,
    workspace,
    registration,
    upload,
    started: started.promise,
    completion,
    api,
    cancel,
    kept,
    mediaCreated,
    watch,
    genericUpload,
    settled: () => settled,
    retire: () => {
      current = false
      retention.dispose()
    },
  }
}

describe('actual Anime4K Cancel during retained completion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(async () => ({
          getDirectoryHandle: vi.fn(async () => ({
            getFileHandle: vi.fn(async () => ({ getFile: vi.fn(async () => new File(['rendered'], 'job-1.mp4')) })),
            removeEntry: vi.fn(async () => {}),
          })),
        })),
      },
    })
  })

  it('sends one scoped cancellation while registration is pending and never advances into upload', async () => {
    const state = setup('registration')
    await state.started
    state.service.cancel('source-1')
    state.service.cancel('source-1')
    expect(state.settled()).toBe(false)
    expect(state.cancel).toHaveBeenCalledExactlyOnceWith(scope.projectId, id, publicationId)
    expect(state.workspace.list(['media', id])).toContainEqual({ name: 'retention.json', kind: 'file' })
    await state.watch.retry()
    expect(state.genericUpload).not.toHaveBeenCalled()
    state.registration.resolve(receipt)
    await state.completion
    expect(state.api.register).toHaveBeenCalledTimes(1)
    expect(state.api.upload).not.toHaveBeenCalled()
    expect(state.cancel).toHaveBeenCalledTimes(1)
    expect(state.kept).not.toHaveBeenCalled()
    expect(state.mediaCreated).not.toHaveBeenCalled()
    expect(mediaLibrary.importGeneratedVideo).toHaveBeenCalledTimes(1)
    expect(mediaLibrary.deleteMediaFromProject).not.toHaveBeenCalled()
    await state.watch.retry()
    expect(state.genericUpload).not.toHaveBeenCalled()
    state.watch.stop()
    state.workspace.dispose()
  })

  it.each([false, true])(
    'cancels immediately during upload and preserves late committed bytes (committed=%s)',
    async (committed: boolean) => {
      const state = setup('upload', committed)
      await state.started
      state.service.cancel('source-1')
      expect(state.settled()).toBe(false)
      expect(state.cancel).toHaveBeenCalledExactlyOnceWith(scope.projectId, id, publicationId)
      state.upload.resolve(imported)
      await state.completion
      expect(state.api.register).toHaveBeenCalledTimes(1)
      expect(state.api.upload).toHaveBeenCalledTimes(1)
      expect(state.api.upload).toHaveBeenCalledWith(
        scope.projectId,
        expect.objectContaining({ id, publicationId, scope }),
      )
      expect(state.cancel).toHaveBeenCalledTimes(1)
      expect(state.kept).not.toHaveBeenCalled()
      expect(state.mediaCreated).not.toHaveBeenCalled()
      expect(mediaLibrary.importGeneratedVideo).toHaveBeenCalledTimes(1)
      expect(mediaLibrary.deleteMediaFromProject).not.toHaveBeenCalled()
      await state.watch.retry()
      expect(state.genericUpload).not.toHaveBeenCalled()
      state.watch.stop()
      state.workspace.dispose()
    },
  )

  it.each(['registration', 'upload'] as const)(
    'never cancels through a retired scope during %s',
    async (stage: 'registration' | 'upload') => {
      const state = setup(stage)
      await state.started
      state.retire()
      state.service.cancel('source-1')
      expect(state.cancel).not.toHaveBeenCalled()
      if (stage === 'registration') state.registration.resolve(receipt)
      else state.upload.resolve(imported)
      await state.completion
      expect(state.api.upload).toHaveBeenCalledTimes(stage === 'registration' ? 0 : 1)
      expect(state.kept).not.toHaveBeenCalled()
      expect(state.mediaCreated).not.toHaveBeenCalled()
      expect(mediaLibrary.deleteMediaFromProject).not.toHaveBeenCalled()
      await state.watch.retry()
      expect(state.genericUpload).not.toHaveBeenCalled()
      state.watch.stop()
      state.workspace.dispose()
    },
  )
})
