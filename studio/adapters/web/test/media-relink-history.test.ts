import { describe, expect, it } from 'vite-plus/test'
import {
  buildTimelineFromStores,
  hydrateTimelineStoresFromProject,
} from '@/features/timeline/stores/timeline-persistence'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useCompositionsStore } from '@/features/timeline/stores/compositions-store'
import { useCompositionNavigationStore } from '@/features/timeline/stores/composition-navigation-store'
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store'
import type { TimelineItem } from '@/types/timeline'
import type { Project } from '@/types/project'
import { publishRelinkSources } from '../src/media-file-relink'

const reader = (id: string, mediaId: string) =>
  ({
    id,
    type: 'audio',
    trackId: 'a',
    mediaId,
    from: 15,
    durationInFrames: 30,
    sourceStart: 10,
    sourceEnd: 40,
    linkedGroupId: 'linked',
    audioSrc: mediaId === 'A' ? 'blob:audio-A' : undefined,
  }) as TimelineItem
const holder = (items: TimelineItem[]) => ({
  items,
  tracks: [
    {
      id: 'a',
      name: 'Audio',
      kind: 'audio',
      height: 60,
      locked: false,
      visible: true,
      muted: false,
      solo: false,
      order: 0,
    },
  ],
  transitions: [],
  keyframes: [],
})
const graph = (mediaId: string) =>
  ({
    timeline: {
      ...holder([reader('main', mediaId)]),
      compositions: [
        { id: 'sequence', ...holder([reader('active', mediaId)]) },
        { id: 'nested', ...holder([reader('nested', mediaId)]) },
      ],
    },
  }) as unknown as Project

describe('source publication inside a sequence', () => {
  it('retains history and synchronizes active, Main, nested and stash readers through undo/redo', () => {
    const before = graph('A')
    const after = graph('B')
    useItemsStore.getState().setItems([reader('active', 'A')])
    useCompositionsStore.setState({ compositions: before.timeline!.compositions as never })
    useCompositionNavigationStore.setState({
      activeCompositionId: 'sequence',
      mainHolder: holder([reader('main', 'A')]) as never,
      stashStack: [{ compositionId: 'parent', ...holder([reader('nested', 'A')]) }] as never,
    })
    useTimelineCommandStore.getState().clearHistory()
    useTimelineCommandStore.getState().execute({ type: 'PRIOR_LOCAL_EDIT' }, () => {
      useItemsStore.setState({
        items: [reader('active', 'A'), { ...reader('local', 'unrelated'), from: 99 }],
      })
    })
    const prior = useTimelineCommandStore.getState().undoStack[0]
    const assertReaders = (mediaId: string) => {
      expect(useItemsStore.getState().items.find((item) => item.id === 'active')).toMatchObject({
        mediaId,
        from: 15,
        sourceStart: 10,
        sourceEnd: 40,
        linkedGroupId: 'linked',
        audioSrc: mediaId === 'A' ? 'blob:audio-A' : undefined,
      })
      expect(useItemsStore.getState().items.find((item) => item.id === 'local')).toMatchObject({
        mediaId: 'unrelated',
        from: 99,
      })
      expect(useCompositionNavigationStore.getState().mainHolder!.items[0]).toMatchObject({
        mediaId,
        audioSrc: mediaId === 'A' ? 'blob:audio-A' : undefined,
      })
      expect(useCompositionNavigationStore.getState().stashStack[0]!.items[0]!.mediaId).toBe(
        mediaId,
      )
      expect(
        useCompositionsStore.getState().compositions.find((item) => item.id === 'nested')!.items[0]!
          .mediaId,
      ).toBe(mediaId)
    }
    publishRelinkSources(before, after)
    assertReaders('B')
    expect(useTimelineCommandStore.getState().undoStack[0]).toBe(prior)
    expect(useTimelineCommandStore.getState().undoStack).toHaveLength(2)
    useTimelineCommandStore.getState().undo()
    assertReaders('A')
    useTimelineCommandStore.getState().redo()
    assertReaders('B')
  })
  it('navigates Main/nested and reopens the saved binding after sequence undo/redo', async () => {
    const before = graph('A')
    useCompositionNavigationStore.setState({
      activeCompositionId: null,
      breadcrumbs: [{ compositionId: null, label: 'Main' }],
      mainHolder: null,
      stashStack: [],
    })
    useItemsStore.setState({ items: before.timeline!.items, tracks: before.timeline!.tracks })
    useCompositionsStore.setState({ compositions: before.timeline!.compositions as never })
    useTimelineCommandStore.getState().clearHistory()
    const nav = () => useCompositionNavigationStore.getState()
    nav().switchToSequence('sequence')
    publishRelinkSources(before, graph('B'))
    nav().switchToSequence(null)
    expect(useItemsStore.getState().items[0]!.mediaId).toBe('B')
    nav().switchToSequence('sequence')
    useTimelineCommandStore.getState().undo()
    expect(useItemsStore.getState().items[0]!.mediaId).toBe('A')
    nav().switchToSequence(null)
    expect(useItemsStore.getState().items[0]!.mediaId).toBe('A')
    nav().switchToSequence('sequence')
    useTimelineCommandStore.getState().redo()
    expect(useItemsStore.getState().items[0]!.mediaId).toBe('B')
    nav().enterComposition('nested', 'Nested')
    expect(useItemsStore.getState().items[0]!.mediaId).toBe('B')
    nav().resetToRoot()
    expect(useItemsStore.getState().items[0]!.mediaId).toBe('B')
    const saved = {
      ...graph('B'),
      metadata: { fps: 30, width: 1920, height: 1080 },
      timeline: buildTimelineFromStores(),
    } as Project
    await hydrateTimelineStoresFromProject(saved)
    expect(buildTimelineFromStores().items[0]!.mediaId).toBe('B')
    expect(
      buildTimelineFromStores()
        .compositions!.flatMap((item) => item.items)
        .every((item) => item.mediaId === 'B'),
    ).toBe(true)
  })
})
