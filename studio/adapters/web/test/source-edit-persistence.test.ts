import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Project } from '@/types/project';
import type { MediaMetadata } from '@/types/storage';
import type { TimelineItem } from '@/types/timeline';
import { createProject, getProject } from '@/infrastructure/storage';
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root';
import { loadTimeline, saveTimeline } from '@/features/timeline/stores/timeline-persistence';
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
