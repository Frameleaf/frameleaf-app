import { StudioResourceKind, extractStudioResourceReferences } from 'src/utils/studio-resources.js';
import { checkReverseClipSource, relinkReverseClip } from 'src/utils/studio-reverse-clip.js';
import { reverseClipGraph } from 'test/fixtures/studio-reverse-conform.stub.js';

const source = { frames: 3, frameRate: { num: 3, den: 1 } };
describe('source-level reverse clip relink', () => {
  it('mirrors the selected source interval, preserves timeline/effects and removes original source locators', () => {
    const graph = reverseClipGraph();
    const original = structuredClone(graph);
    const next = relinkReverseClip(graph, 'clip-a', source, 'reverse-result');
    expect(graph).toEqual(original);
    expect(next.timeline.items[0]).toEqual({
      id: 'clip-a',
      type: 'video',
      generatedId: 'reverse-result',
      trackId: 'video-1',
      from: 20,
      durationInFrames: 1,
      sourceStart: 2,
      sourceEnd: 3,
      sourceDuration: 3,
      sourceFps: 3,
      speed: 1,
      isReversed: false,
      trimStart: 2,
      offset: 2,
      trimEnd: 0,
      effects: original.timeline.items[0].effects,
      transform: original.timeline.items[0].transform,
    });
    expect(next.extensions).toEqual(original.extensions);
    const extracted = extractStudioResourceReferences(next);
    expect(extracted.violations).toEqual([]);
    expect(extracted.references).toEqual([
      expect.objectContaining({ kind: StudioResourceKind.GeneratedIntermediate, id: 'reverse-result' }),
    ]);
  });

  it('refuses retimed clips rather than shifting their reverse sampling', () => {
    const graph = reverseClipGraph();
    Object.assign(graph.timeline.items[0], { sourceStart: 0, sourceEnd: 2, speed: 2 });
    expect(() => relinkReverseClip(graph, 'clip-a', source, 'reverse-result')).toThrow('unity speed');
  });

  it('refuses a different project cadence without rewriting clip timing', () => {
    const graph = reverseClipGraph();
    graph.metadata = { fps: 6, frameRate: { num: 6, den: 1 } };
    expect(() => relinkReverseClip(graph, 'clip-a', source, 'reverse-result')).toThrow('matching cadence');
  });

  it.each(['ambiguous', 'linked', 'fractional-trim', 'changed-cadence', 'wrong-duration', 'forward', 'missing'])(
    'refuses %s clips',
    (reason) => {
      const graph = reverseClipGraph();
      const clip = graph.timeline.items[0];
      switch (reason) {
        case 'ambiguous': {
          graph.timeline.items.push({ ...clip });
          break;
        }
        case 'linked': {
          Object.assign(clip, { linkedGroupId: 'pair' });
          break;
        }
        case 'fractional-trim': {
          clip.sourceStart = 0.5;
          break;
        }
        case 'changed-cadence': {
          clip.sourceFps = 4;
          break;
        }
        case 'wrong-duration': {
          clip.durationInFrames = 2;
          break;
        }
        case 'forward': {
          clip.isReversed = false;
          break;
        }
      }
      expect(() => checkReverseClipSource(graph, reason === 'missing' ? 'missing' : 'clip-a', source)).toThrow(
        'Source conform requires',
      );
    },
  );
});
