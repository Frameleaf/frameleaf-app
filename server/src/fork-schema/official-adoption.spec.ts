import {
  CERTIFIED_TAG_MIGRATIONS,
  GENERIC_LEGACY_FORK_MIGRATIONS,
  POST_CERTIFIED_UPSTREAM_MIGRATIONS,
  SUPPORTED_UPSTREAM_MIGRATIONS,
} from 'src/fork-schema/migration-manifest.js';
import {
  assertAdoptableOfficialLedger,
  assertWorkflowDataPreserved,
  planOfficialAdoption,
} from 'src/fork-schema/official-adoption.js';
import supportedVersions from 'src/fork-schema/supported-versions.json' with { type: 'json' };
import {
  LEGACY_WORKFLOW_MIGRATION,
  OFFICIAL_WORKFLOW_MIGRATION,
  WorkflowCompatibility,
} from 'src/fork-schema/workflow-compatibility.js';

const residue = supportedVersions.postCertifiedUpstreamMigrations;
// What the combined provider bundles for an adopted library: every upstream migration it ships (the
// audited provider gaps, such as the official workflow rewrite, are not files) and every Frameleaf
// public migration except the Frameleaf copy of the workflow rewrite.
const bundled = [
  ...SUPPORTED_UPSTREAM_MIGRATIONS.filter((name) => name !== OFFICIAL_WORKFLOW_MIGRATION),
  ...GENERIC_LEGACY_FORK_MIGRATIONS,
].toSorted();

describe(assertAdoptableOfficialLedger, () => {
  it('accepts the exact certified ledger', () => {
    expect(() => assertAdoptableOfficialLedger(CERTIFIED_TAG_MIGRATIONS)).not.toThrow();
  });

  it('accepts the certified ledger followed by an ordered prefix of the post-certified migrations', () => {
    expect(() => assertAdoptableOfficialLedger([...CERTIFIED_TAG_MIGRATIONS, ...residue.slice(0, 2)])).not.toThrow();
  });

  it('refuses a ledger older than the certified tag', () => {
    expect(() => assertAdoptableOfficialLedger(CERTIFIED_TAG_MIGRATIONS.slice(0, -1))).toThrow(
      'Adoption requires the exact certified v3.1.0 migration ledger',
    );
  });

  it('refuses post-certified migrations out of order', () => {
    expect(() => assertAdoptableOfficialLedger([...CERTIFIED_TAG_MIGRATIONS, residue[1]!])).toThrow(
      'Adoption requires the exact certified v3.1.0 migration ledger',
    );
  });

  it('refuses a library that already holds Frameleaf migrations', () => {
    expect(() => assertAdoptableOfficialLedger([...CERTIFIED_TAG_MIGRATIONS, LEGACY_WORKFLOW_MIGRATION])).toThrow(
      `Library already holds Frameleaf migrations: ${LEGACY_WORKFLOW_MIGRATION}`,
    );
  });

  it('refuses an unknown ledger entry', () => {
    expect(() => assertAdoptableOfficialLedger([...CERTIFIED_TAG_MIGRATIONS, '9999999999999-Unknown'])).toThrow(
      'Adoption requires the exact certified v3.1.0 migration ledger',
    );
  });
});

