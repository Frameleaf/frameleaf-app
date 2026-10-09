/** Test-only arrangement and readback around existing native functions/components. */
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { i18n, i18nReady } from '@/i18n';
import { PreviewArea } from '@/features/editor/components/preview-area';
import { mediaLibraryService } from '@/features/media-library/services/media-library-service';
import { buildMediaTimelineItem } from '@/features/timeline/utils/media-timeline-item-builder';
import { resetTimelineCompositionTestState, makeTimelineTrack } from '@/features/timeline/test-helpers';
import { buildTimelineFromStores, loadTimeline, saveTimeline } from '@/features/timeline/stores/timeline-persistence';
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store';
import { usePlaybackStore } from '@/shared/state/playback';
import { useEditorStore } from '@/shared/state/editor';
import { useProjectStore } from '@/features/projects/stores/project-store';
import { createProject, getProject } from '@/infrastructure/storage';
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root';
import { CURRENT_SCHEMA_VERSION } from '@/shared/projects/migrations';
import { LottieExportProvider, mapTimelineFrameToLottieFrame } from '@/infrastructure/lottie/lottie-frame-provider';
import { resolveLottieRenderSpec } from '@/infrastructure/lottie/lottie-text';
import { exportProjectBundle } from '@/features/project-bundle/services/bundle-export-service';
import { importProjectBundle } from '@/features/project-bundle/services/bundle-import-service';
import { unzipSync } from 'fflate';
import { applyCanonicalCommands, canonicalJson } from '../src/canonical-commands';
import type { Project, ProjectTimeline } from '@/types/project';
import type { LottieItem } from '@/types/timeline';
import type { MediaMetadata } from '@/types/storage';
import { edits, samples } from './lottie-owned.fixture.mjs';
import './keyframe-browser.css';
import '../src/editor.css';

await i18nReady;
await i18n.changeLanguage('en');
const settings = { width: 64, height: 64, fps: 30, backgroundColor: '#000000' };
const view = createRoot(document.getElementById('editor')!);
let directoryName = '';
let project: Project;
let media: MediaMetadata;
let baselineTimeline: ProjectTimeline;
let editedTimeline: ProjectTimeline;
let sourceHash = '';
const ownedUrls = new Set<string>();
const check = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
const hash = async (blob: Blob) => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()),
), (value) => value.toString(16).padStart(2, '0')).join('');
const timeline = () => buildTimelineFromStores();
const item = () => timeline().items.find((entry) => entry.type === 'lottie') as LottieItem;
const graph = () => ({ ...project, timeline: timeline() });
const portable = (input: ProjectTimeline, originalMediaId = media.id) => {
  const copy = structuredClone(input);
  copy.items = copy.items.map((entry) => {
    const { src: _src, thumbnailUrl: _thumbnail, ...rest } = entry;
    return { ...rest, ...(entry.mediaId ? { mediaId: originalMediaId } : {}) };
  });
  return canonicalJson(copy);
};
const mount = () => flushSync(() => view.render(
  <PreviewArea project={settings} durationInFrames={60} preferProjectStoreMetadata={false} />,
));
const framesSettled = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
};
const pixels = (source: CanvasImageSource) => {
  const canvas = new OffscreenCanvas(64, 64);
  const context = canvas.getContext('2d')!;
  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0, 64, 64);
  return samples.map(({ name, x, y }) => ({ name,
    rgba: Array.from(context.getImageData(x, y, 1, 1).data) }));
};
const originalBytes = async () => {
  const blob = await mediaLibraryService.getMediaFile(media.id);
  check(blob, 'Original imported media disappeared');
  return hash(blob!);
};
const openStored = async (next: Project) => {
  resetTimelineCompositionTestState();
  project = next;
  useProjectStore.getState().setCurrentProject(project);
  await loadTimeline(project.id);
  useEditorStore.setState({ workspace: 'edit' });
  usePlaybackStore.setState({ currentFrame: 0, isPlaying: false, previewFrame: null });
  mount();
};

