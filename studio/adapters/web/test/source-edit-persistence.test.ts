import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Project, ProjectTimeline } from '@/types/project';
import type { MediaMetadata } from '@/types/storage';
import type { TimelineItem } from '@/types/timeline';
import { createProject, getProject } from '@/infrastructure/storage';
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root';
import { buildTimelineFromStores, loadTimeline, saveTimeline } from '@/features/timeline/stores/timeline-persistence';
import { VirtualWorkspace } from '../src/virtual-workspace';
import { applyCanonicalCommands, canonicalJson } from '../src/canonical-commands';
import {
  createStudioEngineCommandHandlers,
  createStudioGraphHistory,
} from '@frameleaf/host/engine-commands';
import { createStudioCommandEnvelope, type StudioCommandId } from '@frameleaf/host/commands';

import { useEditorStore } from '@/shared/state/editor';
import { useSourcePlayerStore } from '@/shared/state/source-player';
import { usePlaybackStore } from '@/shared/state/playback';
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store';
import {
  performInsertEdit,
  performOverwriteEdit,
} from '@/features/timeline/stores/actions/source-edit-actions';

import { useItemsStore } from '@/features/timeline/stores/items-store';
import { useCompositionsStore, type SubComposition } from '@/features/timeline/stores/compositions-store';
import { useCompositionNavigationStore } from '@/features/timeline/stores/composition-navigation-store';
import { useSequencesStore } from '@/features/timeline/stores/sequences-store';
import { useSelectionStore } from '@/shared/state/selection';
import { useMarkersStore } from '@/features/timeline/stores/markers-store';
import { useTransitionsStore } from '@/features/timeline/stores/transitions-store';
import { useKeyframesStore } from '@/features/timeline/stores/keyframes-store';
import { useTimelineSettingsStore } from '@/features/timeline/stores/timeline-settings-store';
import { useZoomStore, useSettledZoomStore } from '@/features/timeline/stores/zoom-store';

import { useMediaLibraryStore } from '@/features/timeline/deps/media-library-store';
vi.mock('@/features/timeline/deps/projects', () => ({
  useProjectStore: {
    getState: () => ({
      currentProject: {
        id: 'source-edit-persistence',
        metadata: { width: 1920, height: 1080, fps: 30 },
      },
    }),
  },
}));
vi.mock('@/features/timeline/deps/media-library-service', () => ({
  importMediaLibraryService: async () => ({
    mediaLibraryService: {
      getThumbnailBlobUrl: async () => null,
      getMediaForProject: async () => media,
      getMedia: async () => media[0],
    },
  }),
}));
vi.mock('@/features/timeline/deps/media-library-resolver', () => ({
  getMediaType: () => 'video',
  resolveMediaUrl: async () => 'blob:local-source-fixture',
}));

vi.mock('@/infrastructure/storage/handles-db', () => ({
  getHandle: vi.fn(async () => undefined),
  saveHandle: vi.fn(async () => undefined),
  deleteHandle: vi.fn(async () => undefined),
}));
// Same real storage surface as command-matrix; jsdom's Blob lacks these browser methods.
if (!Blob.prototype.arrayBuffer)
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
if (!Blob.prototype.text)
  Blob.prototype.text = async function () {
    return new TextDecoder().decode(await this.arrayBuffer());
  };

const media = [
  {
    id: 'linked-media',
    storageType: 'workspace',
    fileName: 'linked.mp4',
    mimeType: 'video/mp4',
    duration: 8,
    fps: 30,
    width: 1920,
    height: 1080,
    audioCodec: 'aac',
    codec: 'h264',
    fileSize: 1,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  },
] as MediaMetadata[];
const fresh = () =>
  ({
    id: 'source-edit-persistence',
    name: 'Source edit',
    createdAt: 0,
    updatedAt: 0,
    duration: 0,
    schemaVersion: 15,
    metadata: { width: 1920, height: 1080, fps: 30 },
    timeline: {
      tracks: ['video', 'audio'].map((kind, order) => ({
        id: kind,
        name: kind,
        kind,
        order,
        height: 60,
        locked: false,
        visible: true,
        muted: false,
      })),
      items: [],
      transitions: [],
      keyframes: [],
      currentFrame: 0,
      zoomLevel: 1,
      scrollPosition: 0,
    },
  }) as unknown as Project;
