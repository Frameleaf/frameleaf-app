import {
  BACKUP_COVERAGE_MAX_BYTES,
  LEGACY_MANIFEST_KEY,
  backupCoverageBodies,
  backupCoverageRevisionInputSchema,
  backupCoverageRevisionSchema,
  backupCoverageRowSchema,
  backupCoverageRowsPageSchema,
  backupRunCoverageStateSchema,
} from 'src/utils/frameleaf-cloud-backup-coverage.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

type FixtureCase = {
  label: string;
  header: { revisionId: string; sequence: number; inventoryAt: string; snapshot: unknown };
  pages: Array<{ pageIndex: number; body: { rows: unknown[] } }>;
  state: unknown;
  reads: unknown[];
};

const cases = cloudContractFixture<FixtureCase[]>('backup/run-coverage-client.json');
const fingerprint = (n: number) => n.toString(16).padStart(64, '0');
const row = (n: number, overrides: Record<string, unknown> = {}) => ({
  userFingerprint: fingerprint(n),
  totalOriginals: 10,
  selectedOriginals: 3,
  licenceEligible: true,
  includedOriginals: 2,
  ...overrides,
});

describe('Frameleaf Cloud run coverage contract (FL-362, FC-149)', () => {
  it.each(cases.map((value) => [value.label, value] as const))(
    'reproduces the published %s pages exactly and reads its answers',
    (_label, fixture) => {
      const rows = fixture.pages.flatMap(({ body }) => body.rows) as never[];
      const bodies = backupCoverageBodies({
        revisionId: fixture.header.revisionId,
        sequence: fixture.header.sequence,
        inventoryAt: fixture.header.inventoryAt,
        snapshot: fixture.header.snapshot as never,
        // the builder sorts: hand it the rows in reverse
        rows: rows.toReversed(),
      });
      expect(bodies.header).toEqual(fixture.header);
      expect(bodies.pages.map((body) => JSON.parse(body))).toEqual(fixture.pages.map(({ body }) => body));
      expect(backupRunCoverageStateSchema.parse(fixture.state)).toEqual(fixture.state);
      for (const read of fixture.reads) {
        expect(backupCoveragePageRead(read)).toEqual(read);
      }
    },
  );

  it('writes every page but the last with exactly 32 rows, never truncating a large server', () => {
    const bodies = backupCoverageBodies({
      sequence: 1,
      inventoryAt: '2026-10-16T12:00:00.000Z',
      snapshot: { kind: 'legacy', manifestKey: 'm/20261016T120000Z.json.gz' },
      rows: Array.from({ length: 100 }, (_, index) => row(index + 1)),
    });
    expect(bodies.header).toMatchObject({ accountCount: 100, pageCount: 4 });
    expect(bodies.pages.map((body) => (JSON.parse(body) as { rows: unknown[] }).rows.length)).toEqual([32, 32, 32, 4]);
  });

  it('keeps a page of the largest numbers under the byte limit', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const bodies = backupCoverageBodies({
      sequence: 1,
      inventoryAt: '2026-10-16T12:00:00.000Z',
      snapshot: { kind: 'legacy', manifestKey: 'm/20261016T120000Z.json.gz' },
      rows: Array.from({ length: 32 }, (_, index) =>
        row(index + 1, { totalOriginals: big, selectedOriginals: big, includedOriginals: big }),
      ),
    });
    expect(Buffer.byteLength(bodies.pages[0], 'utf8')).toBeLessThanOrEqual(BACKUP_COVERAGE_MAX_BYTES);
  });

  it('sends the same bytes for the same rows, whatever order they came in', () => {
    const input = (rows: ReturnType<typeof row>[]) =>
      backupCoverageBodies({
        revisionId: '00000000-0000-4000-8000-000000000001',
        sequence: 1,
        inventoryAt: '2026-10-16T12:00:00.000Z',
        snapshot: null,
        rows: rows.map((value) => ({ ...value, includedOriginals: null })),
      });
    expect(input([row(2), row(1)])).toEqual(input([row(1), row(2)]));
  });

  it('refuses what the contract would refuse, before anything is sent', () => {
    const base = { sequence: 1, inventoryAt: '2026-10-16T12:00:00.000Z' };
    expect(() => backupCoverageBodies({ ...base, snapshot: null, rows: [row(1)] })).toThrow(/committed snapshot/);
    expect(() =>
      backupCoverageBodies({
        ...base,
        snapshot: { kind: 'legacy', manifestKey: 'm/20261016T120000Z.json.gz' },
        rows: [row(1), row(1)],
      }),
    ).toThrow(/share one coverage fingerprint/);
    expect(backupCoverageRowSchema.safeParse(row(1, { selectedOriginals: 11 })).success).toBe(false);
    expect(backupCoverageRowSchema.safeParse(row(1, { includedOriginals: 4 })).success).toBe(false);
    expect(backupCoverageRowSchema.safeParse(row(1, { licenceEligible: false })).success).toBe(false);
    expect(backupCoverageRowSchema.safeParse({ ...row(1), albumIds: [] }).success).toBe(false);
    expect(
      backupCoverageRevisionInputSchema.safeParse({
        revisionId: '00000000-0000-4000-8000-000000000001',
        sequence: 1,
        inventoryAt: '2026-10-16T12:00:00.000Z',
        accountCount: 33,
        pageCount: 1,
        snapshot: null,
      }).success,
    ).toBe(false);
  });

  it('binds legacy runs by their basic or extended ISO manifest key, never a client-encrypted key', () => {
    expect(LEGACY_MANIFEST_KEY.test('m/20261016T120000Z.json.gz')).toBe(true);
    expect(LEGACY_MANIFEST_KEY.test('m/2026-10-16T12:00:00.000Z.json.gz')).toBe(true);
    expect(LEGACY_MANIFEST_KEY.test('m/v1/00000000-0000-4000-8000-000000000001/1/20261016T120000Z.json.gz')).toBe(
      false,
    );
  });

  it('reads a published revision', () => {
    const published = cases.find(({ label }) => label === '33-accounts')!.state as { published: unknown };
    expect(backupCoverageRevisionSchema.parse(published.published)).toEqual(published.published);
  });
});

const backupCoveragePageRead = (value: unknown) => backupCoverageRowsPageSchema.parse(value);
