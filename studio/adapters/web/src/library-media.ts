/**
 * Library media in the editor's bin (FL-88).
 *
 * The host hands the editor `StudioAssetRef`s: an id, a name, a kind and URLs it already authorized
 * with the session's own credentials. Each becomes a Freecut media record whose id **is the library
 * asset id**, so a clip the person places carries `mediaId: <asset uuid>` into the graph and the
 * server's resource resolver (FL-90) recognises it as a library asset, applies the owner, sharing
 * and Locked checks, and issues read grants for it. Nothing is copied: playback resolves through
 * `blobUrlManager.registerUrl`, which mediabunny reads with HTTP range requests, exactly as Freecut's
 * own headless renderer does, and the source file in the workspace is a lazy file fetched only if
 * the engine asks for the bytes.
 *
 * Offline originals are never registered as a source, so the engine treats them as missing media
 * rather than cutting with something that will not render.
 */
import type { MediaMetadata } from '@/types/storage'
import { blobUrlManager } from '@/infrastructure/browser/blob-url-manager'
import {
  associateMediaWithProject,
  createMedia,
  getMedia,
  getProjectMediaIds,
  removeMediaFromProject,
  saveThumbnail,
  updateMedia,
} from '@/infrastructure/storage'
import { mediaDir, projectMediaLinksPath } from '@/infrastructure/storage/workspace-fs/paths'
import type { StudioAssetRef } from '@frameleaf/host/host-contract'
import type { VirtualWorkspace } from './virtual-workspace'

const COMMON_FRAME_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120]

/** Snap a measured packet rate to the nearest broadcast rate, as Freecut's own importer does. */
export const snapFrameRate = (fps: number): number => {
  if (!Number.isFinite(fps) || fps <= 0) return 30
  let best = COMMON_FRAME_RATES[0]
  for (const rate of COMMON_FRAME_RATES) {
    if (Math.abs(rate - fps) < Math.abs(best - fps)) best = rate
  }
  return Math.abs(best - fps) <= 0.5 ? best : Math.round(fps * 1000) / 1000
}

const durationSeconds = (asset: StudioAssetRef): number =>
  asset.duration ? asset.duration.num / asset.duration.den : 0

/** The URL the engine plays: the transcoded playback stream for video, the preview for stills. */
export const sourceUrlOf = (asset: StudioAssetRef): string =>
  asset.kind === 'video' && asset.playbackUrl ? asset.playbackUrl : asset.previewUrl

const fileNameOf = (asset: StudioAssetRef): string => {
  const cleaned = asset.name.replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned.length > 0 ? cleaned : asset.id
}

/** What the library already knows, before any probe. */
export const initialMediaRecord = (asset: StudioAssetRef, now: number): MediaMetadata => ({
  id: asset.id,
  storageType: 'workspace',
  fileName: fileNameOf(asset),
  fileSize: 0,
  mimeType: asset.mimeType ?? (asset.kind === 'video' ? 'video/mp4' : 'image/jpeg'),
  duration: durationSeconds(asset),
  width: asset.width ?? 0,
  height: asset.height ?? 0,
  fps: asset.kind === 'video' ? 30 : 0,
  codec: 'unknown',
  bitrate: 0,
  videoCodecSupported: true,
  audioCodecSupported: true,
  tags: [],
  createdAt: now,
  updatedAt: now,
})

export interface ProbedMedia {
  width: number
  height: number
  fps: number
  duration: number
  codec: string
  audioCodec?: string
}

/**
 * Read the header of a video through range requests: size, duration, codec and frame rate. The
 * frame rate matters: Freecut converts trims to source frames with it, so a guessed rate would
 * move every cut.
 */
export async function probeVideo(url: string, signal: AbortSignal): Promise<ProbedMedia | null> {
  const { Input, UrlSource, ALL_FORMATS } = await import('mediabunny')
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
  const abort = () => input.dispose()
  signal.addEventListener('abort', abort, { once: true })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) return null
    const audio = await input.getPrimaryAudioTrack()
    const stats = await video.computePacketStats(120)
    return {
      width: video.displayWidth,
      height: video.displayHeight,
      fps: snapFrameRate(stats.averagePacketRate),
      duration: await input.computeDuration(),
      codec: (await video.getCodecParameterString()) ?? video.codec ?? 'unknown',
      audioCodec: audio
        ? ((await audio.getCodecParameterString()) ?? audio.codec ?? undefined)
        : undefined,
    }
  } catch {
    return null
  } finally {
    signal.removeEventListener('abort', abort)
    input.dispose()
  }
}