const ranges = (project: Project) => {
  const items = project.timeline!.items as TimelineItem[];
  return ['video', 'audio'].map((track) =>
    items
      .filter((item) => item.trackId === track)
      .sort((a, b) => a.from - b.from)
      .map((item) => ({
        from: item.from,
        duration: item.durationInFrames,
        start: item.sourceStart,
        end: item.sourceEnd,
        group: item.linkedGroupId,
      })),
  );
};

describe('FL94 source edits through host history and real engine persistence', () => {
  beforeEach(() => useMediaLibraryStore.setState({ mediaById: { 'linked-media': media[0]! } }));
  afterEach(() => setWorkspaceRoot(null));
  it.each(['clip.insert', 'clip.overwrite'] as const)(
    '%s preserves independent linked ranges on save/reopen',
    async (id) => {
      const workspace = new VirtualWorkspace();
      setWorkspaceRoot(workspace.handle());
      let graph: unknown = fresh();
      const history = createStudioGraphHistory();
      const handlers = createStudioEngineCommandHandlers({
        graph: () => graph,
        revision: () => 3,
        assets: () => [],
        restore: async () => false,
        history,
        stage: (next) => {
          graph = next;
        },
        engine: async () => ({
          dispose() {},
          async apply(current, envelopes) {
            const outcome = await applyCanonicalCommands(current, envelopes, media);
            return outcome.status === 'applied'
              ? { status: 'applied', graph: outcome.project, digest: outcome.digest }
              : outcome;
          },
        }),
      });
      const run = (command: StudioCommandId, payload: Record<string, unknown>) =>
        handlers[command]!(createStudioCommandEnvelope(command as never, payload as never, 3));
      try {
        await run('clip.add', {
          trackId: 'video',
          assetId: 'linked-media',
          at: { num: 0, den: 1 },
        });
        const before = canonicalJson(graph);
        await run(id, {
          trackId: 'video',
          assetId: 'linked-media',
          at: { num: 2, den: 1 },
          sourceIn: { num: 5, den: 1 },
          sourceOut: { num: 6, den: 1 },
        });
        const after = canonicalJson(graph);
        const expected = ranges(graph as Project);
        expect(expected[0]).toEqual(expected[1]);
        expect(new Set(expected[0]!.map((item) => item.group)).size).toBe(3);
        expect(
          expected[0]!.map(({ from, duration, start, end }) => [from, duration, start, end]),
        ).toEqual(
          id === 'clip.insert'
            ? [
                [0, 60, 0, 60],
                [60, 30, 150, 180],
                [90, 180, 60, 240],
              ]
            : [
                [0, 60, 0, 60],
                [60, 30, 150, 180],
                [90, 150, 90, 240],
              ],
        );
        await run('history.undo', {});
        expect(canonicalJson(graph)).toBe(before);
        await run('history.redo', {});
        expect(canonicalJson(graph)).toBe(after);
        await createProject(graph as Project);
        await loadTimeline('source-edit-persistence');
        await saveTimeline('source-edit-persistence');
        expect(ranges((await getProject('source-edit-persistence'))!)).toEqual(expected);
        await loadTimeline('source-edit-persistence');
        await saveTimeline('source-edit-persistence');
        const reopened = (await getProject('source-edit-persistence'))!;
        expect(ranges(reopened)).toEqual(expected);
        const head = (reopened.timeline!.items as TimelineItem[]).find(
          (item) => item.trackId === 'video' && item.from === 0,
        )!;
        const deleted = await applyCanonicalCommands(
          reopened,
          [
            {
              id: 'clip.delete',
              payload: { clipId: head.id },
              revision: 3,
              issuedAt: 1,
              idempotencyKey: 'delete-persisted-head',
            },
          ],
          media,
        );
        expect(deleted.status).toBe('applied');
        if (deleted.status === 'applied')
          expect(ranges(deleted.project)[0]).toEqual(expected[0]!.slice(1));
      } finally {
        workspace.dispose();
      }
    },
  );
  it.each([performInsertEdit, performOverwriteEdit])(
    'persists native source-monitor partitions through real save/reopen',
    async (edit) => {
      const workspace = new VirtualWorkspace();
      setWorkspaceRoot(workspace.handle());
      try {
        const initial = await applyCanonicalCommands(
          fresh(),
          [
            {
              id: 'clip.add',
              payload: { trackId: 'video', assetId: 'linked-media', at: { num: 0, den: 1 } },
              revision: 3,
              idempotencyKey: 'native-initial',
              issuedAt: 1,
            },
          ],
          media,
        );
        expect(initial.status).toBe('applied');
        if (initial.status !== 'applied') throw new Error('Native fixture did not initialize');
        await createProject(initial.project);
        await loadTimeline('source-edit-persistence');
        useEditorStore.setState({
          sourcePreviewMediaId: 'linked-media',
          sourcePatchVideoEnabled: true,
          sourcePatchAudioEnabled: true,
          sourcePatchVideoTrackId: 'video',
          sourcePatchAudioTrackId: 'audio',
        });
        useSourcePlayerStore.setState({ inPoint: 150, outPoint: 180 });
        usePlaybackStore.setState({ currentFrame: 60 });
        useTimelineCommandStore.getState().clearHistory();
        await edit();
        await saveTimeline('source-edit-persistence');
        const edited = (await getProject('source-edit-persistence'))!;
        const expected = ranges(edited);
        expect(expected[0]).toEqual(expected[1]);
        expect(new Set(expected[0]!.map((item) => item.group)).size).toBe(3);
        expect(
          expected[0]!.map(({ from, duration, start, end }) => [from, duration, start, end]),
        ).toEqual(
          edit === performInsertEdit
            ? [
                [0, 60, 0, 60],
                [60, 30, 150, 180],
                [90, 180, 60, 240],
              ]
            : [
                [0, 60, 0, 60],
                [60, 30, 150, 180],
                [90, 150, 90, 240],
              ],
        );
        useTimelineCommandStore.getState().undo();
        await saveTimeline('source-edit-persistence');
        expect(ranges((await getProject('source-edit-persistence'))!)).toEqual(
          ranges(initial.project),
        );
        useTimelineCommandStore.getState().redo();
        await saveTimeline('source-edit-persistence');
        expect(ranges((await getProject('source-edit-persistence'))!)).toEqual(expected);
        await loadTimeline('source-edit-persistence');
        await saveTimeline('source-edit-persistence');
        expect(ranges((await getProject('source-edit-persistence'))!)).toEqual(expected);
      } finally {
        workspace.dispose();
      }
    },
  );

  it.each([
    { locked: false, failAfterAssertions: false },
    { locked: true, failAfterAssertions: false },
    { locked: false, failAfterAssertions: true },
  ])(
    'native marked insert preserves nested ownership/history/reload (audio locked: $locked, cleanup failure: $failAfterAssertions)',
    async ({ locked, failAfterAssertions }) => {
      const workspace = new VirtualWorkspace();
      const original = {
        markers: useMarkersStore.getState(), transitions: useTransitionsStore.getState(),
        keyframes: useKeyframesStore.getState(), settings: useTimelineSettingsStore.getState(),
        zoom: useZoomStore.getState(), settledZoom: useSettledZoomStore.getState(),
      };
      // Distinct preexisting state makes incomplete cleanup observable on success and failure.
      useMarkersStore.setState({ markers: [{ id: 'prior-marker', frame: 7, color: '#123456' }], inPoint: 3, outPoint: 17 });
      useTransitionsStore.getState().setTransitions([{
        id: 'prior-transition', type: 'crossfade', presentation: 'fade', timing: 'linear',
        leftClipId: 'prior-left', rightClipId: 'prior-right', trackId: 'prior-video', durationInFrames: 9,
      }]);
      useKeyframesStore.getState().setKeyframes([{ itemId: 'prior-left', properties: [] }]);
      useTimelineSettingsStore.setState({ fps: 24, scrollPosition: 137, snapEnabled: false, isDirty: true, isTimelineLoading: true });
      useZoomStore.getState().setZoomLevelSynchronized(2.5);
      const deliberateFailure = new Error('intentional nested fixture cleanup control');
      const previous = {
        editor: useEditorStore.getState(), source: useSourcePlayerStore.getState(),
        playback: usePlaybackStore.getState(), selection: useSelectionStore.getState(),
        items: useItemsStore.getState(), compositions: useCompositionsStore.getState(),
        navigation: useCompositionNavigationStore.getState(), sequences: useSequencesStore.getState(),
        history: useTimelineCommandStore.getState(), media: useMediaLibraryStore.getState(),
        markers: useMarkersStore.getState(), transitions: useTransitionsStore.getState(),
        keyframes: useKeyframesStore.getState(), settings: useTimelineSettingsStore.getState(),
        zoom: useZoomStore.getState(), settledZoom: useSettledZoomStore.getState(),
      };
      const runFixture = async () => {
        setWorkspaceRoot(workspace.handle());
        try {
          const initial = fresh();
          initial.id = `nested-source-insert-${locked}`;
          const tracks = fresh().timeline!.tracks;
          const sentinel = (id: string, trackId: string) => ({
            id, trackId, type: 'text', from: 0, durationInFrames: 30,
            text: id, label: id, color: '#ffffff',
          }) as TimelineItem;
          const wrapper = (id: string, compositionId: string, trackId: string) => ({
            id, compositionId, trackId, type: 'composition', from: 60,
            durationInFrames: 240, sourceStart: 0, sourceEnd: 240, sourceFps: 30,
            compositionWidth: 1920, compositionHeight: 1080, label: id,
          }) as TimelineItem;
          const inner = {
            id: 'inner', name: 'Inner', editorKind: 'sequence', fps: 30,
            width: 1920, height: 1080, durationInFrames: 240,
            tracks: tracks.map((track) => ({
              ...track, id: `inner-${track.id}`, solo: false,
              locked: track.kind === 'audio' && locked,
              ...(track.kind === 'audio' ? { syncLock: false } : {}),
            })),
            items: ['video', 'audio'].map((kind) => ({
              id: `original-${kind}`, trackId: `inner-${kind}`, type: kind,
              from: 0, durationInFrames: 240, sourceStart: 0, sourceEnd: 240,
              sourceDuration: 240, sourceFps: 30, mediaId: 'linked-media',
              src: '', label: 'linked.mp4', linkedGroupId: 'original-pair',
            })),
            transitions: [], keyframes: [],
            markers: [{ id: 'inner-marker', frame: 210, color: '#ffffff' }],
          } as SubComposition;
          initial.timeline!.items = [sentinel('main-sentinel', 'video'), wrapper('outer-wrapper', 'seq-b', 'video')];
          initial.timeline!.markers = [{ id: 'main-marker', frame: 20, color: '#ffffff' }];
          initial.timeline!.topLevelSequenceIds = ['seq-b'];
          initial.timeline!.compositions = [
            {
              ...structuredClone(inner), id: 'seq-b', name: 'Sequence B', durationInFrames: 300,
              tracks: structuredClone(tracks),
              items: [sentinel('parent-sentinel', 'video'), wrapper('inner-wrapper', 'inner', 'video')],
              markers: [{ id: 'parent-marker', frame: 30, color: '#ffffff' }],
            },
            inner,
            {
              ...structuredClone(inner), id: 'sibling', name: 'Sibling', durationInFrames: 30,
              tracks: structuredClone(tracks), items: [sentinel('sibling-sentinel', 'video')],
            },
          ];
          await createProject(initial);
          await loadTimeline(initial.id);
          // Hydration uses throttled visual zoom; settle it before recording graph oracles.
          useZoomStore.getState().setZoomLevelSynchronized(initial.timeline!.zoomLevel ?? 1);
          useTimelineCommandStore.getState().clearHistory();
          useCompositionNavigationStore.getState().switchToSequence('seq-b');
          useCompositionNavigationStore.getState().enterComposition('inner', 'Inner', 'inner-wrapper');
          expect(useCompositionNavigationStore.getState().breadcrumbs.map(({ compositionId }) => compositionId))
            .toEqual(['seq-b', 'inner']);
          expect(useTimelineCommandStore.getState().activeContextKey).toBe('inner');
          useEditorStore.setState({
            linkedSelectionEnabled: true, sourcePreviewMediaId: 'linked-media',
            sourcePatchVideoEnabled: true, sourcePatchAudioEnabled: true,
            sourcePatchVideoTrackId: 'inner-video', sourcePatchAudioTrackId: 'inner-audio',
          });
          useSourcePlayerStore.setState({ inPoint: 150, outPoint: 180 });
          usePlaybackStore.setState({ currentFrame: 60 });
          useSelectionStore.getState().selectItems(['original-video']);
          const selectionBefore = useSelectionStore.getState();
          const before = structuredClone(buildTimelineFromStores());
          const historyBefore = useTimelineCommandStore.getState();
          const parkedBefore = structuredClone(historyBefore.stacksByContext);
          await performInsertEdit();
          const edited = structuredClone(buildTimelineFromStores());
          expect(useTimelineCommandStore.getState().activeContextKey).toBe('inner');
          expect(useTimelineCommandStore.getState().stacksByContext).toEqual(parkedBefore);
          if (locked) {
            // A resolver fallback must not publish a track or partially split the original linked pair.
            expect(edited).toEqual(before);
            expect(useSelectionStore.getState()).toEqual(selectionBefore);
            expect(useTimelineCommandStore.getState().undoStack).toEqual(historyBefore.undoStack);
            expect(useTimelineCommandStore.getState().redoStack).toEqual(historyBefore.redoStack);
          } else {
            const child = edited.compositions!.find(({ id }) => id === 'inner')!;
            const paired = ['inner-video', 'inner-audio'].map((trackId) => child.items
              .filter((item) => item.trackId === trackId).sort((a, b) => a.from - b.from));
            // Hand-derived oracle, independent of the production partition/insert calculations.
            for (const items of paired) {
              expect(items.map((item) => [item.from, item.durationInFrames, item.sourceStart, item.sourceEnd]))
                .toEqual([[0, 60, 0, 60], [60, 30, 150, 180], [90, 180, 60, 240]]);
              expect(items.every((item) => item.mediaId === 'linked-media' && item.sourceFps === 30 && item.sourceDuration === 240)).toBe(true);
            }
            expect(child.items).toHaveLength(6);
            expect(paired[0]!.map((item) => item.linkedGroupId)).toEqual(paired[1]!.map((item) => item.linkedGroupId));
            expect(new Set(paired[0]!.map((item) => item.linkedGroupId)).size).toBe(3);
            expect(paired[0]!.every((item) => Boolean(item.linkedGroupId))).toBe(true);
            expect(child.durationInFrames).toBe(270);
            const outer = (timeline: ProjectTimeline) => ({
              ...timeline, compositions: timeline.compositions!.filter(({ id }) => id !== 'inner'),
            });
            expect(outer(edited)).toEqual(outer(before));
            const childBefore = before.compositions!.find(({ id }) => id === 'inner')!;
            expect({ ...child, items: [], durationInFrames: 0 }).toEqual({ ...childBefore, items: [], durationInFrames: 0 });
            expect(useTimelineCommandStore.getState().undoStack).toHaveLength(historyBefore.undoStack.length + 1);
            useTimelineCommandStore.getState().undo();
            expect(buildTimelineFromStores()).toEqual(before);
            useTimelineCommandStore.getState().redo();
            expect(buildTimelineFromStores()).toEqual(edited);
          }
          // Save the live inner context, then discard every loaded domain store before reopening.
          await saveTimeline(initial.id);
          expect(useCompositionNavigationStore.getState().activeCompositionId).toBe('inner');
          const saved = (await getProject(initial.id))!;
          const documentGraph = (timeline: ProjectTimeline) => JSON.parse(JSON.stringify({
            ...timeline,
            tracks: timeline.tracks.map(({ items: _items, ...metadata }) => metadata),
            compositions: timeline.compositions?.map((composition) => ({
              ...composition, tracks: composition.tracks.map(({ items: _items, ...metadata }) => metadata),
            })),
          }));
          expect(documentGraph(saved.timeline!)).toEqual(documentGraph(edited));
          const reopenedId = `${initial.id}-reopened`;
          workspace.putFile(['projects', reopenedId, 'project.json'], JSON.stringify({ ...saved, id: reopenedId }));
          useCompositionNavigationStore.getState().resetToRoot();
          useItemsStore.getState().setItems([]);
          useItemsStore.getState().setTracks([]);
          useCompositionsStore.getState().setCompositions([]);
          await loadTimeline(reopenedId);
          expect(documentGraph(buildTimelineFromStores())).toEqual(documentGraph(edited));
          useCompositionNavigationStore.getState().switchToSequence('seq-b');
          useCompositionNavigationStore.getState().enterComposition('inner', 'Inner', 'inner-wrapper');
          expect(useCompositionNavigationStore.getState().breadcrumbs.map(({ compositionId }) => compositionId)).toEqual(['seq-b', 'inner']);
          expect(useItemsStore.getState().items).toEqual(edited.compositions!.find(({ id }) => id === 'inner')!.items);
          expect(documentGraph(buildTimelineFromStores())).toEqual(documentGraph(edited));
          if (failAfterAssertions) throw deliberateFailure;
        } finally {
          useCompositionNavigationStore.getState().resetToRoot();
          useItemsStore.setState(previous.items);
          useCompositionsStore.setState(previous.compositions);
          useSequencesStore.setState(previous.sequences);
          useCompositionNavigationStore.setState(previous.navigation);
          useTimelineCommandStore.setState(previous.history);
          useEditorStore.setState(previous.editor);
          useSourcePlayerStore.setState(previous.source);
          usePlaybackStore.setState(previous.playback);
          useSelectionStore.setState(previous.selection);
          useMarkersStore.setState(previous.markers);
          useTransitionsStore.setState(previous.transitions);
          useKeyframesStore.setState(previous.keyframes);
          useTimelineSettingsStore.setState(previous.settings);
          // Cancel hydration/navigation's delayed zoom work before restoring both zoom channels.
          useZoomStore.getState().setZoomLevelSynchronized(previous.zoom.level);
          useZoomStore.setState(previous.zoom);
          useSettledZoomStore.setState(previous.settledZoom);
          useMediaLibraryStore.setState(previous.media);
          setWorkspaceRoot(null);
          workspace.dispose();
        }
      };
      try {
        if (failAfterAssertions) await expect(runFixture()).rejects.toBe(deliberateFailure);
        else await runFixture();
        expect(useMarkersStore.getState()).toEqual(previous.markers);
        expect(useTransitionsStore.getState()).toEqual(previous.transitions);
        expect(useKeyframesStore.getState()).toEqual(previous.keyframes);
        expect(useTimelineSettingsStore.getState()).toEqual(previous.settings);
        expect(useZoomStore.getState()).toEqual(previous.zoom);
        expect(useSettledZoomStore.getState()).toEqual(previous.settledZoom);
        expect(useMediaLibraryStore.getState()).toEqual(previous.media);
      } finally {
        // The control itself must not leak its sentinel state, even when cleanup is broken.
        useMarkersStore.setState(original.markers);
        useTransitionsStore.setState(original.transitions);
        useKeyframesStore.setState(original.keyframes);
        useTimelineSettingsStore.setState(original.settings);
        useZoomStore.getState().setZoomLevelSynchronized(original.zoom.level);
        useZoomStore.setState(original.zoom);
        useSettledZoomStore.setState(original.settledZoom);
      }
    },
  );

});

