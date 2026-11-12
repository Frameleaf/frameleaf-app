import { describe, expect, it } from 'vitest';
import {
  type LibraryFingerprint,
  type LibraryFingerprintCounts,
  type LibraryFingerprintRoot,
  buildLibraryFingerprint,
  compareLibraryFingerprints,
  hasUpgradeFingerprint,
  parseSentinel,
  sentinelPath,
} from 'src/utils/library-fingerprint.js';

const root = (patch: Partial<LibraryFingerprintRoot> = {}): LibraryFingerprintRoot => ({
  kind: 'library',
  name: 'Family archive',
  path: '/mnt/photos',
  sentinelId: 'a3c1f0de-0000-4000-8000-000000000001',
  state: 'present',
  assets: 600,
  folders: { '2023': 250, '2024': 350 },
  ...patch,
});

const fingerprint = (patch: Partial<LibraryFingerprint> = {}): LibraryFingerprint => ({
  version: '1.4.0',
  capturedAt: '2027-01-05T10:00:00.000Z',
  assets: {
    total: 1000,
    newestAt: '2027-01-04T18:30:00.000Z',
    byType: { IMAGE: 900, VIDEO: 100 },
    byOwner: { 'owner-1': 700, 'owner-2': 300 },
    byLibrary: { '': 400, 'library-1': 600 },
  },
  tables: { asset: 1000, user: 2, album: 12, person: 40, asset_face: 3200, smart_search: 1000 },
  roots: [root()],
  ...patch,
});

const after = (patch: Partial<LibraryFingerprint> = {}) =>
  fingerprint({ version: '1.4.1', capturedAt: '2027-01-05T10:02:00.000Z', ...patch });

const assets = (patch: Partial<LibraryFingerprint['assets']>) => ({ ...fingerprint().assets, ...patch });

describe('compareLibraryFingerprints (FL-954)', () => {
  it('reports ok with matching counts after a clean upgrade', () => {
    expect(compareLibraryFingerprints(fingerprint(), after())).toEqual({
      fromVersion: '1.4.0',
      toVersion: '1.4.1',
      checkedAt: '2027-01-05T10:02:00.000Z',
      state: 'ok',
      findings: [],
      assets: { before: 1000, after: 1000 },
      newestAt: { before: '2027-01-04T18:30:00.000Z', after: '2027-01-04T18:30:00.000Z' },
      tables: [
        { name: 'asset', before: 1000, after: 1000 },
        { name: 'user', before: 2, after: 2 },
        { name: 'album', before: 12, after: 12 },
        { name: 'person', before: 40, after: 40 },
        { name: 'asset_face', before: 3200, after: 3200 },
        { name: 'smart_search', before: 1000, after: 1000 },
      ],
    });
  });

  it('names the drive that is not mounted, not missing photos', () => {
    const result = compareLibraryFingerprints(fingerprint(), after({ roots: [root({ state: 'missing' })] }));

    expect(result.state).toBe('attention');
    expect(result.findings).toEqual([
      {
        reason: 'drive-missing',
        path: '/mnt/photos',
        name: 'Family archive',
        before: 600,
        after: null,
        beforeAt: null,
        afterAt: null,
      },
    ]);
  });

  it('names a drive when another drive is mounted in its place, and leaves the name out for Frameleaf’s own folders', () => {
    const own = root({ kind: 'storage', name: '', path: '/data/upload', assets: 400, folders: { 'owner-1': 400 } });
    const result = compareLibraryFingerprints(
      fingerprint({ roots: [own] }),
      after({ roots: [{ ...own, state: 'different' }] }),
    );

    expect(result.findings).toEqual([
      expect.objectContaining({ reason: 'drive-missing', path: '/data/upload', name: null }),
    ]);
  });

  it('reports a root that was not on record before and cannot be reached now', () => {
    const added = root({ path: '/mnt/more', sentinelId: null, state: 'missing', assets: 25, folders: { a: 25 } });
    const result = compareLibraryFingerprints(fingerprint(), after({ roots: [root(), added] }));

    expect(result.findings).toEqual([
      expect.objectContaining({ reason: 'drive-missing', path: '/mnt/more', before: 25 }),
    ]);
  });

  it('says nothing about a sentinel that could not be read for another reason', () => {
    const result = compareLibraryFingerprints(fingerprint(), after({ roots: [root({ state: 'unknown' })] }));
    expect(result.state).toBe('ok');
  });

  it('allows the count to fall by up to 0.5% and fails beyond it', () => {
    const within = compareLibraryFingerprints(fingerprint(), after({ assets: assets({ total: 995 }) }));
    expect(within.state).toBe('ok');

    const beyond = compareLibraryFingerprints(fingerprint(), after({ assets: assets({ total: 994 }) }));
    expect(beyond.state).toBe('attention');
    expect(beyond.findings).toEqual([expect.objectContaining({ reason: 'photos-fewer', before: 1000, after: 994 })]);
  });

  it('is ok when photos were added during the upgrade', () => {
    const result = compareLibraryFingerprints(
      fingerprint(),
      after({ assets: assets({ total: 1010, newestAt: '2027-01-05T10:01:00.000Z' }) }),
    );
    expect(result.state).toBe('ok');
  });

  it('fails when the newest photo is older than before, or there is none any more', () => {
    const earlier = compareLibraryFingerprints(
      fingerprint(),
      after({ assets: assets({ newestAt: '2026-12-01T00:00:00.000Z' }) }),
    );
    expect(earlier.findings).toEqual([
      expect.objectContaining({
        reason: 'newest-earlier',
        beforeAt: '2027-01-04T18:30:00.000Z',
        afterAt: '2026-12-01T00:00:00.000Z',
      }),
    ]);

    const none = compareLibraryFingerprints(fingerprint(), after({ assets: assets({ total: 0, newestAt: null }) }));
    expect(none.findings.map(({ reason }) => reason)).toEqual(['photos-fewer', 'newest-earlier']);
  });

  it('fails when a folder that held files holds none now', () => {
    const result = compareLibraryFingerprints(
      fingerprint(),
      after({ roots: [root({ assets: 600, folders: { '2024': 600 } })] }),
    );

    expect(result.state).toBe('attention');
    expect(result.findings).toEqual([
      expect.objectContaining({
        reason: 'folder-empty',
        path: '/mnt/photos/2023',
        name: 'Family archive',
        before: 250,
        after: 0,
      }),
    ]);
  });

  it('does not compare folders of a root with too many of them, or files directly in the root', () => {
    const many = compareLibraryFingerprints(fingerprint(), after({ roots: [root({ folders: null })] }));
    expect(many.state).toBe('ok');

    const loose = compareLibraryFingerprints(
      fingerprint({ roots: [root({ folders: { '': 5, '2024': 595 } })] }),
      after({ roots: [root({ folders: { '2024': 600 } })] }),
    );
    expect(loose.state).toBe('ok');
  });

  it('lists the drive first, then the other differences', () => {
    const result = compareLibraryFingerprints(
      fingerprint(),
      after({ assets: assets({ total: 400 }), roots: [root({ state: 'missing', assets: 0, folders: {} })] }),
    );
    expect(result.findings.map(({ reason }) => reason)).toEqual([
      'drive-missing',
      'photos-fewer',
      'folder-empty',
      'folder-empty',
    ]);
  });

  it('shows a table that is new in this version with nothing before it', () => {
    const result = compareLibraryFingerprints(
      fingerprint({ tables: { asset: 1000, smart_search: null } }),
      after({ tables: { asset: 1000, smart_search: 1000 } }),
    );
    expect(result.tables).toEqual([
      { name: 'asset', before: 1000, after: 1000 },
      { name: 'smart_search', before: null, after: 1000 },
    ]);
  });
});

