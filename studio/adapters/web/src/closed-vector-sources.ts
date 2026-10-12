import { blobUrlManager } from '@/infrastructure/browser/blob-url-manager'
import {
  installScopedMediaResolver,
  notifyScopedMedia,
  type ScopedMediaResolution,
} from '@/features/media-library/utils/scoped-media-resolution'

export interface ClosedVectorSource {
  blob: Blob
  expiresAt: number
}
export interface ClosedVectorScope {
  /** Includes user, host/engine project, mount, revision, graph version and accepted graph bytes. */
  key: string
  ids: ReadonlySet<string>
  current(): boolean
  load(mediaId: string, signal: AbortSignal): Promise<ClosedVectorSource>
}

/** One lease per allocation; neither ordinary media releases nor old finally blocks own it. */
export function createClosedVectorSources() {
  const session = crypto.randomUUID()
  const known = new Set<string>()
  const withdrawn = new Set<string>()
  const entries = new Map<
    string,
    { key: string; url: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }
  >()
  const pending = new Map<string, Promise<ScopedMediaResolution>>()
  let scope: ClosedVectorScope | undefined
  let controller = new AbortController()
  let disposed = false
  const refused: ScopedMediaResolution = { handled: true, url: '' }
  const peek = (mediaId: string, vector = false): ScopedMediaResolution => {
    if (vector) known.add(mediaId)
    if (!known.has(mediaId)) return { handled: false }
    const entry = entries.get(mediaId)
    if (
      disposed ||
      withdrawn.has(mediaId) ||
      !scope?.ids.has(mediaId) ||
      !scope.current() ||
      !entry ||
      entry.expiresAt <= Date.now() ||
      blobUrlManager.get(entry.key) !== entry.url
    ) {
      if (entry) {
        entries.delete(mediaId)
        clearTimeout(entry.timer)
        blobUrlManager.release(entry.key)
      }
      return refused
    }
    return { handled: true, url: entry.url }
  }
  const resolve = async (mediaId: string, vector = false): Promise<ScopedMediaResolution> => {
    if (vector) known.add(mediaId)
    if (!known.has(mediaId)) return { handled: false }
    const active = scope
    if (disposed || withdrawn.has(mediaId) || !active?.ids.has(mediaId)) return refused
    if (!active.current()) {
      retire()
      scope = undefined
      notifyScopedMedia()
      return refused
    }
    const cached = peek(mediaId)
    if (cached.handled && cached.url) return cached
    const pendingKey = `${active.key}:${mediaId}`
    const existing = pending.get(pendingKey)
    if (existing) return existing
    const signal = controller.signal
    const request: Promise<ScopedMediaResolution> = Promise.resolve()
      .then<ScopedMediaResolution>(async () => {
        try {
          const result = await active.load(mediaId, signal)
          if (
            signal.aborted ||
            disposed ||
            scope !== active ||
            !active.current() ||
            result.expiresAt <= Date.now() ||
            withdrawn.has(mediaId) ||
            !active.ids.has(mediaId)
          )
            return refused
          const old = entries.get(mediaId)
          if (old) {
            clearTimeout(old.timer)
            blobUrlManager.release(old.key)
          }
          const key = `closed-vector:${session}:${crypto.randomUUID()}`
          const url = blobUrlManager.acquire(key, result.blob)
          const timer = setTimeout(
            () => {
              if (entries.get(mediaId)?.key !== key) return
              entries.delete(mediaId)
              blobUrlManager.release(key)
              notifyScopedMedia()
            },
            Math.min(2_147_483_647, result.expiresAt - Date.now()),
          )
          entries.set(mediaId, { key, url, expiresAt: result.expiresAt, timer })
          return { handled: true, url }
        } catch {
          return refused
        }
      })
      .finally(() => {
        if (pending.get(pendingKey) === request) pending.delete(pendingKey)
      })
    pending.set(pendingKey, request)
    return request
  }
  const uninstall = installScopedMediaResolver({ peek, resolve })
  const retire = () => {
    controller.abort()
    controller = new AbortController()
    for (const entry of entries.values()) {
      clearTimeout(entry.timer)
      blobUrlManager.release(entry.key)
    }
    entries.clear()
    pending.clear()
  }
  return {
    availability(mediaId: string, available: boolean): void {
      if (disposed || available === !withdrawn.has(mediaId)) return
      if (available) withdrawn.delete(mediaId)
      else withdrawn.add(mediaId)
      retire()
      notifyScopedMedia()
    },
    reconcile(next: ClosedVectorScope): void {
      if (disposed || scope?.key === next.key) return
      retire()
      scope = next
      for (const id of next.ids) known.add(id)
      notifyScopedMedia()
    },
    invalidate(): void {
      retire()
      scope = undefined
      notifyScopedMedia()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      retire()
      scope = undefined
      // Keep the handled-denied owner installed until this document is torn down.
      notifyScopedMedia()
      return
    },
    /** Called only after every outgoing native consumer has unmounted. */
    unmount: uninstall,
  }
}