describe('FL103 track curve host history and native persistence',()=>{
 afterEach(()=>setWorkspaceRoot(null))
 it('saves/reopens owning track curve and restores exact graph with actual undo/redo',async()=>{
  setWorkspaceRoot(new VirtualWorkspace().handle())
  let graph:unknown=fresh();const history=createStudioGraphHistory()
  const handlers=createStudioEngineCommandHandlers({graph:()=>graph,revision:()=>3,assets:()=>[],restore:async()=>false,history,stage:next=>{graph=next},engine:async()=>({dispose(){},async apply(current,envelopes){const o=await applyCanonicalCommands(current,envelopes,media);return o.status==='applied'?{status:'applied',graph:o.project,digest:o.digest}:o}})})
  const run=(id:StudioCommandId,payload:Record<string,unknown>)=>handlers[id]!(createStudioCommandEnvelope(id as never,payload as never,3))
  const before=canonicalJson(graph)
  await run('track.setAudio',{trackId:'audio',gainDb:-3,gainEnvelope:[{id:'start',at:{num:0,den:1},gainDb:-20},{id:'end',at:{num:1,den:1},gainDb:0}]})
  const after=canonicalJson(graph);expect(after).not.toBe(before)
  await run('history.undo',{});expect(canonicalJson(graph)).toBe(before)
  await run('history.redo',{});expect(canonicalJson(graph)).toBe(after)
  await createProject(graph as Project);await loadTimeline('source-edit-persistence');await saveTimeline('source-edit-persistence')
  const saved=await getProject('source-edit-persistence');const expected=[{id:'start',frame:0,gainDb:-20},{id:'end',frame:30,gainDb:0}]
  expect((saved!.timeline!.tracks.find(t=>t.id==='audio') as unknown as {gainEnvelope:unknown}).gainEnvelope).toEqual(expected)
  await loadTimeline('source-edit-persistence');await saveTimeline('source-edit-persistence');expect((await getProject('source-edit-persistence'))!.timeline!.tracks).toEqual(saved!.timeline!.tracks)
 })
})