describe('buildLibraryFingerprint (FL-954)', () => {
  const counts: LibraryFingerprintCounts = {
    total: 3,
    newestAt: '2027-01-04T18:30:00.000Z',
    byType: { IMAGE: 3 },
    byOwner: { 'owner-1': 3 },
    byLibrary: { 'library-1': 3 },
    tables: { asset: 3 },
    roots: [{ path: '/mnt/photos', assets: 3, folders: { '2024': 3 } }],
  };

  it('joins what the database counted with each root on record', () => {
    const record = { kind: 'library' as const, name: 'Family archive', path: '/mnt/photos', sentinelId: 'abcdefgh' };
    const other = { kind: 'storage' as const, name: '', path: '/data/upload', sentinelId: null };

    const built = buildLibraryFingerprint('1.4.0', '2027-01-05T10:00:00.000Z', counts, [
      { ...record, state: 'present' },
      { ...other, state: 'unknown' },
    ]);

    expect(built.assets.total).toBe(3);
    expect(built.roots).toEqual([
      { ...record, state: 'present', assets: 3, folders: { '2024': 3 } },
      { ...other, state: 'unknown', assets: 0, folders: null },
    ]);
  });
});

describe('mount sentinel (FL-954)', () => {
  it('reads the id a sentinel file holds', () => {
    expect(sentinelPath('/mnt/photos')).toBe('/mnt/photos/.frameleaf-sentinel');
    expect(parseSentinel('a3c1f0de-0000-4000-8000-000000000001\n')).toBe('a3c1f0de-0000-4000-8000-000000000001');
    expect(parseSentinel('')).toBeNull();
    expect(parseSentinel('not an id\n')).toBeNull();
  });
});

describe('hasUpgradeFingerprint (FL-954)', () => {
  it('is true once the fingerprint for this upgrade is waiting or was checked', () => {
    const before = fingerprint();
    expect(hasUpgradeFingerprint(null, '1.4.0', '1.4.1')).toBe(false);
    expect(hasUpgradeFingerprint({ pending: { toVersion: '1.4.1', before } }, '1.4.0', '1.4.1')).toBe(true);
    // waiting for another version: an upgrade that never started, then a newer one
    expect(hasUpgradeFingerprint({ pending: { toVersion: '1.4.1', before } }, '1.4.0', '1.4.2')).toBe(false);
    const latest = { ...compareLibraryFingerprints(before, after()), before, after: after() };
    expect(hasUpgradeFingerprint({ latest }, '1.4.0', '1.4.1')).toBe(true);
    expect(hasUpgradeFingerprint({ latest }, '1.4.1', '1.4.2')).toBe(false);
  });
});
