import { describe, expect, it } from 'vitest';
import { RationalError, rational } from 'src/utils/rational-time.js';
import {
  type EvictionCandidate,
  type PreviewBinding,
  decidePreviewDelivery,
  isValidPreviewViewport,
  planPreviewEviction,
  previewCacheKey,
  previewETag,
  previewETagMatches,
  previewTimeKey,
} from 'src/utils/studio-preview.js';

const binding = (overrides: Partial<PreviewBinding> = {}): PreviewBinding => ({
  ownerId: 'owner-1',
  projectId: 'project-1',
  revisionDigest: 'rev-a',
  time: rational(1001, 30_000),
  quality: 'standard',
  viewportWidth: 1920,
  viewportHeight: 1080,
  ...overrides,
});

/**
 * Preview time is FL-93's `Rational`. These cases pin the properties the preview key relies
 * on; the arithmetic itself is covered by `rational-time.spec.ts`.
 */
describe('rational preview time', () => {
  it('reduces to lowest terms so equal instants share a key', () => {
    expect(previewTimeKey(rational(2, 4))).toBe('1/2');
    expect(previewTimeKey(rational(2, 4))).toBe(previewTimeKey(rational(1, 2)));
  });

  it('moves a negative denominator onto the numerator', () => {
    expect(previewTimeKey(rational(1, -2))).toBe('-1/2');
  });

  it('refuses a zero denominator rather than guessing', () => {
    expect(() => rational(1, 0)).toThrow(RationalError);
  });

  it('refuses a value a double cannot hold exactly instead of rounding it', () => {
    expect(() => rational(Number.MAX_SAFE_INTEGER + 2, 90_000)).toThrow(RationalError);
  });

  it('keeps an NTSC frame boundary exact in the key', () => {
    expect(previewTimeKey(rational(1001, 30_000))).toBe('1001/30000');
  });
});

describe('preview identity', () => {
  it('gives the same key to the same frame expressed differently', () => {
    expect(previewCacheKey(binding({ time: rational(2002, 60_000) }))).toBe(previewCacheKey(binding()));
  });

  it.each([
    ['owner', binding({ ownerId: 'owner-2' })],
    ['project', binding({ projectId: 'project-2' })],
    ['revision', binding({ revisionDigest: 'rev-b' })],
    ['time', binding({ time: rational(1002, 30_000) })],
    ['quality', binding({ quality: 'full' })],
    ['viewport width', binding({ viewportWidth: 1280 })],
    ['viewport height', binding({ viewportHeight: 720 })],
  ])('changes the key when the %s changes', (_name, other) => {
    expect(previewCacheKey(other)).not.toBe(previewCacheKey(binding()));
  });

  it('cannot be forged by a project id containing the separator', () => {
    expect(previewCacheKey(binding({ projectId: 'project-1\u{0}rev-a' }))).not.toBe(previewCacheKey(binding()));
  });

  it('puts the revision digest in the entity tag', () => {
    expect(previewETag(binding())).toContain('rev-a');
    expect(previewETag(binding({ revisionDigest: 'rev-b' }))).not.toBe(previewETag(binding()));
  });

  it('matches an entity tag exactly, weakly or by wildcard', () => {
    const etag = previewETag(binding());
    expect(previewETagMatches(etag, etag)).toBe(true);
    expect(previewETagMatches(`W/${etag}`, etag)).toBe(true);
    expect(previewETagMatches(`"other", ${etag}`, etag)).toBe(true);
    expect(previewETagMatches('*', etag)).toBe(true);
    expect(previewETagMatches('"other"', etag)).toBe(false);
    expect(previewETagMatches(undefined, etag)).toBe(false);
  });
});

