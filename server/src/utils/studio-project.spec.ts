import {
  STUDIO_DIFF_MAX_PATHS,
  STUDIO_ENGINE,
  STUDIO_ENVELOPE_SCHEMA_VERSION,
  STUDIO_LEASE_MS,
  STUDIO_LEASE_RENEW_MS,
  STUDIO_TRASH_RETENTION_DAYS,
  canAcquireStudioLease,
  canonicalJson,
  checkStudioEnvelope,
  diffStudioGraphs,
  formatStudioTime,
  isStudioLeaseHeld,
  mergeCommandSummaries,
  normalizeCommandSummary,
  normalizeStudioTime,
  studioDaysUntilPurge,
  studioEnvelopeDigest,
  studioProjectShelf,
  studioPurgeAfter,
} from 'src/utils/studio-project.js';
import { STUDIO_MAX_GRAPH_BYTES } from 'src/utils/studio-resources.js';

const envelope = (graph?: unknown) => ({
  schemaVersion: STUDIO_ENVELOPE_SCHEMA_VERSION,
  engine: STUDIO_ENGINE,
  engineRevision: 'abc123',
  graph: graph === undefined ? { tracks: [] } : graph,
});

describe('checkStudioEnvelope', () => {
  it('accepts a well-formed envelope and keeps the graph untouched', () => {
    const graph = { tracks: [{ id: 't1', clips: [] }], futureField: { anything: true } };
    const result = checkStudioEnvelope(envelope(graph));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.graph).toBe(graph);
      expect(result.graphBytes).toBe(Buffer.byteLength(JSON.stringify(graph)));
    }
  });

  it('drops a top-level key the client invented instead of storing it', () => {
    const result = checkStudioEnvelope({ ...envelope(), extra: 'no' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.envelope).sort()).toEqual(['engine', 'engineRevision', 'graph', 'schemaVersion']);
    }
  });

  it.each([
    ['not-an-object', null],
    ['not-an-object', []],
    ['schema-version', { ...envelope(), schemaVersion: 2 }],
    ['engine', { ...envelope(), engine: 'other' }],
    ['engine-revision', { ...envelope(), engineRevision: '' }],
    ['graph-missing', { ...envelope(), graph: undefined }],
  ])('refuses %s', (problem, candidate) => {
    const result = checkStudioEnvelope(candidate);
    expect(result).toMatchObject({ ok: false, problem });
  });

  it('refuses a graph above the size limit', () => {
    const result = checkStudioEnvelope(envelope({ padding: 'x'.repeat(STUDIO_MAX_GRAPH_BYTES + 1) }));
    expect(result).toMatchObject({ ok: false, problem: 'graph-too-large' });
  });

  it('refuses a graph that cannot be serialized rather than losing it at reload', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(checkStudioEnvelope(envelope(cyclic))).toMatchObject({ ok: false, problem: 'not-serializable' });
  });
});

