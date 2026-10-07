/** One browser-local sequence job. Native workers, fallback, timings and cache format stay native. */
import type { Project } from '@/types/project'
import type { TimelineItem } from '@/types/timeline'
import type { StudioTranscriptionRequest } from '@frameleaf/host/frame-protocol'
import type { StudioTranscriptionProgress, StudioTranscriptionOutcome } from '@frameleaf/host/host-contract'
import { projectCadenceOf, timelineFrameTime } from '@frameleaf/host/studio-timing'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { useSettingsStore } from '@/features/media-library/deps/settings-contract'
import { DEFAULT_WHISPER_MODEL } from '@/shared/utils/whisper-settings'
import { requireResource } from '@/shared/utils/resource-admission.mjs'
import { MODEL_IDS } from '@/features/media-library/transcription/types'
import { resolveTranscriptionEngine } from '@/features/media-library/transcription/transcription-engine'
import { runMediaTranscriptionJob, cancelMediaTranscriptionJob } from '@/features/media-library/services/media-transcription-runner'
import { buildSubtitleTextItemsForClip, findCaptionTargetClipsForMedia } from '@/features/media-library/utils/caption-items'
import { createLibraryMediaSeeder } from './library-media'
import { VirtualWorkspace } from './virtual-workspace'

export async function transcribeSequence(
  request: StudioTranscriptionRequest,
  signal: AbortSignal,
  progress: (value: StudioTranscriptionProgress) => void,
): Promise<StudioTranscriptionOutcome> {
  const { envelope, assets } = request
  const graph = request.graph as Project
  if (envelope.payload.destinationId !== 'browser-local' || envelope.payload.sequenceId !== 'main')
    throw new Error('Browser transcription currently supports the main sequence on browser-local only')
  const cadence = projectCadenceOf(graph?.metadata)
  const items = (graph?.timeline?.items ?? []) as TimelineItem[]
  if (!cadence || !Array.isArray(items) || items.some((item) => item.type === 'composition')
    || graph.timeline?.compositions?.some((composition) => composition.id === 'main'))
    throw new Error('Transcription needs an exact project cadence and a sequence without compound clips')
  const mediaIds = [...new Set(items.filter((item) => item.type === 'audio' || item.type === 'video').map((item) => item.mediaId))]
  const selected = mediaIds.map((id) => assets.find((asset) => asset.id === id && asset.kind === 'video' && !asset.isOffline))
  if (!mediaIds.length || selected.some((asset) => !asset || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(asset.id)))
    throw new Error('Every transcribed source must be an available library video authorized by this host')
  const clips = mediaIds.flatMap((id) => findCaptionTargetClipsForMedia(items, id!))
  if (clips.some((clip) => !Number.isSafeInteger(clip.from) || clip.from < 0 || !Number.isSafeInteger(clip.durationInFrames)
    || clip.durationInFrames < 1 || !Number.isSafeInteger(clip.from + clip.durationInFrames)
    || !Number.isSafeInteger(clip.sourceStart ?? 0) || (clip.sourceStart ?? 0) < 0
    || (clip.sourceEnd !== undefined && (!Number.isSafeInteger(clip.sourceEnd) || clip.sourceEnd <= (clip.sourceStart ?? 0)))
    || !Number.isFinite(clip.sourceFps ?? cadence.num / cadence.den) || (clip.sourceFps ?? cadence.num / cadence.den) <= 0
    || !Number.isFinite(clip.speed ?? 1) || (clip.speed ?? 1) <= 0
    || clip.isReversed || clip.reverseConformKey || clip.reverseConformPath))
    throw new Error('Unsupported clip timing for browser transcription')

  // Admit the native selected/fallback model before even reading private media. Workers still
  // check their exact revisions and every file's approved digest, including any OOM fallback.
  const model = useSettingsStore.getState().defaultWhisperModel ?? DEFAULT_WHISPER_MODEL
  const resolved = resolveTranscriptionEngine(model, envelope.payload.language)
  requireResource('model:' + MODEL_IDS[resolved.model])
  const workspace = new VirtualWorkspace()
  setWorkspaceRoot(workspace.handle())
  const media = createLibraryMediaSeeder({ workspace, projectId: () => graph.id, onChange: () => {} })
  let active: string | undefined
  const cancel = () => { media.dispose(); if (active) cancelMediaTranscriptionJob(active) }
  signal.addEventListener('abort', cancel, { once: true })
  const captions: Extract<StudioTranscriptionOutcome, { status: 'completed' }>['captions'] = []
  try {
    signal.throwIfAborted()
    await media.seed(selected as typeof assets)
    for (const [index, mediaId] of mediaIds.entries()) {
      signal.throwIfAborted()
      active = mediaId!
      const result = await runMediaTranscriptionJob(active, {
        model, language: envelope.payload.language,
        onQueueStatusChange: () => progress({ mediaId: active!, stage: 'queued', progress: 0, completed: index, total: mediaIds.length }),
        onProgress: (event) => progress({ mediaId: active!, stage: event.stage, progress: event.progress, completed: index, total: mediaIds.length }),
      })
      signal.throwIfAborted()
      if (result.status === 'cancelled') return result
      for (const clip of clips.filter((clip) => clip.mediaId === mediaId)) {
        const lines = buildSubtitleTextItemsForClip({
          trackId: '', clip, timelineFps: cadence.num / cadence.den,
          canvasWidth: graph.metadata.width, canvasHeight: graph.metadata.height,
          fileName: '', format: 'srt',
          cues: result.transcript.segments.map((segment, index) => ({ id: String(index), startSeconds: segment.start, endSeconds: segment.end, text: segment.text })),
        })
        captions.push(...lines.map((line) => ({ text: line.text,
          start: timelineFrameTime(line.from, cadence), end: timelineFrameTime(line.from + line.durationInFrames, cadence) })))
      }
    }
    if (!captions.length) throw new Error('The transcript does not overlap this sequence; existing captions were kept')
    return { status: 'completed', captions }
  } finally {
    signal.removeEventListener('abort', cancel)
    media.dispose()
    workspace.dispose()
  }
}
