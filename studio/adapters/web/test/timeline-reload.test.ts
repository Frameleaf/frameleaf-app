import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Project, ProjectTimeline } from '@/types/project'
import type { TimelineTrack } from '@/types/timeline'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { createProject, getProject } from '@/infrastructure/storage'
import { CURRENT_SCHEMA_VERSION } from '@/shared/projects/migrations/types'
import { buildTimelineFromStores, loadTimeline, saveTimeline } from '@/features/timeline/stores/timeline-persistence'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useCompositionsStore } from '@/features/timeline/stores/compositions-store'
import { useSequencesStore } from '@/features/timeline/stores/sequences-store'
import {
  getActiveTabId,
  useCompositionNavigationStore,
} from '@/features/timeline/stores/composition-navigation-store'
import { rollingTrimItems } from '@/features/timeline/stores/actions/item-actions'
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store'
import { useEditorStore } from '@/shared/state/editor'
import { VirtualWorkspace } from '../src/virtual-workspace'

// jsdom's Blob predates `text()` and `arrayBuffer()`; browsers have both.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(this)
    })
  }
}
if (!Blob.prototype.text) {
  Blob.prototype.text = async function (this: Blob) {
    return new TextDecoder().decode(await this.arrayBuffer())
  }
}

vi.mock('@/infrastructure/storage/handles-db', () => ({
  getHandle: vi.fn(async () => undefined),
  saveHandle: vi.fn(async () => undefined),
  deleteHandle: vi.fn(async () => undefined),
}))

/**
 * FL-94: track controls, linked clips and compound sequence tabs survive a save and a reload through
 * Freecut's own persistence on the adapter's workspace — including a save made while a sequence tab
 * is open, and a reload the way a remount does it (the saved document under a new mount id).
 */

const track = (id: string, kind: 'video' | 'audio', order: number, flags: Partial<TimelineTrack> = {}) => ({
  id,
  name: id.toUpperCase(),
  kind,
  height: 60,
  locked: false,
  visible: true,
  muted: false,
  solo: false,
  order,
  items: [],
  ...flags,
})

const clip = (id: string, trackId: string, type: 'video' | 'audio', extra: Record<string, unknown> = {}) => ({
  id,
  trackId,
  type,
  from: 30,
  durationInFrames: 60,
  label: `${id}.mp4`,
  src: '',
  mediaId: 'media-1',
  sourceStart: 0,
  sourceEnd: 60,
  sourceDuration: 240,
  sourceFps: 30,
  linkedGroupId: 'link-1',
  ...extra,
})

const graph = (id: string): Project =>
  ({
    id,
    name: 'Reload',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    duration: 0,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    metadata: { width: 1920, height: 1080, fps: 30 },
    timeline: {
      tracks: [
        track('v1', 'video', 0, { locked: true }),
        track('v2', 'video', 1, { visible: false }),
        track('a1', 'audio', 2, { muted: true, syncLock: false }),
        // An empty trailing audio track someone soloed is kept: dropping it would unmute the mix.
        track('a2', 'audio', 3, { solo: true }),
        // An untouched empty trailing audio track is still tidied away, as Freecut does.
        track('a3', 'audio', 4),
      ],
      items: [
        clip('pic', 'v1', 'video'),
        // Linked sound one second out of sync: the sync badge is derived from this offset.
        clip('snd', 'a1', 'audio', { from: 60 }),
        {
          id: 'wrapper',
          trackId: 'v2',
          type: 'composition',
          compositionId: 'seq-b',
          compositionWidth: 1920,
          compositionHeight: 1080,
          from: 120,
          durationInFrames: 45,
          label: 'Sequence B',
        },
      ],
      transitions: [],
      keyframes: [],
      markers: [{ id: 'm', frame: 45, color: '#fff' }],
      currentFrame: 0,
      zoomLevel: 1,
      scrollPosition: 0,
      topLevelSequenceIds: ['seq-b'],
      compositions: [
        {
          id: 'seq-b',
          name: 'Sequence B',
          editorKind: 'sequence',
          items: [
            {
              id: 'title',
              trackId: 'b1',
              type: 'text',
              from: 0,
              durationInFrames: 45,
              label: 'Title',
              text: 'Title',
              color: '#ffffff',
            },
          ],
          tracks: [track('b1', 'video', 0, { locked: true, visible: false })],
          transitions: [],
          keyframes: [],
          fps: 30,
          width: 1920,
          height: 1080,
          durationInFrames: 45,
          markers: [],
        },
      ],
    } as unknown as ProjectTimeline,
  }) as Project