async function probeImage(
  url: string,
  signal: AbortSignal,
): Promise<{ width: number; height: number } | null> {
  try {
    const response = await fetch(url, { signal, credentials: 'same-origin' })
    if (!response.ok) return null
    const bitmap = await createImageBitmap(await response.blob())
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch {
    return null
  }
}

async function fetchBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal, credentials: 'same-origin' })
  if (!response.ok) {
    throw new Error(`Library media request failed with HTTP ${response.status}`)
  }
  return response.blob()
}

export interface LibraryMediaSeeder {
  /** Make these assets available to the project; already-seeded ids are left alone. */
  seed(assets: readonly StudioAssetRef[]): Promise<void>
  /**
   * Link the bin to another project (a remounted editor has its own project id): every seeded
   * library asset and, with `from`, every media that project held, which includes what the person
   * imported inside the editor (FL-174). Without it an imported file leaves the bin on a remount.
   */
  associate(projectId: string, from?: string): Promise<void>
  /** The person removed this media from the bin (FL-174): no remount or late import links it again. */
  forget(mediaId: string): void
  /** The media is in the current bin again (imported again, or linked again by Freecut). */
  remember(mediaId: string): void
  /** What this seeder linked to `projectId`: the bin it put there, before anyone else changed it. */
  linked(projectId: string): ReadonlySet<string>
  /** Stop probing and release every registered URL. */
  dispose(): void
}

export function createLibraryMediaSeeder(options: {
  workspace: VirtualWorkspace
  /** The project new assets are linked to: the current editor mount's. */
  projectId: () => string
  /** Called after a record changes, so the bin can re-read it. */
  onChange: () => void
}): LibraryMediaSeeder {
  const { workspace, projectId, onChange } = options
  const seeded = new Set<string>()
  /** Removed from the bin by the person; never carried to another mount. */
  const removed = new Set<string>()
  /** What was linked to each recent mount's project here (the last few mounts only). */
  const linkedTo = new Map<string, Set<string>>()
  const link = async (target: string, id: string) => {
    await associateMediaWithProject(target, id)
    let ids = linkedTo.get(target)
    if (!ids) {
      ids = new Set()
      linkedTo.set(target, ids)
      for (const key of linkedTo.keys()) {
        if (linkedTo.size <= 4) break
        linkedTo.delete(key)
      }
    }
    ids.add(id)
  }
  const controller = new AbortController()
  let probing: Promise<void> = Promise.resolve()

  const enrich = async (asset: StudioAssetRef) => {
    if (controller.signal.aborted) return
    const url = sourceUrlOf(asset)
    const updates: Partial<MediaMetadata> = {}
    if (asset.kind === 'video') {
      const probed = await probeVideo(url, controller.signal)
      if (!probed) {
        updates.videoCodecSupported = false
      } else {
        Object.assign(updates, probed, { audioCodecSupported: true })
      }
    } else if (!asset.width || !asset.height) {
      const size = await probeImage(url, controller.signal)
      if (size) Object.assign(updates, size)
    }
    try {
      const thumbnail = await fetchBlob(asset.thumbnailUrl, controller.signal)
      const thumbnailId = `thumb-${asset.id}`
      await saveThumbnail({
        id: thumbnailId,
        mediaId: asset.id,
        blob: thumbnail,
        timestamp: 0,
        width: 320,
        height: 180,
      })
      updates.thumbnailId = thumbnailId
    } catch {
      // The bin falls back to its own placeholder.
    }
    if (controller.signal.aborted || Object.keys(updates).length === 0) return
    await updateMedia(asset.id, { ...updates, updatedAt: Date.now() })
    onChange()
  }

  return {
    async seed(assets) {
      const fresh = assets.filter((asset) => !seeded.has(asset.id) && !asset.isOffline)
      const now = Date.now()
      for (const asset of fresh) {
        seeded.add(asset.id)
        const record = initialMediaRecord(asset, now)
        if (!(await getMedia(asset.id))) {
          await createMedia(record)
        }
        // Media bytes stay on the server until something actually reads them.
        workspace.putLazyFile(
          [...mediaDir(asset.id), record.fileName],
          () => fetchBlob(sourceUrlOf(asset)),
          record.mimeType,
        )
        blobUrlManager.registerUrl(asset.id, sourceUrlOf(asset))
        await link(projectId(), asset.id)
      }
      if (fresh.length > 0) onChange()
      // Probe one at a time in the background, handoff order first: it is the starting cut.
      probing = probing.then(async () => {
        for (const asset of fresh) await enrich(asset)
      })
      await probing
    },
    async associate(target, from) {
      const ids = new Set(seeded)
      if (from && from !== target) {
        for (const id of await getProjectMediaIds(from)) ids.add(id)
      }
      const linked: string[] = []
      for (const id of ids) {
        if (removed.has(id)) continue
        await link(target, id)
        linked.push(id)
      }
      // Removed from the bin while this ran (Freecut's removal of the current mount): not linked
      // after all, so the removal stands.
      for (const id of linked) {
        if (removed.has(id)) await removeMediaFromProject(target, id)
      }
      onChange()
    },
    forget(mediaId) {
      removed.add(mediaId)
    },
    remember(mediaId) {
      removed.delete(mediaId)
    },
    linked(projectId) {
      return linkedTo.get(projectId) ?? new Set()
    },
    dispose() {
      controller.abort()
      for (const id of seeded) blobUrlManager.release(id)
      seeded.clear()
    },
  }
}