const api = {
  async open(name: string, url: string) {
    check(/^fl105-lottie-[a-f0-9-]{36}$/.test(name), 'Owned fixture directory required');
    check(new URL(url).origin === location.origin && new URL(url).pathname === '/__fl105__/owned.json',
      'Exact same-origin owned fixture required');
    directoryName = name;
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
    setWorkspaceRoot(directory);
    project = await createProject({ id: name, name: 'Owned Lottie qualification',
      description: 'Authored geometric glyphs; local qualification only', createdAt: 1, updatedAt: 1,
      duration: 2, schemaVersion: CURRENT_SCHEMA_VERSION, metadata: settings });
    media = await mediaLibraryService.importLottieFromUrl(url, project.id, { fileName: 'FL105 owned geometry' });
    check(media.width === 64 && media.height === 64 && media.fps === 30 && media.duration === 2,
      'Native import metadata differs from authored dimensions/timing');
    const src = await mediaLibraryService.getMediaBlobUrl(media.id);
    check(src, 'Native imported source URL unavailable');
    ownedUrls.add(src!);
    const clip = buildMediaTimelineItem({ media, mediaId: media.id, mediaType: 'lottie',
      label: 'Owned geometric Lottie', projectFps: 30, blobUrl: src!, canvasWidth: 64, canvasHeight: 64,
      placement: { trackId: 'owned-vector', from: 0, durationInFrames: 60 }, originId: 'owned-origin' });
    project.timeline = { tracks: [makeTimelineTrack({ id: 'owned-vector', name: 'Owned vector', kind: 'video', order: 0 })],
      items: [clip], currentFrame: 0, zoomLevel: 1, scrollPosition: 0 };
    const normalized = await applyCanonicalCommands(project, [], [media]);
    check(normalized.status === 'applied', 'Native canonical baseline rejected');
    if (normalized.status !== 'applied') throw new Error(normalized.detail);
    project = normalized.project;
    // Store via the existing project persistence API; load uses its actual media resolver.
    const { updateProject } = await import('@/infrastructure/storage');
    await updateProject(project.id, { timeline: project.timeline });
    await openStored(project);
    baselineTimeline = structuredClone(timeline());
    useTimelineCommandStore.getState().clearHistory();
    sourceHash = await originalBytes();
    return { metadata: { width: media.width, height: media.height, fps: media.fps,
      duration: media.duration, codec: media.codec }, sourceHash, timeline: portable(baselineTimeline) };
  },
  state: () => ({ frame: usePlaybackStore.getState().currentFrame,
    timeline: portable(timeline()), maps: { colorOverrides: item()?.colorOverrides,
      textOverrides: item()?.textOverrides, slotOverrides: item()?.slotOverrides },
    history: { undo: useTimelineCommandStore.getState().undoStack.length,
      redo: useTimelineCommandStore.getState().redoStack.length } }),
  async edit(omit = '') {
    const payload = structuredClone(edits);
    if (omit === 'color') payload.colors = {};
    if (omit === 'text') payload.text = {};
    if (omit === 'scalar') delete (payload.slots as Record<string, unknown>).plateOpacity;
    if (omit === 'vector') delete (payload.slots as Record<string, unknown>).plateScale;
    const before = canonicalJson(graph());
    const input = graph();
    const result = await applyCanonicalCommands(input, [{ id: 'lottie.update',
      payload: { clipId: item().id, ...payload }, revision: 1,
      idempotencyKey: `${directoryName}:edit`, issuedAt: 1 }], [media]);
    check(result.status === 'applied', 'Canonical lottie.update rejected');
    check(canonicalJson(input) === before, 'Canonical command mutated its input graph');
    if (result.status !== 'applied') throw new Error(result.detail);
    project = result.project;
    useProjectStore.getState().setCurrentProject(project);
    editedTimeline = structuredClone(timeline());
    const stripped = structuredClone(editedTimeline);
    for (const entry of stripped.items) {
      delete (entry as LottieItem).colorOverrides;
      delete (entry as LottieItem).textOverrides;
      delete (entry as LottieItem).slotOverrides;
    }
    check(canonicalJson(stripped) === canonicalJson(baselineTimeline), 'Edit changed nonedited full timeline graph');
    check(useTimelineCommandStore.getState().undoStack.length === 1, 'Edit did not record exactly one native history entry');
    useTimelineCommandStore.getState().undo();
    check(canonicalJson(timeline()) === canonicalJson(baselineTimeline), 'Native undo failed full graph restoration');
    check(useTimelineCommandStore.getState().redoStack.length === 1, 'Native undo did not retain redo');
    useTimelineCommandStore.getState().redo();
    check(canonicalJson(timeline()) === canonicalJson(editedTimeline), 'Native redo failed full graph restoration');
    check(await originalBytes() === sourceHash, 'Edits mutated original imported bytes');
  },
  async preview() {
    await framesSettled();
    // Exact production LottiePlayer DOM signature, inside the real PreviewArea.
    // Excludes its scrub/comparison canvases; does not substitute an export canvas.
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('[aria-label="Preview canvas region"] canvas')]
      .filter((canvas) => canvas.style.display === 'block' && !canvas.classList.contains('pointer-events-none'));
    check(canvases.length === 1, 'Exactly one native LottiePlayer canvas required');
    check(canvases[0]!.width > 0 && canvases[0]!.height > 0, 'Native preview canvas has no backing pixels');
    return pixels(canvases[0]!);
  },
  async strict(frame: number) {
    const clip = item();
    const source = await mediaLibraryService.getMediaBlobUrl(clip.mediaId);
    check(source, 'Strict export source unavailable');
    ownedUrls.add(source!);
    const spec = await resolveLottieRenderSpec(source!, clip, { strict: true });
    const provider = new LottieExportProvider(true);
    try {
      await provider.preload(clip.id, source!, 64, 64, spec.data ?? undefined,
        undefined, spec.themeData ?? undefined, spec.slots ?? undefined);
      const mapped = mapTimelineFrameToLottieFrame({ localFrame: frame - clip.from,
        projectFps: 30, speed: clip.speed ?? 1, totalFrames: clip.totalFrames,
        frameRate: clip.frameRate, loop: clip.loop ?? true, reversed: clip.reversed,
        loopMode: clip.loopMode, segmentStart: clip.segmentStart, segmentEnd: clip.segmentEnd });
      const canvas = provider.renderFrame(clip.id, mapped);
      check(canvas, 'Actual strict WASM provider returned no frame');
      return { mapped, pixels: pixels(canvas!) };
    } finally { provider.destroy(); }
  },
  async bundle() {
    check(usePlaybackStore.getState().currentFrame === 0, 'Reset native playhead before bundle capture');
    await saveTimeline(project.id);
    const stored = await getProject(project.id);
    check(stored?.timeline, 'Real saved timeline missing');
    check(portable(stored!.timeline!) === portable(timeline()), 'Persistence changed full timeline graph');
    const exported = await exportProjectBundle(project.id);
    check(exported.blob && exported.mediaCount === 1, 'Real bundle lacks exactly one source');
    const zip = unzipSync(new Uint8Array(await exported.blob!.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(zip['manifest.json']));
    check(manifest.media.length === 1, 'Bundle manifest media count changed');
    check(await hash(new Blob([new Uint8Array(zip[manifest.media[0].relativePath]!)])) === sourceHash, 'Bundle changed original bytes');
    const destination = await (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName);
    const result = await importProjectBundle(new File([exported.blob!], exported.filename,
      { type: 'application/zip' }), destination, { newProjectName: 'Reopened owned Lottie' });
    check(result.mediaImported === 1 && result.mediaSkipped === 0 && result.conflicts.length === 0,
      'Actual bundle import did not restore all media');
    check(result.project.timeline, 'Restored project has no timeline');
    check(portable(result.project.timeline!) === portable(stored!.timeline!), 'Bundle restore changed full timeline graph/maps');
    await openStored(result.project);
    check(portable(timeline()) === portable(stored!.timeline!), 'Actual bundle reload changed full timeline graph/maps');
    const reopenedSource = await mediaLibraryService.getMediaFile(item().mediaId);
    check(reopenedSource && await hash(reopenedSource) === sourceHash, 'Reopened bundle bytes changed');
    return { bundleHash: await hash(exported.blob!), sourceHash,
      mediaImported: result.mediaImported, timeline: portable(timeline()) };
  },
  async dispose() {
    view.unmount();
    useProjectStore.getState().setCurrentProject(null);
    resetTimelineCompositionTestState();
    for (const url of ownedUrls) URL.revokeObjectURL(url);
    ownedUrls.clear();
    setWorkspaceRoot(null);
    if (directoryName) await (await navigator.storage.getDirectory()).removeEntry(directoryName, { recursive: true });
    directoryName = '';
  },
};
Object.assign(window, { fl105Lottie: api });
