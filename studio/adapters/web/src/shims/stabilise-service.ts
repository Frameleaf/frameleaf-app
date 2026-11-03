/**
 * Stabilise (FL-638), answered by the Frameleaf server.
 *
 * Stands in for the engine's `stabilise-service` in the adapter build (`vite.config.mjs`). Measuring
 * a clip's camera movement is a job on this server, followed in Activity: `POST
 * /api/studio/projects/{id}/stabilisations` queues it for the clip on the saved head revision, and
 * this follows `GET .../stabilisations/{jobId}` until it ends. The editor's document is same-origin
 * with the host, so the person's own session authorises both calls; the server checks the owner and
 * the clip's source again. The clip must be saved first: until autosave has taken the edit that
 * added it, the server does not know it, so that answer is retried for a short while.
 */
import type { StabilisationMotion } from '@/types/stabilisation'

export class StabiliseUnavailableError extends Error {
  constructor() {
    super('Stabilise is not available here')
    this.name = 'StabiliseUnavailableError'
  }
}

export interface StabiliseAnalysis {
  analyse(itemId: string, signal: AbortSignal, onProgress: (progress: number) => void): Promise<StabilisationMotion>
}

export const stabiliseAvailable = true

let currentProjectId: (() => string | null) | null = null

/** The editor frame names the project it is editing; analyses before that are unavailable. */
export function registerStabiliseHost(projectId: () => string | null): () => void {
  currentProjectId = projectId
  return () => {
    if (currentProjectId === projectId) currentProjectId = null
  }
}

const POLL_MS = 1000
const UNSAVED_RETRY_MS = 1500
const UNSAVED_RETRIES = 8

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })

async function request<T>(url: string, signal: AbortSignal, body?: unknown): Promise<{ ok: boolean; status: number; value: T }> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const value = (await response.json().catch(() => null)) as T
  return { ok: response.ok, status: response.status, value }
}

const messageOf = (value: unknown): string => {
  const message = (value as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : Array.isArray(message) ? message.join(' ') : ''
}

/** The server does not know the clip yet: the edit that added it has not been saved. */
const notSavedYet = (status: number, message: string) =>
  status === 400 && /not on the main timeline of this revision/i.test(message)

type Job = { status: string; progress: number; error: string | null; result: StabilisationMotion | null }

export const stabiliseAnalysis: StabiliseAnalysis = {
  async analyse(itemId, signal, onProgress) {
    const projectId = currentProjectId?.()
    if (!projectId) throw new StabiliseUnavailableError()
    const base = `/api/studio/projects/${encodeURIComponent(projectId)}/stabilisations`
    let queued: { ok: boolean; status: number; value: { id?: string } | null } | undefined
    for (let attempt = 0; ; attempt += 1) {
      queued = await request<{ id?: string } | null>(base, signal, { clipId: itemId })
      if (queued.ok || !notSavedYet(queued.status, messageOf(queued.value)) || attempt >= UNSAVED_RETRIES) break
      await wait(UNSAVED_RETRY_MS, signal)
    }
    if (!queued.ok || typeof queued.value?.id !== 'string') {
      throw new Error(messageOf(queued.value) || `HTTP ${queued.status}`)
    }
    const jobUrl = `${base}/${encodeURIComponent(queued.value.id)}`
    for (;;) {
      await wait(POLL_MS, signal)
      const answer = await request<Job>(jobUrl, signal)
      if (!answer.ok) throw new Error(messageOf(answer.value) || `HTTP ${answer.status}`)
      const job = answer.value
      onProgress(job.progress ?? 0)
      if (job.status === 'completed') {
        if (!job.result) throw new Error('The analysis finished without a result')
        return job.result
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        throw new Error(job.error || job.status)
      }
    }
  },
}
