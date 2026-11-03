import { describe, expect, it } from 'vite-plus/test'
import type { Project, ProjectTimeline } from '@/types/project'
import type { MediaMetadata } from '@/types/storage'
import type { TimelineItem } from '@/types/timeline'
import { useEditorStore } from '@/shared/state/editor'
import {
  buildTimelineFromStores,
  hydrateTimelineStoresFromProject,
} from '@/features/timeline/stores/timeline-persistence'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useMediaLibraryStore } from '@/features/media-library/stores/media-library-store'
import { removeTranscriptRangesFromItems } from '@/features/timeline/stores/actions/edit/range-removal-actions'
import { restoreTranscriptCut } from '@/features/timeline/stores/actions/edit/transcript-restore-actions'
import {
  cutForEntry,
  placeTranscriptEntries,
  planCutRestore,
  transcriptCuts,
  transcriptExtent,
  transcriptPieces,
} from '@/features/timeline/utils/transcript-document'
import { applyCanonicalCommands, type CanonicalEnvelope } from '../src/canonical-commands'

/**
 * FL-562: a transcript cut in the web editor is the graph edit a native app makes with the
 * canonical commands of protocol section 12 — `clip.split` at both ends and a ripple
 * `clip.delete` — and bringing one cut back is a ripple `clip.trimEnd` and a `clip.join`. The
 * stored graphs agree clip for clip, picture and linked sound, so save, reopen, export and the
 * native apps all see the same edit.
 */

const ASSET = '0198a1c2-0000-7000-8000-000000000562'
const media: MediaMetadata[] = [
  {
    id: ASSET,
    storageType: 'workspace',
    fileName: 'lake-morning.mov',
    fileSize: 1,
    mimeType: 'video/mp4',
    duration: 8,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'avc1.64002a',
    audioCodec: 'mp4a.40.2',
    bitrate: 1,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  },
]

const track = (id: string, kind: 'video' | 'audio', order: number) => ({
  id,
  name: id,
  kind,
  height: 80,
  locked: false,
  visible: true,
  muted: false,
  solo: false,
  order,
})

const project = (): Project =>
  ({
    id: 'fl-562',
    name: 'Transcript',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    duration: 0,
    schemaVersion: 15,
    metadata: { width: 1920, height: 1080, fps: 30 },
    timeline: {
      tracks: [track('v1', 'video', 0), track('a1', 'audio', 1)],
      items: [],
      transitions: [],
      keyframes: [],
      currentFrame: 0,
      zoomLevel: 1,
      scrollPosition: 0,
    } as unknown as ProjectTimeline,
  }) as unknown as Project

let sequence = 0
const envelope = (id: string, payload: Record<string, unknown>): CanonicalEnvelope => ({
  id,
  payload,
  revision: 1,
  idempotencyKey: `fl-562-${++sequence}`,
  issuedAt: 1_793_000_000_000,
})
const seconds = (num: number, den = 1) => ({ num, den })

const applied = async (graph: unknown, envelopes: CanonicalEnvelope[]) => {
  const outcome = await applyCanonicalCommands(graph, envelopes, media)
  if (outcome.status !== 'applied') throw new Error(`${outcome.reason}: ${outcome.detail}`)
  return outcome.project
}

/** What a viewer of the graph sees: every clip's place and source window, ids aside. */
const shape = (items: readonly TimelineItem[]) =>
  items
    .filter((item) => item.type === 'video' || item.type === 'audio')
    .map((item) => ({
      type: item.type,
      trackId: item.trackId,
      from: item.from,
      durationInFrames: item.durationInFrames,
      sourceStart: (item as { sourceStart?: number }).sourceStart,
      sourceEnd: (item as { sourceEnd?: number }).sourceEnd,
    }))
    .toSorted((a, b) => a.type.localeCompare(b.type) || a.from - b.from)

const videoAt = (graph: Project, frame: number) =>
  graph.timeline!.items.find(
    (item) => item.type === 'video' && item.from <= frame && frame < item.from + item.durationInFrames,
  )!