/** How many replaced mounts are followed for late imports (FL-174); older ones are let go. */
export const RETIRED_MOUNTS_FOLLOWED = 3

/** Record a replaced mount's project id, keeping only the most recent `RETIRED_MOUNTS_FOLLOWED`. */
export function retireProject(
  retired: Set<string>,
  projectId: string,
  keep = RETIRED_MOUNTS_FOLLOWED,
): void {
  retired.delete(projectId)
  retired.add(projectId)
  for (const oldest of retired) {
    if (retired.size <= keep) break
    retired.delete(oldest)
  }
}

/**
 * Keep the bin of the current editor mount whole across remounts (FL-174).
 *
 * - **Late imports.** Media the person imports inside the editor is linked to the current mount's
 *   project. An import still running in a replaced instance links it to that instance's project
 *   after the remount carried the links over; this carries it again, so the bin and Freecut's
 *   orphaned-clip check of the current mount see it. Bursts of writes to one replaced project run
 *   one association at a time, with at most one more after it.
 * - **Removals.** When the person removes media from the current bin, it is forgotten (no remount or
 *   late import links it again) and unlinked from every followed replaced project through `release`,
 *   Freecut's own removal, which frees the record once no project links it. Otherwise the replaced
 *   projects' links would keep it alive and bring it back.
 *
 * Writes to the current mount's links are never carried anywhere. Returns the unsubscribe.
 */
export function followRetiredImports(options: {
  workspace: VirtualWorkspace
  media: LibraryMediaSeeder
  /** Project ids of replaced editor mounts (bounded by `retireProject`). */
  retired: ReadonlySet<string>
  current: () => string
  /** Unlink `mediaId` from `projectId` and free the record once nothing links it. */
  release: (projectId: string, mediaId: string) => Promise<void>
  onError: (error: unknown) => void
}): () => void {
  const { workspace, media, retired, current, release, onError } = options
  const pathOf = (projectId: string) => projectMediaLinksPath(projectId).join('/')

  const running = new Set<string>()
  const again = new Set<string>()
  const carry = (projectId: string) => {
    if (running.has(projectId)) {
      again.add(projectId)
      return
    }
    running.add(projectId)
    void (async () => {
      do {
        again.delete(projectId)
        const target = current()
        if (target !== projectId && retired.has(projectId)) await media.associate(target, projectId)
      } while (again.has(projectId))
    })()
      .catch(onError)
      .finally(() => running.delete(projectId))
  }

  /** The current mount's links as last read, per mount project, to tell a removal from an addition. */
  const known = new Map<string, Set<string>>()
  const reconcile = async (projectId: string) => {
    // Before the first read of this mount's links, what the seeder had put there when this read began
    // is the baseline, so a removal that lands before that read still counts.
    const seededBefore = new Set(media.linked(projectId))
    const now = new Set(await getProjectMediaIds(projectId))
    const before = known.get(projectId) ?? seededBefore
    // Only the current mount's links are compared; a replaced mount's are let go.
    known.clear()
    known.set(projectId, now)
    for (const id of now) {
      if (!before.has(id)) media.remember(id)
    }
    for (const id of before) {
      if (now.has(id)) continue
      media.forget(id)
      for (const retiredId of [...retired]) {
        if (!(await getProjectMediaIds(retiredId)).includes(id)) continue
        // Already freed, or freed by Freecut meanwhile: nothing left to release.
        await release(retiredId, id).catch(() => undefined)
      }
    }
  }
  // Reads run in order, so each compares with the one before it.
  let reconciling: Promise<void> = Promise.resolve()
  const track = (projectId: string) => {
    reconciling = reconciling.then(() => reconcile(projectId)).catch(onError)
  }
  track(current())

  return workspace.onWrite((path) => {
    const written = path.join('/')
    const target = current()
    if (written === pathOf(target)) {
      track(target)
      return
    }
    for (const projectId of retired) {
      if (written === pathOf(projectId)) {
        carry(projectId)
        return
      }
    }
  })
}
