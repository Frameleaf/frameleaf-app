/**
 * Captions on Frameleaf Cloud (FL-1304): the editor's half.
 *
 * The host prices and runs the job. This follows it and adds the lines to the clip through the engine's
 * own per-clip replacement. It does not use `captions.set`, which replaces every caption on the sequence
 * and would remove the lines on other clips.
 */
import { toast } from 'sonner'
import type {
  StudioCloudCaptionAnchor,
  StudioCloudCaptionCue,
  StudioCloudCaptionJob,
  StudioCloudCaptionRequest,
  StudioCloudCaptionState,
} from '@frameleaf/host/cloud-captions'
import { i18n } from '@/i18n'
import { mediaTranscriptionService } from '@/features/media-library/services/media-transcription-service'
import { useMediaLibraryStore } from '@/features/media-library/stores/media-library-store'
import {
  findReplaceableCaptionItemsForClip,
  getClipSourceBounds,
} from '@/features/media-library/utils/caption-items'
import { useTimelineStore } from '@/features/timeline/stores/timeline-store'
import type { AudioItem, TimelineItem, VideoItem } from '@/types/timeline'

export interface CloudCaptionCalls {
  start(request: StudioCloudCaptionRequest): Promise<StudioCloudCaptionJob | null>
  read(id: string): Promise<StudioCloudCaptionState>
  pending(): Promise<StudioCloudCaptionJob[]>
  /** Resolves once this editor's own timeline has loaded; false if the editor closed first. */
  ready(): Promise<boolean>
}

const POLL_MS = 4000
/** Reads may fail while the server restarts; this many in a row means the job can't be followed. */
const MAX_READ_FAILURES = 15

const isClip = (item: TimelineItem | undefined): item is AudioItem | VideoItem =>
  item?.type === 'video' || item?.type === 'audio'

const findClip = (clipId: string) => {
  const item = useTimelineStore.getState().items.find((candidate) => candidate.id === clipId)
  return isClip(item) ? item : null
}

export function clipAnchor(clip: AudioItem | VideoItem, fps: number): StudioCloudCaptionAnchor {
  const { sourceStart, sourceFps, speed } = getClipSourceBounds(clip, fps)
  return { fromSeconds: clip.from / fps, sourceStartSeconds: sourceStart / sourceFps, speed }
}

/** Cues are timeline seconds at pricing; source seconds keep them on the words if the clip moves or is trimmed. */
export function cuesToSegments(cues: StudioCloudCaptionCue[], anchor: StudioCloudCaptionAnchor) {
  const source = (seconds: number) =>
    anchor.sourceStartSeconds + (seconds - anchor.fromSeconds) * anchor.speed
  return cues.map((cue) => ({ text: cue.text, start: source(cue.start), end: source(cue.end) }))
}

/** How many lines the clip already has that adding Cloud captions would replace. */
export function existingLineCount(
  items: readonly TimelineItem[],
  clip: AudioItem | VideoItem,
  fps: number,
): number {
  const placed = findReplaceableCaptionItemsForClip(items, clip, 'transcript').reduce(
    (total, item) => total + (item.type === 'subtitle' ? item.cues.length : 1),
    0,
  )
  if (!clip.transcriptCaptions?.enabled) return placed
  // A transcript covers the whole source; only the lines this clip shows count.
  const { sourceStart, sourceEnd, sourceFps } = getClipSourceBounds(clip, fps)
  const shown = clip.transcriptCaptions.cues.filter(
    (cue) =>
      cue.text.trim() &&
      cue.startSeconds < sourceEnd / sourceFps &&
      cue.endSeconds > sourceStart / sourceFps,
  )
  return placed + shown.length
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createCloudCaptions(calls: CloudCaptionCalls, pollMs = POLL_MS) {
  let stopped = false
  const following = new Set<string>()

  const add = async (job: StudioCloudCaptionJob, cues: StudioCloudCaptionCue[]) => {
    const clip = findClip(job.clipId)
    if (!clip?.mediaId) {
      toast.error(i18n.t('transcript.cloud.gone', { name: job.name }))
      return
    }
    if (clip.transcriptCaptions?.enabled) {
      // The clip's own transcript would otherwise draw on top of the new lines.
      useTimelineStore.getState().updateItem(clip.id, {
        transcriptCaptions: { ...clip.transcriptCaptions, enabled: false },
      })
    }
    await mediaTranscriptionService.insertTranscriptAsCaptions(clip.mediaId, {
      clipIds: [clip.id],
      replaceExisting: true,
      segments: cuesToSegments(cues, job.anchor),
    })
    toast.success(i18n.t('transcript.cloud.added', { name: job.name }))
  }

  const finish = async (job: StudioCloudCaptionJob, cues: StudioCloudCaptionCue[]) => {
    const clip = findClip(job.clipId)
    const { items, fps } = useTimelineStore.getState()
    const existing = clip ? existingLineCount(items, clip, fps) : 0
    if (!existing) {
      await add(job, cues)
      return
    }
    // The person may have edited those lines, so replacing them is their call.
    toast(i18n.t('transcript.cloud.readyTitle', { name: job.name }), {
      description: i18n.t('transcript.cloud.readyBody', { lines: cues.length, existing }),
      duration: Infinity,
      action: {
        label: i18n.t('transcript.cloud.replace'),
        onClick: () => void add(job, cues).catch(() => failed(job)),
      },
      cancel: { label: i18n.t('transcript.cloud.keep'), onClick: () => {} },
    })
  }

  const failed = (job: StudioCloudCaptionJob) =>
    toast.error(i18n.t('transcript.cloud.failed', { name: job.name }))

  const follow = async (job: StudioCloudCaptionJob) => {
    if (following.has(job.id)) return
    following.add(job.id)
    let failures = 0
    while (!stopped) {
      let state: StudioCloudCaptionState
      try {
        state = await calls.read(job.id)
        failures = 0
      } catch {
        if (++failures >= MAX_READ_FAILURES) {
          failed(job)
          return
        }
        await wait(pollMs)
        continue
      }
      if (state.status === 'completed') {
        // The project can be reloading under the job (a restored version, say).
        if (await calls.ready()) await finish(job, state.cues).catch(() => failed(job))
        return
      }
      if (state.status === 'failed') {
        failed(job)
        return
      }
      if (state.status === 'cancelled') return
      await wait(pollMs)
    }
  }

  return {
    start: async ({ clipId, language }: { clipId: string; language: string }) => {
      const clip = findClip(clipId)
      if (!clip) return
      const media = clip.mediaId ? useMediaLibraryStore.getState().mediaById[clip.mediaId] : undefined
      const name = media?.fileName ?? clip.label
      try {
        const job = await calls.start({
          clipId,
          language: language || 'auto',
          name,
          anchor: clipAnchor(clip, useTimelineStore.getState().fps),
        })
        if (job) await follow(job)
      } catch {
        toast.error(i18n.t('transcript.cloud.failed', { name }))
      }
    },
    /** Jobs confirmed before a reload still bring their captions back. */
    resume: async () => {
      const jobs = await calls.pending().catch(() => [])
      // The host forgets a job once it reads as settled, so its clip has to be there by then.
      if (jobs.length === 0 || !(await calls.ready())) return
      await Promise.all(jobs.map((job) => follow(job)))
    },
    stop: () => {
      stopped = true
    },
  }
}
