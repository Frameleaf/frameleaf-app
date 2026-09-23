import {
  countUnresolvedByKind,
  filterUnresolved,
  MIGRATION_REPORT_MAX_BYTES,
  parseMigrationReport,
  type MigrationReport,
} from '$lib/frameleaf/migration-report';
import {
  cleanMigrationReport as cleanReport,
  failedMigrationReport as failedReport,
} from '@test-data/frameleaf/migration-report';

const parse = (value: unknown) => parseMigrationReport(JSON.stringify(value));
const accepted = (value: unknown): MigrationReport => {
  const result = parse(value);
  if (!result.ok) {
    throw new Error(`rejected: ${result.error}`);
  }
  return result.report;
};

describe('parseMigrationReport', () => {
  it('accepts a clean run and recomputes the pass verdict', () => {
    const report = accepted(cleanReport());
    expect(report.status).toBe('pass');
    expect(report.source).toBe('https://old.example.com/api');
    expect(report.owners).toEqual([{ source: 'owner@old.example.com', destination: 'owner@new.example.com' }]);
  });

  it('keeps transferred and verified counts apart', () => {
    const value = cleanReport();
    // Everything was transferred, but one original is no longer on the destination.
    value.ok = false;
    value.assets = { total: 5, transferred: 5, checked: 5, verified: 4, missing: 1, failed: 0 };
    const report = accepted(value);
    expect(report.assets.transferred).toBe(5);
    expect(report.assets.verified).toBe(4);
    expect(report.status).toBe('incomplete');
  });

  it('reports a partial failure with its unresolved items', () => {
    const report = accepted(failedReport());
    expect(report.status).toBe('incomplete');
    expect(report.unresolved.map((item) => [item.kind, item.reason])).toEqual([
      ['asset', 'transfer-failed'],
      ['album', 'not-linked'],
    ]);
  });

  it('never treats a dry run or an interrupted audit as a pass', () => {
    expect(accepted({ ...cleanReport(), dryRun: true, ok: false }).status).toBe('dry-run');
    expect(accepted({ ...cleanReport(), complete: false, ok: false }).status).toBe('audit-incomplete');
  });

  it('rejects a file whose own verdict disagrees with its counts', () => {
    expect(parse({ ...failedReport(), ok: true })).toEqual({ ok: false, error: 'inconsistent' });
    expect(parse({ ...cleanReport(), dryRun: true })).toEqual({ ok: false, error: 'inconsistent' });
  });

  it('rejects impossible counts', () => {
    const verifiedAboveTransferred = cleanReport();
    verifiedAboveTransferred.assets = { total: 5, transferred: 4, checked: 5, verified: 5, missing: 0, failed: 0 };
    expect(parse(verifiedAboveTransferred)).toEqual({ ok: false, error: 'inconsistent' });

    const hierarchy = cleanReport();
    hierarchy.albums = { ...hierarchy.albums, nested: 3 };
    expect(parse(hierarchy)).toEqual({ ok: false, error: 'inconsistent' });

    expect(parse({ ...cleanReport(), assets: { ...cleanReport().assets, total: -1 } })).toEqual({
      ok: false,
      error: 'invalid',
    });
  });

  it.each([
    ['an API key field', { apiKey: 'x' }],
    [
      'a token field in an item',
      { unresolved: [{ kind: 'asset', id: 'a', name: 'n', reason: 'not-transferred', token: 'x' }] },
    ],
    ['a raw key value', { user: 'k2xQ9vLm4RtZ8pWn3YbHc7JdFs6GaE1uTiOo' }],
    [
      'a bearer header',
      { unresolved: [{ kind: 'asset', id: 'a', name: 'n', reason: 'transfer-failed', detail: 'Bearer abc.def' }] },
    ],
    ['credentials in the server URL', { from: 'https://user:pw@old.example.com/api' }],
    ['a query token in the server URL', { to: 'https://new.example.com/api?apiKey=abc' }],
    [
      'a private key',
      { unresolved: [{ kind: 'tag', id: 't', name: '-----BEGIN RSA PRIVATE KEY-----', reason: 'not-assigned' }] },
    ],
  ])('rejects %s as a secret payload', (_label, patch) => {
    expect(parse({ ...cleanReport(), ...patch })).toEqual({ ok: false, error: 'secret' });
  });

  it.each([
    ['a POSIX path', '/mnt/photos/library/IMG_1.jpg'],
    ['a home path', '~/immich-migrate.sqlite'],
    ['a Windows path', String.raw`C:\Users\op\ledger.sqlite`],
    ['a UNC path', String.raw`\\nas\photos\IMG_1.jpg`],
    ['a file URL', 'file:///etc/passwd'],
    ['a parent walk', '../../etc/passwd'],
  ])('rejects %s anywhere in the report', (_label, value) => {
    const report = failedReport();
    report.unresolved[0] = { ...report.unresolved[0], detail: `ENOENT ${value}` };
    expect(parse(report)).toEqual({ ok: false, error: 'foreign-path' });
  });

  it('accepts album paths, tag hierarchies and UUIDs as ordinary names', () => {
    const report = failedReport();
    report.unresolved = [
      { kind: 'album', id: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'Trips / Banff', reason: 'not-linked' },
      { kind: 'tag', id: 't1', name: 'Travel/Canada/Alberta', reason: 'not-assigned' },
    ];
    expect(parse(report).ok).toBe(true);
  });

  it('accepts path-like and long names from the source library as display text', () => {
    const report = failedReport();
    report.unresolved = [
      { kind: 'album', id: 'al1', name: '/Backup', reason: 'not-created' },
      { kind: 'album', id: 'al2', name: 'Holiday /Beach', reason: 'not-linked' },
      { kind: 'person', id: 'p1', name: String.raw`C:\Old`, reason: 'not-attached' },
      { kind: 'tag', id: 't1', name: 'Grandma: /the best/', reason: 'not-assigned' },
      { kind: 'album', id: 'al3', name: 'Summer-Trip-2024-Photos-Of-The-Family-x', reason: 'not-linked' },
    ];
    report.unresolvedCount = 5;
    expect(accepted(report).unresolved.map((item) => item.name)).toEqual([
      '/Backup',
      'Holiday /Beach',
      String.raw`C:\Old`,
      'Grandma: /the best/',
      'Summer-Trip-2024-Photos-Of-The-Family-x',
    ]);
  });

  it('treats legacy missing file names as display text too', () => {
    const report = failedReport();
    report.missing = [{ aId: 'a3', filename: 'Family-Reunion-2024-Main-Hall-Take2', reason: 'not-transferred' }];
    expect(parse(report).ok).toBe(true);
  });

  it('still rejects a credential used as a name', () => {
    const report = failedReport();
    report.unresolved = [{ kind: 'album', id: 'al1', name: 'Bearer abc.def', reason: 'not-created' }];
    report.unresolvedCount = 1;
    expect(parse(report)).toEqual({ ok: false, error: 'secret' });
  });

  it('rejects other files', () => {
    expect(parse({ ...cleanReport(), format: 'something-else' })).toEqual({ ok: false, error: 'unsupported-format' });
    expect(parse({ ...cleanReport(), formatVersion: 2 })).toEqual({ ok: false, error: 'unsupported-format' });
    expect(parseMigrationReport('not json')).toEqual({ ok: false, error: 'not-json' });
    expect(parseMigrationReport('x'.repeat(MIGRATION_REPORT_MAX_BYTES + 1))).toEqual({ ok: false, error: 'too-large' });
    expect(parse({ ...cleanReport(), sourceDeletion: 'automatic' })).toEqual({ ok: false, error: 'invalid' });
    expect(parse({ ...failedReport(), unresolved: [{ kind: 'file', id: 'a', name: 'n', reason: 'x' }] })).toEqual({
      ok: false,
      error: 'invalid',
    });
  });
});

describe('unresolved item filtering', () => {
  it('filters by kind and text and counts per kind', () => {
    const { unresolved } = accepted(failedReport());
    expect(countUnresolvedByKind(unresolved)).toEqual({ asset: 1, album: 1, tag: 0, stack: 0, person: 0 });
    expect(filterUnresolved(unresolved, { kind: 'album' }).map((item) => item.id)).toEqual(['al-banff']);
    expect(filterUnresolved(unresolved, { query: 'lake' }).map((item) => item.id)).toEqual(['a3']);
    expect(filterUnresolved(unresolved, { query: '404' }).map((item) => item.id)).toEqual(['a3']);
  });
});
