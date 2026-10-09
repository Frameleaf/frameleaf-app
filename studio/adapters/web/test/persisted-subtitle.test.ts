import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { Project } from '@/types/project';
import type { SubtitleSegmentItem } from '@/types/timeline';
import {
  makeTimelineTrack,
  resetTimelineCompositionTestState,
} from '@/features/timeline/test-helpers';
import { useItemsStore } from '@/features/timeline/stores/items-store';
import { useCompositionsStore } from '@/features/timeline/stores/compositions-store';
import { useCompositionNavigationStore } from '@/features/timeline/stores/composition-navigation-store';
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store';
import { updateItem } from '@/features/timeline/stores/actions/item-actions';
import {
  buildTimelineFromStores,
  hydrateTimelineStoresFromProject,
} from '@/features/timeline/stores/timeline-persistence';
import {
  applyCanonicalCommands,
  canonicalJson,
} from '../src/canonical-commands';

const segment = (id: string): SubtitleSegmentItem => ({
  id,
  trackId: 'captions',
  from: 30,
  durationInFrames: 60,
  label: 'Saved captions',
  type: 'subtitle',
  sourceLabel: 'captions.srt',
  source: {
    type: 'subtitle-import',
    fileName: 'captions.srt',
    format: 'srt',
    importedAt: 17,
  },
  cues: [
    { id: 'cue-a', startSeconds: 0, endSeconds: 1, text: 'First words' },
    { id: 'cue-b', startSeconds: 1, endSeconds: 2, text: 'Second words' },
  ],
  color: '#ffeeaa',
  fontSize: 32,
});

const savedProject = (): Project => ({
  id: 'subtitle-project',
  name: 'Subtitle round trip',
  description: '',
  createdAt: 1,
  updatedAt: 1,
  duration: 3,
  schemaVersion: 15,
  metadata: { width: 1920, height: 1080, fps: 30 },
  timeline: buildTimelineFromStores(),
});

/** A serializer that drops source/cues or a history restore that loses subtitle style must fail. */
describe('native subtitle project persistence', () => {
  beforeEach(() => resetTimelineCompositionTestState());
  afterEach(() => resetTimelineCompositionTestState());

  it('preserves root and composition subtitle metadata through serialized save and hydrate', async () => {
    const track = makeTimelineTrack({
      id: 'captions',
      name: 'Captions',
      kind: 'video',
      order: 0,
    });
    const root = segment('root-subtitle');
    const child = segment('child-subtitle');
    useItemsStore.getState().setTracks([track]);
    useItemsStore.getState().setItems([root]);
    useCompositionsStore.getState().addComposition({
      id: 'caption-child',
      name: 'Caption child',
      editorKind: 'sequence',
      tracks: [track],
      items: [child],
      transitions: [],
      keyframes: [],
      markers: [],
      inPoint: null,
      outPoint: null,
      fps: 30,
      width: 1920,
      height: 1080,
      durationInFrames: 90,
    });
    const json = JSON.stringify(savedProject());
    const reopened: Project = JSON.parse(json);
    expect(reopened.timeline!.items).toEqual([root]);
    expect(reopened.timeline!.compositions![0]!.items).toEqual([child]);
    resetTimelineCompositionTestState();
    await hydrateTimelineStoresFromProject(reopened);
    expect(useItemsStore.getState().items).toEqual([root]);
    useCompositionNavigationStore.getState().switchToSequence('caption-child');
    expect(useItemsStore.getState().items).toEqual([child]);
    useCompositionNavigationStore.getState().switchToSequence(null);
    expect(useItemsStore.getState().items).toEqual([root]);
  });

  it('retains cue/source/style fields across native undo/redo and canonical atomic refusal', async () => {
    const track = makeTimelineTrack({
      id: 'captions',
      name: 'Captions',
      kind: 'video',
      order: 0,
    });
    const before = segment('history-subtitle');
    useItemsStore.getState().setTracks([track]);
    useItemsStore.getState().setItems([before]);
    updateItem(before.id, { color: '#00ffaa', label: 'Edited captions' });
    const edited = { ...before, color: '#00ffaa', label: 'Edited captions' };
    expect(useItemsStore.getState().items).toEqual([edited]);
    useTimelineCommandStore.getState().undo();
    expect(useItemsStore.getState().items).toEqual([before]);
    useTimelineCommandStore.getState().redo();
    expect(useItemsStore.getState().items).toEqual([edited]);
    const saved: Project = JSON.parse(JSON.stringify(savedProject()));
    const accepted = await applyCanonicalCommands(saved, [], []);
    if (accepted.status !== 'applied') throw new Error(accepted.detail);
    expect(accepted.project.timeline!.items).toEqual([edited]);
    const graphBefore = canonicalJson(accepted.project);
    const rejected = await applyCanonicalCommands(
      accepted.project,
      [
        {
          id: 'marker.add',
          payload: { at: { num: 1, den: 1 } },
          revision: 3,
          idempotencyKey: 'subtitle-marker',
        },
        {
          id: 'track.add',
          payload: { kind: 'foreign' },
          revision: 3,
          idempotencyKey: 'subtitle-refusal',
        },
      ],
      [],
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      index: 1,
      reason: 'invalid',
    });
    expect(canonicalJson(accepted.project)).toBe(graphBefore);
    expect(useItemsStore.getState().items).toEqual([edited]);
    expect(buildTimelineFromStores().markers ?? []).toEqual([]);
  });
});