describe('canonicalJson and studioEnvelopeDigest', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });

  it('gives two differently ordered documents the same digest', () => {
    const one = envelope({ x: 1, y: { p: 'a', q: 'b' } });
    const two = envelope({ y: { q: 'b', p: 'a' }, x: 1 });
    expect(studioEnvelopeDigest(one)).toBe(studioEnvelopeDigest(two));
  });

  it('changes the digest when a value changes', () => {
    expect(studioEnvelopeDigest(envelope({ x: 1 }))).not.toBe(studioEnvelopeDigest(envelope({ x: 2 })));
  });

  it('ignores undefined values, which JSON drops anyway', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('lease rules', () => {
  const now = new Date('2026-09-22T12:00:00.000Z');
  const live = new Date(now.getTime() + 10_000);
  const lapsed = new Date(now.getTime() - 1);

  it('keeps the renewal interval a third of the lease', () => {
    expect(STUDIO_LEASE_MS).toBe(3 * STUDIO_LEASE_RENEW_MS);
  });

  it('treats a lapsed or empty lease as not held', () => {
    expect(isStudioLeaseHeld({ holderId: 'u', holderSessionId: 's', expiresAt: lapsed }, now)).toBe(false);
    expect(isStudioLeaseHeld({ holderId: null, holderSessionId: null, expiresAt: null }, now)).toBe(false);
    expect(isStudioLeaseHeld({ holderId: 'u', holderSessionId: 's', expiresAt: live }, now)).toBe(true);
  });

  it('lets the holder and anyone after a lapse acquire, but not a second live client', () => {
    const held = { holderId: 'u', holderSessionId: 'tab-a', expiresAt: live };
    expect(canAcquireStudioLease(held, 'tab-a', now)).toBe(true);
    expect(canAcquireStudioLease(held, 'tab-b', now)).toBe(false);
    expect(canAcquireStudioLease({ ...held, expiresAt: lapsed }, 'tab-b', now)).toBe(true);
  });
});

describe('normalizeStudioTime', () => {
  it('reduces to lowest terms with a positive denominator', () => {
    expect(normalizeStudioTime({ num: 2002, den: 60_000 })).toEqual({ num: 1001, den: 30_000 });
    expect(normalizeStudioTime({ num: -3, den: -6 })).toEqual({ num: 1, den: 2 });
    expect(formatStudioTime({ num: 1001, den: 30_000 })).toBe('1001/30000');
  });

  it('refuses negative time, zero denominators, floats and unsafe integers', () => {
    expect(normalizeStudioTime({ num: -1, den: 2 })).toBeNull();
    expect(normalizeStudioTime({ num: 1, den: 0 })).toBeNull();
    expect(normalizeStudioTime({ num: 1.5, den: 1 })).toBeNull();
    expect(normalizeStudioTime({ num: Number.MAX_SAFE_INTEGER + 2, den: 1 })).toBeNull();
    expect(normalizeStudioTime('1/2')).toBeNull();
  });

  it('keeps zero as 0/1', () => {
    expect(normalizeStudioTime({ num: 0, den: 7 })).toEqual({ num: 0, den: 1 });
  });
});

describe('normalizeCommandSummary', () => {
  it('keeps well-formed counts and drops the rest', () => {
    expect(
      normalizeCommandSummary({
        counts: { 'clip.move': 3, 'clip.split': 1, bad: -1, worse: 'x', ['y'.repeat(65)]: 1 },
      }),
    ).toEqual({ counts: { 'clip.move': 3, 'clip.split': 1 }, total: 4 });
    expect(normalizeCommandSummary(null)).toEqual({ counts: {}, total: 0 });
  });

  it('merges a run of summaries for a multi-revision diff', () => {
    expect(
      mergeCommandSummaries([{ counts: { 'clip.move': 1 } }, { counts: { 'clip.move': 2, 'title.add': 1 } }, null]),
    ).toEqual({ counts: { 'clip.move': 3, 'title.add': 1 }, total: 4 });
  });
});

describe('diffStudioGraphs', () => {
  it('reports paths and counts, never values', () => {
    const before = { name: 'Lake trip', tracks: [{ id: 't1', clips: [{ id: 'c1', start: 0 }] }] };
    const after = { name: 'Lake trip 2', tracks: [{ id: 't1', clips: [{ id: 'c1', start: 5 }] }], captions: [] };

    const diff = diffStudioGraphs(before, after);

    expect(diff).toEqual({
      added: 1,
      removed: 0,
      changed: 2,
      paths: ['/captions', '/name', '/tracks/0/clips/0'],
      truncated: false,
    });
    expect(JSON.stringify(diff)).not.toContain('Lake');
  });

  it('is empty for identical graphs and aggregates deep changes to one path', () => {
    expect(diffStudioGraphs({ a: [1, 2] }, { a: [1, 2] })).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
      paths: [],
      truncated: false,
    });

    const deep = (value: number) => ({ a: { b: { c: { d: { e: { f: value, g: value } } } } } });
    expect(diffStudioGraphs(deep(1), deep(2))).toMatchObject({ changed: 1, paths: ['/a/b/c/d'] });
  });

  it('caps the path list and says so', () => {
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    for (let index = 0; index < STUDIO_DIFF_MAX_PATHS + 5; index++) {
      after[`k${index}`] = index;
    }

    const diff = diffStudioGraphs(before, after);

    expect(diff.paths).toHaveLength(STUDIO_DIFF_MAX_PATHS);
    expect(diff.added).toBe(STUDIO_DIFF_MAX_PATHS + 5);
    expect(diff.truncated).toBe(true);
  });
});

describe('project lifecycle', () => {
  const now = new Date('2026-09-22T12:00:00.000Z');

  it('keeps a trashed project for the whole retention period and no longer', () => {
    const purgeAfter = studioPurgeAfter(now);
    expect(purgeAfter.getTime() - now.getTime()).toBe(STUDIO_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(studioDaysUntilPurge(purgeAfter, now)).toBe(STUDIO_TRASH_RETENTION_DAYS);
    expect(studioDaysUntilPurge(new Date(now.getTime() - 1000), now)).toBe(0);
    expect(studioDaysUntilPurge(null, now)).toBeNull();
  });

  it('puts a trashed project in the trash even when it was archived first', () => {
    expect(studioProjectShelf({ deletedAt: null, archivedAt: null })).toBe('active');
    expect(studioProjectShelf({ deletedAt: null, archivedAt: now })).toBe('archived');
    expect(studioProjectShelf({ deletedAt: now, archivedAt: now })).toBe('trashed');
  });
});