/** Run an edit on the engine's stores the way the transcript panel does, and read the graph back. */
async function inEditor(graph: Project, edit: () => void): Promise<Project> {
  await hydrateTimelineStoresFromProject(structuredClone(graph))
  useMediaLibraryStore.setState({ mediaItems: [...media], mediaById: { [ASSET]: media[0]! } })
  useEditorStore.setState({ linkedSelectionEnabled: true })
  edit()
  return { ...graph, timeline: buildTimelineFromStores() }
}

describe('FL-562 transcript edits are canonical graph edits', () => {
  it('cutting words equals clip.split twice and a ripple clip.delete', async () => {
    const start = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const clip = videoAt(start, 0)

    // Native: split at 1 s and 1.8 s, then ripple-delete the middle.
    const once = await applied(start, [envelope('clip.split', { at: seconds(1), clipIds: [clip.id] })])
    const twice = await applied(once, [
      envelope('clip.split', { at: seconds(9, 5), clipIds: [videoAt(once, 30).id] }),
    ])
    const native = await applied(twice, [
      envelope('clip.delete', { clipId: videoAt(twice, 30).id, ripple: true }),
    ])

    // Web: select "um, this" (1.0–1.8 s) in the transcript panel and press Delete.
    const web = await inEditor(start, () => {
      removeTranscriptRangesFromItems([clip.id], { [ASSET]: [{ start: 1, end: 1.8 }] })
    })

    expect(shape(web.timeline!.items)).toEqual(shape(native.timeline!.items))
    expect(shape(web.timeline!.items)).toEqual([
      { type: 'audio', trackId: 'a1', from: 0, durationInFrames: 30, sourceStart: 0, sourceEnd: 30 },
      { type: 'audio', trackId: 'a1', from: 30, durationInFrames: 186, sourceStart: 54, sourceEnd: 240 },
      { type: 'video', trackId: 'v1', from: 0, durationInFrames: 30, sourceStart: 0, sourceEnd: 30 },
      { type: 'video', trackId: 'v1', from: 30, durationInFrames: 186, sourceStart: 54, sourceEnd: 240 },
    ])
    // The graph reopens (round-trips through the engine) unchanged.
    expect(shape((await applied(JSON.parse(JSON.stringify(web)), [])).timeline!.items)).toEqual(shape(web.timeline!.items))
  })

  it('bringing one cut back equals a ripple clip.trimEnd and clip.join', async () => {
    const start = await applied(project(), [envelope('clip.add', { trackId: 'v1', assetId: ASSET, at: seconds(0) })])
    const clip = videoAt(start, 0)
    const cut = await inEditor(start, () => {
      removeTranscriptRangesFromItems([clip.id], { [ASSET]: [{ start: 1, end: 1.8 }] })
    })

    const left = videoAt(cut, 0)
    const native = await applied(cut, [
      envelope('clip.trimEnd', { clipId: left.id, end: seconds(9, 5), ripple: true }),
    ])
    const nativeJoined = await applied(native, [
      envelope('clip.join', { clipIds: [videoAt(native, 0).id, videoAt(native, 54).id] }),
    ])

    const web = await inEditor(cut, () => {
      const items = useItemsStore.getState().items
      const pieces = transcriptPieces(items, clip.originId ?? clip.id, ASSET, 30)
      const extent = transcriptExtent(pieces)
      const entries = placeTranscriptEntries(
        [{ kind: 'word', key: 'w:0:1', segmentIndex: 0, wordIndex: 1, text: 'um,', start: 1, end: 1.3, filler: true }],
        [],
        pieces,
        extent,
        30,
      )
      expect(entries[0]!.removed).toBe(true)
      const plan = planCutRestore(pieces, cutForEntry(transcriptCuts(pieces, extent), entries[0]!)!, 30)!
      expect(restoreTranscriptCut(plan)).toBe(true)
    })

    expect(shape(web.timeline!.items)).toEqual(shape(nativeJoined.timeline!.items))
    expect(shape(web.timeline!.items)).toEqual(shape(start.timeline!.items))
  })
})
