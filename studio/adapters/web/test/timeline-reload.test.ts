import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Project, ProjectTimeline } from '@/types/project'
import type { TimelineTrack } from '@/types/timeline'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { createProject, getProject } from '@/infrastructure/storage'
import { CURRENT_SCHEMA_VERSION } from '@/shared/projects/migrations/types'
import { loadTimeline, saveTimeline } from '@/features/timeline/stores/timeline-persistence'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useCompositionsStore } from '@/features/timeline/stores/compositions-store'
import { useSequencesStore } from '@/features/timeline/stores/sequences-store'
import {
  getActiveTabId,
  useCompositionNavigationStore,
} from '@/features/timeline/stores/composition-navigation-store'
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
})
