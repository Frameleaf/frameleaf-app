/**
 * Freecut's "Clean up voice" host, answered by Frameleaf's server (FL-637).
 *
 * This module stands in for
 * `@/features/editor/components/properties-sidebar/clip-panel/voice-cleanup-service` in the adapter
 * build (`vite.config.mjs`), the way the export dialogs are substituted. The frame is same-origin and
 * the session cookie authorizes it, as for the library media it already reads, so the card calls the
 * project's own Studio routes; no token or URL crosses the frame protocol.
 *
 * The analysis is one request. A clean-up is a job Activity follows: this polls it, cancels it when the
 * card does, and once it completes puts the cleaned sound's project import in the bin (under the media
 * id the clip will play) before the card swaps the clip over.
 */
import type { StudioProjectImportRef } from '@frameleaf/host/host-contract'
import type { VoiceCleanupResult } from '@/features/editor/deps/timeline-store'
import type {
  VoiceAnalysis,
  VoiceCleanupHost,
  VoiceCleanupRequest,
} from '@/features/editor/components/properties-sidebar/clip-panel/voice-cleanup-service'

/** The editor document's current project and its bin, registered by `editor-frame.tsx`. */
export interface VoiceCleanupBinding {
  projectId: () => string | null
  seedImport: (ref: StudioProjectImportRef) => Promise<void>
}

const POLL_MS = 1000
const DONE = new Set(['completed', 'failed', 'cancelled'])
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

let binding: VoiceCleanupBinding | null = null

export function registerVoiceCleanupHost(next: VoiceCleanupBinding | null): void {
  binding = next
}

type ImportDto = { id: string; kind: string; contentType: string; fileName: string; sizeBytes: number; checksum: string }
type JobDto = {
  id: string
  status: string
  progress: number
  error: string | null
  result: (Omit<VoiceCleanupResult, 'importId'> & { import: ImportDto }) | null
}

async function request<T>(path: string, init: RequestInit & { signal?: AbortSignal }): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    ...init,
  })
  const body = (await response.json().catch(() => null)) as ({ message?: unknown } & T) | null
  if (!response.ok) {
    const message = body && typeof body.message === 'string' ? body.message : `The server answered ${response.status}`
    throw new Error(message)
  }
  return body as T
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })

const project = (): string => {
  const id = binding?.projectId()
  if (!id || !UUID.test(id)) throw new Error('Save the project first')
  return id
}

/** The cleaned sound as the bin's project import, the shape the host offers on the next load. */
export const toImportRef = (projectId: string, dto: ImportDto): StudioProjectImportRef => ({
  id: dto.id,
  kind: 'audio',
  name: dto.fileName,
  mimeType: dto.contentType,
  sizeBytes: dto.sizeBytes,
  checksum: dto.checksum,
  url: `/api/studio/projects/${projectId}/imports/${dto.id}/file`,
})

const host: VoiceCleanupHost = {
  async analyze(clipId: string, signal: AbortSignal): Promise<VoiceAnalysis> {
    const found = await request<VoiceAnalysis>(`/studio/projects/${project()}/voice-analysis`, {
      method: 'POST',
      body: JSON.stringify({ clipId }),
      signal,
    })
    return { noises: found.noises, humHz: found.humHz }
  },

  async clean(cleanup: VoiceCleanupRequest, onProgress, signal): Promise<VoiceCleanupResult> {
    const started = binding
    const projectId = project()
    const queued = await request<{ id: string }>(`/studio/projects/${projectId}/voice-cleanups`, {
      method: 'POST',
      body: JSON.stringify({
        clipId: cleanup.clipId,
        strength: cleanup.strength,
        noises: cleanup.noises,
        ...(cleanup.humHz && { humHz: cleanup.humHz }),
      }),
      signal,
    })
    try {
      for (;;) {
        await sleep(POLL_MS, signal)
        const job = await request<JobDto>(`/studio/projects/${projectId}/voice-cleanups/${queued.id}`, {
          method: 'GET',
          signal,
        })
        onProgress(Math.max(0, Math.min(100, job.progress)))
        if (!DONE.has(job.status)) continue
        if (job.status !== 'completed' || !job.result) {
          throw new Error(job.error ?? 'The voice clean-up did not finish')
        }
        const { import: kept, ...cleaned } = job.result
        // Another editor document or project since the start: its bin must not take this file.
        if (!started || binding !== started || started.projectId() !== projectId) {
          throw new Error('The project changed while the voice was cleaned up')
        }
        await started.seedImport(toImportRef(projectId, kept))
        return { ...cleaned, importId: kept.id }
      }
    } catch (error) {
      if (signal.aborted) {
        // The card was closed or moved on: stop the job too, best effort.
        void fetch(`/api/media-operations/${queued.id}/cancel`, { method: 'POST', credentials: 'same-origin' }).catch(
          () => undefined,
        )
      }
      throw error
    }
  },
}

export function getVoiceCleanupHost(): VoiceCleanupHost | null {
  return binding ? host : null
}