const trackFlags = (tracks: ReadonlyArray<Partial<TimelineTrack>>) =>
  tracks
    .filter((entry) => !entry.isGroup)
    .map(({ id, locked, visible, muted, solo, syncLock }) => ({
      id,
      locked,
      visible,
      muted,
      solo,
      syncLock: syncLock ?? true,
    }))

const expected = [
  { id: 'v1', locked: true, visible: true, muted: false, solo: false, syncLock: true },
  { id: 'v2', locked: false, visible: false, muted: false, solo: false, syncLock: true },
  { id: 'a1', locked: false, visible: true, muted: true, solo: false, syncLock: false },
  { id: 'a2', locked: false, visible: true, muted: false, solo: true, syncLock: true },
]

describe('FL-94 timeline state across save and reload', () => {
  let workspace: VirtualWorkspace

  beforeEach(() => {
    workspace = new VirtualWorkspace()
    setWorkspaceRoot(workspace.handle())
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 })),
    )
  })

  afterEach(() => {
    useCompositionNavigationStore.getState().resetToRoot()
    vi.unstubAllGlobals()
    setWorkspaceRoot(null)
    workspace.dispose()
  })

  it('keeps track controls, linked clips and compound sequence tabs, saved from inside a tab', async () => {
    await createProject(graph('fl-reload'))
    await loadTimeline('fl-reload')
    expect(trackFlags(useItemsStore.getState().tracks)).toEqual(expected)

    // Edit inside the sequence tab, then save while it is still open.
    useCompositionNavigationStore.getState().switchToSequence('seq-b')
    const [b1] = useItemsStore.getState().tracks
    useItemsStore.getState().setTracks([{ ...b1!, muted: true }])
    await saveTimeline('fl-reload')

    // A remount reloads the saved document under its own id.
    const saved = (await getProject('fl-reload'))!
    workspace.putFile(
      ['projects', 'fl-reload-m1', 'project.json'],
      JSON.stringify({ ...saved, id: 'fl-reload-m1' }),
    )
    useCompositionNavigationStore.getState().resetToRoot()
    useItemsStore.getState().setItems([])
    useItemsStore.getState().setTracks([])
    useCompositionsStore.getState().setCompositions([])
    await loadTimeline('fl-reload-m1')

    expect(getActiveTabId(useCompositionNavigationStore.getState().breadcrumbs)).toBeNull()
    expect(trackFlags(useItemsStore.getState().tracks)).toEqual(expected)
    const items = useItemsStore.getState().items
    expect(items.map((item) => [item.id, item.from, item.linkedGroupId]).sort()).toEqual([
      ['pic', 30, 'link-1'],
      ['snd', 60, 'link-1'],
      ['wrapper', 120, undefined],
    ])
    expect(useSequencesStore.getState().topLevelSequenceIds).toEqual(['seq-b'])
    const sequence = useCompositionsStore.getState().compositions.find((entry) => entry.id === 'seq-b')!
    expect(trackFlags(sequence.tracks)).toEqual([
      { id: 'b1', locked: true, visible: false, muted: true, solo: false, syncLock: true },
    ])
    expect(sequence.items.map((item) => item.id)).toEqual(['title'])

    // The tab reopens with its content.
    useCompositionNavigationStore.getState().switchToSequence('seq-b')
    expect(useItemsStore.getState().items.map((item) => item.id)).toEqual(['title'])
    expect(trackFlags(useItemsStore.getState().tracks)[0]).toMatchObject({ locked: true, muted: true })
  })

  it.each([false, true])('rolls inside a nested sequence with exact history/reload (audio locked: %s)', async (locked) => {
    const initial = graph(`fl-nested-roll-${locked}`)
    const parent = initial.timeline!.compositions![0]!
    parent.items.push({
      id: 'inner-wrapper', trackId: 'b1', type: 'composition', compositionId: 'inner',
      compositionWidth: 1920, compositionHeight: 1080, from: 60, durationInFrames: 240,
      sourceStart: 0, sourceEnd: 240, label: 'Inner sequence',
    } as never)
    parent.durationInFrames = 300
    initial.timeline!.compositions!.push({
      id: 'inner', name: 'Inner sequence', editorKind: 'sequence',
      tracks: [track('inner-v', 'video', 0), track('inner-a', 'audio', 1, { locked })],
      items: [
        clip('left-v', 'inner-v', 'video', { from: 0, durationInFrames: 120, sourceEnd: 120, linkedGroupId: 'left' }),
        clip('left-a', 'inner-a', 'audio', { from: 0, durationInFrames: 120, sourceEnd: 120, linkedGroupId: 'left' }),
        clip('right-v', 'inner-v', 'video', { from: 120, durationInFrames: 120, sourceStart: 30, sourceEnd: 150, linkedGroupId: 'right' }),
        clip('right-a', 'inner-a', 'audio', { from: 120, durationInFrames: 120, sourceStart: 30, sourceEnd: 150, linkedGroupId: 'right' }),
      ],
      transitions: [], keyframes: [], fps: 30, width: 1920, height: 1080,
      durationInFrames: 240, markers: [{ id: 'inner-marker', frame: 210, color: '#fff' }],
    } as never)
    await createProject(initial)
    await loadTimeline(initial.id)
    useCompositionNavigationStore.getState().switchToSequence('seq-b')
    useCompositionNavigationStore.getState().enterComposition('inner', 'Inner sequence', 'inner-wrapper')
    expect(useCompositionNavigationStore.getState().activeCompositionId).toBe('inner')
    expect(useCompositionNavigationStore.getState().breadcrumbs.map(({ compositionId }) => compositionId)).toEqual(['seq-b', 'inner'])
    const previousLinked = useEditorStore.getState().linkedSelectionEnabled
    useEditorStore.setState({ linkedSelectionEnabled: true })
    try {
      const before = structuredClone(buildTimelineFromStores())
      const expected = structuredClone(before)
      if (!locked) {
        const inner = expected.compositions!.find(({ id }) => id === 'inner')!
        // Fixed oracle: move the cut from frame 120 to 150, preserving source handles and the 240-frame span.
        inner.items = inner.items.map((item) => ['left-v', 'left-a'].includes(item.id)
          ? { ...item, durationInFrames: 150, sourceEnd: 150 }
          : { ...item, from: 150, durationInFrames: 90, sourceStart: 60 })
      }
      const history = useTimelineCommandStore.getState()
      const undoBefore = [...history.undoStack]
      const redoBefore = [...history.redoStack]
      rollingTrimItems('left-v', 'right-v', 30)
      // Full persisted graph equality also protects the main timeline, parent wrapper, markers and tracks.
      expect(buildTimelineFromStores()).toEqual(expected)
      if (locked) {
        expect(useTimelineCommandStore.getState().undoStack).toEqual(undoBefore)
        expect(useTimelineCommandStore.getState().redoStack).toEqual(redoBefore)
      } else {
        expect(useTimelineCommandStore.getState().undoStack).toHaveLength(undoBefore.length + 1)
        useTimelineCommandStore.getState().undo()
        expect(buildTimelineFromStores()).toEqual(before)
        useTimelineCommandStore.getState().redo()
        expect(buildTimelineFromStores()).toEqual(expected)
      }
      await saveTimeline(initial.id)
      const saved = (await getProject(initial.id))!
      const reopenedId = `${initial.id}-reopened`
      workspace.putFile(['projects', reopenedId, 'project.json'], JSON.stringify({ ...saved, id: reopenedId }))
      useCompositionNavigationStore.getState().resetToRoot()
      useItemsStore.getState().setItems([])
      useItemsStore.getState().setTracks([])
      useCompositionsStore.getState().setCompositions([])
      await loadTimeline(reopenedId)
      // Persistence rebuilds redundant track.items from authoritative composition.items.
      // Compare every stored field except that cache and JSON-omitted undefined keys.
      const documentGraph = (timeline: ProjectTimeline) => JSON.parse(JSON.stringify({
        ...timeline,
        tracks: timeline.tracks.map(({ items: _items, ...metadata }) => metadata),
        compositions: timeline.compositions?.map((composition) => ({
          ...composition,
          tracks: composition.tracks.map(({ items: _items, ...metadata }) => metadata),
        })),
      }))
      expect(documentGraph(buildTimelineFromStores())).toEqual(documentGraph(expected))
      useCompositionNavigationStore.getState().switchToSequence('seq-b')
      useCompositionNavigationStore.getState().enterComposition('inner', 'Inner sequence', 'inner-wrapper')
      expect(useItemsStore.getState().items).toEqual(expected.compositions!.find(({ id }) => id === 'inner')!.items)
    } finally {
      useEditorStore.setState({ linkedSelectionEnabled: previousLinked })
    }
  })

})