describe('decidePreviewDelivery', () => {
  const now = new Date('2026-09-22T12:00:00.000Z');
  const etag = previewETag(binding());

  const input = (overrides: Partial<Parameters<typeof decidePreviewDelivery>[0]> = {}) => ({
    status: 'ready' as const,
    revisionDigest: 'rev-a',
    currentRevisionDigest: 'rev-a',
    framePath: '/frames/a.png',
    expiresAt: new Date('2026-09-22T12:05:00.000Z'),
    now,
    etag,
    ...overrides,
  });

  it('delivers a ready frame on the current revision', () => {
    expect(decidePreviewDelivery(input())).toEqual({ deliver: true });
  });

  it('refuses a frame whose revision has advanced', () => {
    expect(decidePreviewDelivery(input({ currentRevisionDigest: 'rev-b' }))).toEqual({
      deliver: false,
      outcome: 'stale-revision',
      code: 'studio_preview_stale_revision',
    });
  });

  it('refuses a superseded frame even when the digests still line up', () => {
    expect(decidePreviewDelivery(input({ status: 'superseded' }))).toMatchObject({ outcome: 'stale-revision' });
  });

  it('refuses a stale revision before honouring a conditional request', () => {
    // The whole point: a 304 here would leave the previous picture on screen.
    const decision = decidePreviewDelivery(input({ currentRevisionDigest: 'rev-b', ifNoneMatch: etag }));
    expect(decision).toMatchObject({ deliver: false, outcome: 'stale-revision' });
  });

  it('reports an expired frame as gone rather than serving its path', () => {
    expect(decidePreviewDelivery(input({ expiresAt: new Date('2026-09-22T11:59:59.000Z') }))).toMatchObject({
      outcome: 'expired',
    });
  });

  it('reports an evicted frame as gone', () => {
    expect(decidePreviewDelivery(input({ status: 'evicted', framePath: null }))).toMatchObject({ outcome: 'evicted' });
  });

  it('reports a render still in flight as not ready', () => {
    expect(decidePreviewDelivery(input({ status: 'rendering', framePath: null }))).toMatchObject({
      outcome: 'not-ready',
    });
  });

  it('never serves a row marked ready with nothing on disk', () => {
    expect(decidePreviewDelivery(input({ framePath: null }))).toMatchObject({ outcome: 'not-ready' });
  });

  it('answers 304 only for a deliverable frame', () => {
    expect(decidePreviewDelivery(input({ ifNoneMatch: etag }))).toEqual({ deliver: false, outcome: 'not-modified' });
  });
});

describe('planPreviewEviction', () => {
  const now = new Date('2026-09-22T12:00:00.000Z');
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  const candidate = (overrides: Partial<EvictionCandidate> & { id: string }): EvictionCandidate => ({
    revisionDigest: 'rev-a',
    status: 'ready',
    lastAccessedAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    ...overrides,
  });

  it('evicts settled frames of a revision nobody can ask for any more', () => {
    const plan = planPreviewEviction(
      [candidate({ id: 'old', revisionDigest: 'rev-old' }), candidate({ id: 'current' })],
      { currentRevisionDigest: 'rev-a', now },
    );

    expect(plan.evict).toEqual(['old']);
    expect(plan.cancel).toEqual([]);
  });

  it('cancels, rather than deletes, a render still in flight on a superseded revision', () => {
    const plan = planPreviewEviction([candidate({ id: 'busy', revisionDigest: 'rev-old', status: 'rendering' })], {
      currentRevisionDigest: 'rev-a',
      now,
    });

    expect(plan.cancel).toEqual(['busy']);
    expect(plan.evict).toEqual([]);
  });

  it('keeps the revisions it was told to keep', () => {
    const plan = planPreviewEviction([candidate({ id: 'undo', revisionDigest: 'rev-prev' })], {
      currentRevisionDigest: 'rev-a',
      now,
      recentRevisionDigests: ['rev-prev'],
    });

    expect(plan.evict).toEqual([]);
  });

  it('evicts expired frames on the current revision', () => {
    const plan = planPreviewEviction([candidate({ id: 'stale', expiresAt: ago(1) })], {
      currentRevisionDigest: 'rev-a',
      now,
    });

    expect(plan.evict).toEqual(['stale']);
  });

  it('never evicts an in-flight frame on the current revision for the cap', () => {
    const plan = planPreviewEviction(
      [
        candidate({ id: 'waiting', status: 'rendering', expiresAt: ago(1) }),
        candidate({ id: 'a', lastAccessedAt: ago(1) }),
        candidate({ id: 'b', lastAccessedAt: ago(2) }),
      ],
      { currentRevisionDigest: 'rev-a', now, framesPerRevision: 1 },
    );

    expect(plan.evict).not.toContain('waiting');
    expect(plan.cancel).toEqual([]);
  });

  it('gives up the least recently used first when the cap is exceeded', () => {
    const plan = planPreviewEviction(
      [
        candidate({ id: 'hot', lastAccessedAt: now }),
        candidate({ id: 'warm', lastAccessedAt: ago(1) }),
        candidate({ id: 'cold', lastAccessedAt: ago(30) }),
      ],
      { currentRevisionDigest: 'rev-a', now, framesPerRevision: 2 },
    );

    expect(plan.evict).toEqual(['cold']);
  });
});

describe('isValidPreviewViewport', () => {
  it('accepts an ordinary viewport', () => {
    expect(isValidPreviewViewport(1920, 1080)).toBe(true);
  });

  it.each([
    [0, 1080],
    [1920, 0],
    [8000, 1080],
    [1920, 8000],
    [1920.5, 1080],
    [NaN, 1080],
  ])('refuses %s x %s', (width, height) => {
    expect(isValidPreviewViewport(width, height)).toBe(false);
  });
});