it('0092 actual entered child SET_TRACKS history and save/reset/reload/reenter preserve owning curve and untouched root/sibling',async()=>{
 const {useItemsStore}=await import('@/features/timeline/stores/items-store');
 const {useCompositionsStore}=await import('@/features/timeline/stores/compositions-store');
 const {useCompositionNavigationStore}=await import('@/features/timeline/stores/composition-navigation-store');
 const {setTracks}=await import('@/features/timeline/stores/actions/track-actions');
 const workspace=new VirtualWorkspace();setWorkspaceRoot(workspace.handle());
 try{
  const project=fresh();
  const child={id:'curve-child',name:'Child',fps:24,width:1920,height:1080,durationInFrames:60,transitions:[],keyframes:[],tracks:[{id:'child-a',name:'A',kind:'audio',height:56,order:0,visible:true,locked:false,muted:false,volume:-3}],items:[{id:'child-leaf',type:'audio',trackId:'child-a',from:12,durationInFrames:48,sourceStart:0,sourceEnd:48,sourceFps:24,src:'blob:local',label:'leaf'}]} as import('@/features/timeline/stores/compositions-store').SubComposition;
  const sibling={...structuredClone(child),id:'sibling',name:'Sibling'};
  project.timeline!.compositions=[child,sibling];
  project.timeline!.items=[{id:'wrapper',type:'composition',trackId:'audio',from:30,durationInFrames:60,compositionId:child.id,sourceStart:12,sourceEnd:60,sourceFps:24,isReversed:true,label:'Child',compositionWidth:1920,compositionHeight:1080} as TimelineItem];
  await createProject(project);await loadTimeline(project.id);await saveTimeline(project.id);
  const before=(await getProject(project.id))!.timeline!;
  useTimelineCommandStore.getState().clearHistory();
  useCompositionNavigationStore.getState().enterComposition(child.id,'Child','wrapper');
  const points=[{id:'owned-a',frame:12,gainDb:-20},{id:'owned-b',frame:60,gainDb:0}];
  setTracks(useItemsStore.getState().tracks.map(t=>({...t,gainEnvelope:points})));
  expect(useCompositionNavigationStore.getState().activeCompositionId).toBe(child.id);
  expect(useItemsStore.getState().tracks[0]!.gainEnvelope).toEqual(points);
  useTimelineCommandStore.getState().undo();expect(useItemsStore.getState().tracks[0]!.gainEnvelope).toBeUndefined();
  useTimelineCommandStore.getState().redo();expect(useItemsStore.getState().tracks[0]!.gainEnvelope).toEqual(points);
  await saveTimeline(project.id);
  expect(useCompositionNavigationStore.getState().activeCompositionId).toBe(child.id);
  const saved=(await getProject(project.id))!.timeline!;
  expect(saved.items).toEqual(before.items);expect(saved.tracks).toEqual(before.tracks);
  expect(saved.compositions!.find(c=>c.id==='sibling')).toEqual(before.compositions!.find(c=>c.id==='sibling'));
  expect(saved.compositions!.find(c=>c.id===child.id)!.tracks[0]!.gainEnvelope).toEqual(points);
  useCompositionNavigationStore.getState().resetToRoot();useItemsStore.getState().setItems([]);useItemsStore.getState().setTracks([]);useCompositionsStore.getState().setCompositions([]);
  await loadTimeline(project.id);useCompositionNavigationStore.getState().enterComposition(child.id,'Child','wrapper');
  expect(useItemsStore.getState().tracks[0]!.gainEnvelope).toEqual(points);expect(useItemsStore.getState().tracks[0]!.volume).toBe(-3);
  expect(useItemsStore.getState().items.map(i=>[i.id,i.from,i.durationInFrames,i.sourceStart,i.sourceEnd])).toEqual([['child-leaf',12,48,0,48]]);
  useCompositionNavigationStore.getState().exitComposition();expect(useItemsStore.getState().items).toEqual(before.items);
 }finally{useCompositionNavigationStore.getState().resetToRoot();setWorkspaceRoot(null);workspace.dispose()}
});