describe(planOfficialAdoption, () => {
  it('applies every post-certified and Frameleaf public migration in name order', () => {
    const plan = planOfficialAdoption(CERTIFIED_TAG_MIGRATIONS, bundled);

    expect(plan).toEqual([...POST_CERTIFIED_UPSTREAM_MIGRATIONS, ...GENERIC_LEGACY_FORK_MIGRATIONS].toSorted());
    expect(plan).toContain('1787148183729-ClusterGroups');
    expect(plan).toContain('2100000000570-AddWorkflowDefinitions');
    expect(plan).not.toContain(LEGACY_WORKFLOW_MIGRATION);
    // Frameleaf's early public migrations sort before the post-certified ones, exactly as a fresh
    // install orders them.
    expect(plan.indexOf('1778000000000-PhysicalDeduplication')).toBeLessThan(
      plan.indexOf('1784986754473-ConvertUserPasswordEmptyStringToNull'),
    );
    expect(plan.indexOf('1789419229196-ConvertUserOAuthIdEmptyStringToNull')).toBeLessThan(
      plan.indexOf('2100000000010-AddAssetIsNsfwIndex'),
    );
  });

  it('skips post-certified migrations a newer official server already applied', () => {
    const plan = planOfficialAdoption([...CERTIFIED_TAG_MIGRATIONS, residue[0]!], bundled);

    expect(plan).not.toContain(residue[0]);
    expect(plan).toContain(residue[1]);
  });

  it('never runs the Frameleaf copy of the workflow rewrite', () => {
    expect(() => planOfficialAdoption(CERTIFIED_TAG_MIGRATIONS, [...bundled, LEGACY_WORKFLOW_MIGRATION])).toThrow(
      `Adoption must never run ${LEGACY_WORKFLOW_MIGRATION}`,
    );
  });

  it('refuses when a certified official migration is still pending', () => {
    const ledger = CERTIFIED_TAG_MIGRATIONS.filter((name) => name !== '1781089983296-CreateIntegrityReportTable');

    expect(() => planOfficialAdoption(ledger, bundled)).toThrow();
  });

  it('refuses when a Frameleaf public migration is not bundled', () => {
    const incomplete = bundled.filter((name) => name !== '2100000000570-AddWorkflowDefinitions');

    expect(() => planOfficialAdoption(CERTIFIED_TAG_MIGRATIONS, incomplete)).toThrow(
      'Adoption is missing bundled migration(s): 2100000000570-AddWorkflowDefinitions',
    );
  });
});

describe(assertWorkflowDataPreserved, () => {
  const compatibility = (overrides: Partial<WorkflowCompatibility> = {}): WorkflowCompatibility => ({
    mode: 'official',
    schemaDigest: 'schema',
    timestamp: '2026-01-01T00:00:00.000Z',
    rowDigests: [
      { table: 'public.plugin', count: 1, digest: 'plugin' },
      { table: 'public.plugin_method', count: 2, digest: 'method' },
      { table: 'public.workflow', count: 3, digest: 'workflow' },
      { table: 'public.workflow_step', count: 4, digest: 'step' },
    ],
    ...overrides,
  });

  it('allows the workflow rows to gain the logging column', () => {
    const after = compatibility({
      schemaDigest: 'with-logs',
      rowDigests: compatibility().rowDigests.map((row) =>
        row.table === 'public.workflow' ? { ...row, digest: 'workflow-with-logging' } : row,
      ),
    });

    expect(() => assertWorkflowDataPreserved(compatibility(), after)).not.toThrow();
  });

  it('refuses a changed workflow count', () => {
    const after = compatibility({
      rowDigests: compatibility().rowDigests.map((row) =>
        row.table === 'public.workflow' ? { ...row, count: 2 } : row,
      ),
    });

    expect(() => assertWorkflowDataPreserved(compatibility(), after)).toThrow(
      'Adoption changed workflow data: public.workflow',
    );
  });

  it('refuses changed plugin, method or step rows', () => {
    const after = compatibility({
      rowDigests: compatibility().rowDigests.map((row) =>
        row.table === 'public.workflow_step' ? { ...row, digest: 'changed' } : row,
      ),
    });

    expect(() => assertWorkflowDataPreserved(compatibility(), after)).toThrow(
      'Adoption changed workflow data: public.workflow_step',
    );
  });

  it('refuses a changed workflow marker', () => {
    expect(() => assertWorkflowDataPreserved(compatibility(), compatibility({ mode: 'legacy-alias' }))).toThrow(
      'Adoption changed the workflow migration marker',
    );
  });
});
