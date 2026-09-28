import {
  MEMORY_HIGHLIGHT_MAX_SLOT_SECONDS,
  MEMORY_HIGHLIGHT_MIN_SLOT_SECONDS,
  MemoryHighlightAudio,
  assetDurationSeconds,
  buildMemoryHighlightGraph,
} from 'src/utils/memory-highlight.js';
import { extractStudioResourceReferences } from 'src/utils/studio-resources.js';

type Graph = {
  schemaVersion: number;
  name: string;
  sequences: Array<{
    id: string;
    fps: number;
    width: number;
    height: number;
    tracks: Array<{ id: string; kind: string; muted: boolean; clips: Array<Record<string, unknown>> }>;
  }>;
};

const photo = (id: string) => ({ id, type: 'IMAGE', duration: null });
const video = (id: string, duration: number) => ({ id, type: 'VIDEO', duration });

const build = (options: Partial<Parameters<typeof buildMemoryHighlightGraph>[0]> = {}) =>
  buildMemoryHighlightGraph({
    title: 'Lake trip',
    assets: [photo('a'), photo('b'), photo('c')],
    lengthSeconds: 60,
    resolution: '1080p',
    audio: MemoryHighlightAudio.Original,
    ...options,
  }) as Graph;

const track = (graph: Graph, kind: string) => graph.sequences[0].tracks.find((item) => item.kind === kind)!;
const end = (clip: Record<string, unknown>) => (clip.start as number) + (clip.duration as number);

describe('assetDurationSeconds', () => {
  it('reads the stored duration in milliseconds', () => {
    expect(assetDurationSeconds(12_500)).toBe(12.5);
  });

  it('answers null for anything it cannot use', () => {
    expect(assetDurationSeconds(null)).toBeNull();
    expect(assetDurationSeconds(0)).toBeNull();
    expect(assetDurationSeconds(NaN)).toBeNull();
  });
});

describe('buildMemoryHighlightGraph', () => {
  it("is the prototype's Studio project model: one sequence sized for the chosen resolution", () => {
    const graph = build({ resolution: '2160p' });
    expect(graph.schemaVersion).toBe(1);
    expect(graph.name).toBe('Lake trip');
    expect(graph.sequences).toHaveLength(1);
    expect(graph.sequences[0]).toMatchObject({ fps: 30, width: 3840, height: 2160 });
    expect(build({ resolution: '720p' }).sequences[0]).toMatchObject({ width: 1280, height: 720 });
  });

  it("keeps the memory's order and gives every item a whole-second slot inside the chosen length", () => {
    const graph = build();
    const clips = track(graph, 'video').clips;
    expect(clips.map((clip) => clip.assetId)).toEqual(['a', 'b', 'c']);
    expect(clips.map((clip) => clip.start)).toEqual([0, 5, 10]);
    for (const clip of clips) {
      expect(clip.duration).toBe(MEMORY_HIGHLIGHT_MAX_SLOT_SECONDS);
      expect(Number.isSafeInteger(clip.duration)).toBe(true);
    }
  });

  it('never runs past the chosen length, picking items evenly across the memory when there are too many', () => {
    const assets = Array.from({ length: 100 }, (_, index) => photo(`p${index}`));
    const graph = build({ assets, lengthSeconds: 30 });
    const clips = track(graph, 'video').clips;
    expect(clips).toHaveLength(30 / MEMORY_HIGHLIGHT_MIN_SLOT_SECONDS);
    expect(end(clips.at(-1)!)).toBeLessThanOrEqual(30);
    expect(clips[0].assetId).toBe('p0');
    expect(clips.at(-1)!.assetId).not.toBe('p14');
    // the picks spread across the whole memory rather than taking its first items
    expect(Number(String(clips.at(-1)!.assetId).slice(1))).toBeGreaterThan(90);
  });

  it('plays a video no longer than it is, and gives photos a Ken Burns move', () => {
    const graph = build({ assets: [video('v', 2400), photo('p')] });
    const [first, second] = track(graph, 'video').clips;
    expect(first).toMatchObject({ kind: 'video', assetId: 'v', duration: 2, kenBurns: null });
    expect(second).toMatchObject({ kind: 'photo', assetId: 'p', start: 2 });
    expect(second.kenBurns).toBeTruthy();
  });

  it("carries each video's own sound on the camera track, unless the owner chose no sound", () => {
    const assets = [video('v', 30_000), photo('p')];
    const original = track(build({ assets }), 'audio');
    expect(original.muted).toBe(false);
    expect(original.clips).toEqual([expect.objectContaining({ kind: 'audio', assetId: 'v', start: 0, duration: 5 })]);

    const silent = build({ assets, audio: MemoryHighlightAudio.Silent });
    expect(track(silent, 'audio').clips).toEqual([]);
    expect(track(silent, 'audio').muted).toBe(true);
  });

  it('opens on a title card with the memory title', () => {
    const title = track(build(), 'title').clips[0];
    expect(title).toMatchObject({ kind: 'title', text: 'Lake trip', start: 0 });
  });

  it('references only the library assets it was given, nothing a resolver would refuse', () => {
    const graph = build({ assets: [video('v', 10_000), photo('p')] });
    const extraction = extractStudioResourceReferences(graph);
    expect(extraction.violations).toEqual([]);
    const libraryIds = extraction.references.filter((ref) => ref.kind === 'library-asset').map((ref) => ref.id);
    expect(libraryIds.toSorted()).toEqual(['p', 'v']);
  });

  it('refuses a memory with nothing to show', () => {
    expect(() => build({ assets: [] })).toThrow();
  });
});
