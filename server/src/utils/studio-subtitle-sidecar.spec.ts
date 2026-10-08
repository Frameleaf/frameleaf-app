import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prepareSidecarPlan, resolveEffectiveTrackStates, serializeSrt } from '#studio-subtitle-sidecar';
import { buildStudioSidecarSemanticPlan, sealStudioSidecar, sidecarSealOf } from 'src/utils/studio-subtitle-sidecar.js';

const fps = 30_000 / 1001;
const track = (id: string, order = 0, extra = {}) => ({ id, order, visible: true, ...extra });
const cue = (id: string, start: number, end: number, text: string) => ({
  id,
  startSeconds: start / fps,
  endSeconds: end / fps,
  text,
});
const segment = (id: string, trackId: string, cues: any[], extra = {}) => ({
  id,
  type: 'subtitle',
  trackId,
  from: 0,
  durationInFrames: 120,
  source: { type: 'subtitle-import' },
  cues,
  ...extra,
});
function graph() {
  return {
    metadata: { fps, frameRate: { num: 30_000, den: 1001 } },
    timeline: {
      tracks: [track('title'), track('caption', 1), track('second', 2), track('hidden', 3, { visible: false })],
      items: [
        { id: 'title', type: 'text', trackId: 'title', from: 0, durationInFrames: 120, text: 'ORDINARY TITLE' },
        segment('a', 'caption', [cue('a', 20, 50, 'Café 東京\nsecond line'), cue('b', 70, 110, 'Tail cue')]),
        {
          id: 'second-caption',
          type: 'text',
          textRole: 'caption',
          captionSource: { type: 'subtitle-import' },
          trackId: 'second',
          from: 20,
          durationInFrames: 10,
          text: 'Equal start second track',
        },
        segment('hidden', 'hidden', [cue('hidden', 0, 30, 'HIDDEN')]),
      ],
      transitions: [],
      keyframes: [],
    },
  };
}
describe('shared durable-sidecar semantic producer only', () => {
  it('binds the immutable server seal to actual ordered bytes, graph, revision, manifest and engine', () => {
    const input = graph();
    const binding = { revisionDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), engineDigest: 'c'.repeat(64) };
    const seal = sealStudioSidecar(input, binding, { inPoint: 30, outPoint: 90 });
    const expected =
      '1\n00:00:00,000 --> 00:00:00,667\nCafé 東京\nsecond line\n\n2\n00:00:01,335 --> 00:00:02,002\nTail cue';
    expect(seal).toMatchObject({
      ...binding,
      required: true,
      codec: 'srt',
      cueCount: 2,
      zeroCue: false,
      sizeInBytes: String(Buffer.byteLength(expected)),
      expectedSrtSha256: createHash('sha256').update(expected).digest('hex'),
      cadence: { num: 30_000, den: 1001 },
      inPoint: 30,
      outPoint: 90,
    });
    expect(sidecarSealOf({ subtitleMode: 'sidecar', subtitleSeal: seal })).toEqual(seal);
    expect(() => sidecarSealOf({ subtitleMode: 'sidecar' })).toThrow();
    expect(() => sidecarSealOf({ subtitleMode: 'burn', subtitleSeal: seal })).toThrow();
    expect(() => sidecarSealOf({ subtitleMode: 'sidecar', subtitleSeal: { ...seal, cueCount: 0 } })).toThrow();
    expect(() => sealStudioSidecar({ ...input, compositions: [{ id: 'nested' }] }, binding)).toThrow();
  });
  it('matches independently authored whole/subrange 30000/1001 bytes and preserves graph', () => {
    const input = graph(),
      before = JSON.stringify(input);
    const whole = buildStudioSidecarSemanticPlan(input);
    expect(whole.content).toBe(
      '1\n00:00:00,667 --> 00:00:01,001\nEqual start second track\n\n2\n00:00:00,667 --> 00:00:01,668\nCafé 東京\nsecond line\n\n3\n00:00:02,336 --> 00:00:03,670\nTail cue',
    );
    const range = buildStudioSidecarSemanticPlan(input, { inPoint: 30, outPoint: 90 });
    expect(range.content).toBe(
      '1\n00:00:00,000 --> 00:00:00,667\nCafé 東京\nsecond line\n\n2\n00:00:01,335 --> 00:00:02,002\nTail cue',
    );
    expect(whole.cues.map((x) => x.id)).toEqual(['second-caption', 'a', 'b']);
    expect(JSON.stringify(input)).toBe(before);
    expect(range.expectedSrtSha256).toBe(createHash('sha256').update(range.content).digest('hex'));
  });
  it('uses independent BigInt frame timestamp oracle over authored offsets', () => {
    for (const end of [1, 2, 30, 60, 90, 120]) {
      const input = graph();
      input.timeline.items = [segment('q', 'caption', [cue('q', 0, end, 'Q')])];
      const result = buildStudioSidecarSemanticPlan(input);
      const ms = (2n * BigInt(end) * 1001n * 1000n + 30_000n) / (2n * 30_000n);
      const stamp = `00:00:${String(ms / 1000n).padStart(2, '0')},${String(ms % 1000n).padStart(3, '0')}`;
      expect(result.content).toContain(`00:00:00,000 --> ${stamp}`);
    }
  });
  it('preserves descending canonical traversal for complete ties rather than id order', () => {
    const input = graph();
    input.timeline.tracks = [track('a-low', 0), track('z-high', 1)];
    input.timeline.items = [
      segment('a-second', 'a-low', [cue('a-second', 20, 50, 'Second')]),
      segment('z-first', 'z-high', [cue('z-first', 20, 50, 'First')]),
    ];
    expect(buildStudioSidecarSemanticPlan(input).cues.map((x) => x.id)).toEqual(['z-first', 'a-second']);
  });
  it('seals zero eligible cues with explicit empty SHA, allowing touching/out-of-range exclusion', () => {
    const input = graph();
    input.timeline.items = [segment('q', 'caption', [cue('q', 0, 20, 'Before')])];
    const plan = buildStudioSidecarSemanticPlan(input, { inPoint: 30, outPoint: 90 });
    expect(plan).toMatchObject({
      required: true,
      zeroCue: true,
      cueCount: 0,
      content: '',
      byteLength: 0,
      expectedSrtSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    input.timeline.items = [segment('q', 'caption', [cue('q', 0, 20, 'Touch')], { durationInFrames: 30 })];
    expect(buildStudioSidecarSemanticPlan(input, { inPoint: 30, outPoint: 90 }).zeroCue).toBe(true);
  });
  it.each([NaN, Infinity, -Infinity, Number.MAX_VALUE])(
    'refuses malformed authored cue %s even off range before filtering',
    (bad) => {
      const input = graph();
      input.timeline.items = [
        segment('q', 'caption', [{ id: 'q', startSeconds: bad, endSeconds: 2, text: 'Bad' }], { from: 200 }),
      ];
      expect(() => buildStudioSidecarSemanticPlan(input, { inPoint: 30, outPoint: 90 })).toThrow(/malformed|unsafe/);
    },
  );
  it.each([
    { startSeconds: 1, endSeconds: 1, text: 'zero' },
    { startSeconds: 2, endSeconds: 1, text: 'reverse' },
    { startSeconds: 0, endSeconds: 1, text: null },
  ])('refuses malformed cue shape', (value) => {
    const input = graph();
    input.timeline.items = [segment('q', 'caption', [{ id: 'q', ...value }])];
    expect(() => buildStudioSidecarSemanticPlan(input)).toThrow(/malformed/);
  });
  it('refuses eligible positive duration nearest-ms collapse without changing legacy serializer', () => {
    const input = graph(),
      tiny = { id: 'tiny', startSeconds: 0.0001, endSeconds: 0.0004, text: 'Tiny' };
    input.timeline.items = [segment('q', 'caption', [tiny])];
    expect(() => buildStudioSidecarSemanticPlan(input)).toThrow(/representable/);
    expect(serializeSrt([tiny])).toBe('1\n00:00:00,000 --> 00:00:00,000\nTiny');
  });
  it.each(['composition', 'virtual', 'reverse'])('refuses unsupported %s authored execution', (kind) => {
    const input = graph();
    input.timeline.items = [
      {
        id: 'q',
        type: kind === 'composition' ? 'composition' : 'video',
        trackId: 'title',
        from: 0,
        durationInFrames: 120,
        ...(kind === 'virtual'
          ? { transcriptCaptions: { enabled: true } }
          : kind === 'reverse'
            ? { isReversed: true }
            : { compositionId: 'child' }),
      } as any,
    ];
    expect(() => buildStudioSidecarSemanticPlan(input)).toThrow(/unsupported/);
  });
  it('retains whitespace and multiline Unicode normalization', () => {
    const input = graph();
    input.timeline.items = [segment('q', 'caption', [cue('q', 0, 30, '  Café 東京\nsecond line  ')])];
    expect(buildStudioSidecarSemanticPlan(input).content).toBe(
      '1\n00:00:00,000 --> 00:00:01,001\nCafé 東京\nsecond line',
    );
  });
  it.each([27.3, NaN, Infinity, 0])('refuses unsupported actual cadence %s', (fps) => {
    expect(() => prepareSidecarPlan({ tracks: [], items: [], fps })).toThrow(/cadence/);
  });
  it.each([0.5, Number.MAX_SAFE_INTEGER + 1])('refuses unsafe authored frame %s', (from) => {
    const input = graph();
    input.timeline.items[0].from = from;
    expect(() => buildStudioSidecarSemanticPlan(input)).toThrow(/timing/);
  });
  it('preserves exact helper order, unresolved-parent reference and every boolean expression', () => {
    const plain = track('plain', 9, { parentTrackId: 'missing', extra: 'kept' });
    expect(resolveEffectiveTrackStates([plain])[0]).toBe(plain);
    for (let mask = 0; mask < 256; mask++) {
      const flags = ['locked', 'muted', 'visible', 'solo'];
      const parent: any = { id: 'g', isGroup: true, order: 0 },
        child: any = { id: 'c', parentTrackId: 'g', order: 2, extra: 'kept' };
      for (const [i, key] of flags.entries()) {
        parent[key] = !!(mask & (1 << i));
        child[key] = !!(mask & (1 << (i + 4)));
      }
      const [got, last] = resolveEffectiveTrackStates([parent, child, plain]);
      expect(got).toEqual({
        ...child,
        locked: child.locked || parent.locked,
        muted: child.muted || parent.muted,
        visible: child.visible !== false && parent.visible !== false,
        solo: child.solo || parent.solo,
      });
      expect(last).toBe(plain);
    }
  });
  it('preserves immediate-parent lookup without recursive inheritance', () => {
    const top = { id: 'top', isGroup: true, visible: false },
      middle = { id: 'middle', isGroup: true, parentTrackId: 'top', visible: true },
      child = { id: 'c', parentTrackId: 'middle', visible: true };
    expect(resolveEffectiveTrackStates([top, middle, child])[0].visible).toBe(true);
  });
});

it('strict boundary refuses explicit unsafe/mismatched rational metadata instead of ignoring it', () => {
  for (const frameRate of [
    { num: 24, den: 0 },
    { num: Number.MAX_SAFE_INTEGER + 1, den: 1 },
    { num: 25, den: 1 },
  ])
    expect(() => prepareSidecarPlan({ tracks: [], items: [], fps: 24, frameRate })).toThrow(/cadence/);
});
describe('long-offset exact Sidecar boundary', () => {
  const longGraph = (rate: number, exact?: { num: number; den: number }) => ({
    metadata: { fps: rate, ...(exact && { frameRate: exact }) },
    timeline: {
      tracks: [track('caption')],
      items: [
        {
          id: 'late',
          type: 'text',
          textRole: 'caption',
          captionSource: { type: 'subtitle-import' },
          trackId: 'caption',
          from: 30_000,
          durationInFrames: 30,
          text: 'Late',
        },
      ],
    },
  });
  it('refuses unresolved rounded legacy whole/subrange rather than claiming exact cadence', () => {
    const input = longGraph(29.97);
    expect(() => buildStudioSidecarSemanticPlan(input)).toThrow(/cadence/);
    expect(() => buildStudioSidecarSemanticPlan(input, { inPoint: 29_970, outPoint: 30_060 })).toThrow(/cadence/);
  });
  it('preserves independently authored exact whole/subrange long-offset bytes', () => {
    const input = longGraph(30_000 / 1001, { num: 30_000, den: 1001 });
    expect(buildStudioSidecarSemanticPlan(input).content).toBe('1\n00:16:41,000 --> 00:16:42,001\nLate');
    expect(buildStudioSidecarSemanticPlan(input, { inPoint: 29_970, outPoint: 30_060 }).content).toBe(
      '1\n00:00:01,001 --> 00:00:02,002\nLate',
    );
    expect(() => buildStudioSidecarSemanticPlan(longGraph(29.97, { num: 30_000, den: 1001 }))).toThrow(/cadence/);
  });
});
