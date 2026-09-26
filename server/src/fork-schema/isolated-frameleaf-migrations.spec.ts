import { planIsolatedFrameleafMigrations } from 'src/fork-schema/isolated-frameleaf-migrations.js';
import {
  CERTIFIED_TAG_MIGRATIONS,
  GENERIC_LEGACY_FORK_MIGRATIONS,
  POST_CERTIFIED_UPSTREAM_MIGRATIONS,
} from 'src/fork-schema/migration-manifest.js';
import { LEGACY_WORKFLOW_MIGRATION } from 'src/fork-schema/workflow-compatibility.js';

const bundled = [...GENERIC_LEGACY_FORK_MIGRATIONS].toSorted();
const CLASSIFICATION_RULE = '2100000000610-AddClassificationRule';
const FRAMELEAF_CLOUD = '2100000000620-FrameleafCloudMlDestination';
// A library cut over on a version that did not have 610 and 620 yet.
const cutoverLedger = bundled.filter((name) => name !== CLASSIFICATION_RULE && name !== FRAMELEAF_CLOUD);
const active = { phase: 'active', schemaVersion: '2' };
const handedOver = { phase: 'inactive', schemaVersion: '2' };

describe(planIsolatedFrameleafMigrations, () => {
  it('plans every bundled Frameleaf migration the cutover ledger lacks, in name order, once the library is active', () => {
    expect(
      planIsolatedFrameleafMigrations({
        context: 'startup',
        state: active,
        cutoverLedger: cutoverLedger.toReversed(),
        appliedLedger: [],
        bundled,
      }),
    ).toEqual({ pending: [CLASSIFICATION_RULE, FRAMELEAF_CLOUD], skipped: null });
  });

  it('treats migrations applied since the cutover as recorded', () => {
    expect(
      planIsolatedFrameleafMigrations({
        context: 'startup',
        state: active,
        cutoverLedger,
        appliedLedger: [CLASSIFICATION_RULE],
        bundled,
      }),
    ).toEqual({ pending: [FRAMELEAF_CLOUD], skipped: null });
  });

  it('plans nothing for a library that is current', () => {
    expect(
      planIsolatedFrameleafMigrations({
        context: 'startup',
        state: active,
        cutoverLedger,
        appliedLedger: [CLASSIFICATION_RULE, FRAMELEAF_CLOUD],
        bundled,
      }),
    ).toEqual({ pending: [], skipped: null });
  });

  it('plans a Frameleaf migration older than the newest recorded one when only it is missing', () => {
    const missing = bundled[3]!;
    expect(
      planIsolatedFrameleafMigrations({
        context: 'startup',
        state: active,
        cutoverLedger: bundled.filter((name) => name !== missing),
        appliedLedger: [],
        bundled,
      }),
    ).toEqual({ pending: [missing], skipped: null });
  });

  it('leaves a handed-over library for the return at startup', () => {
    expect(
      planIsolatedFrameleafMigrations({
        context: 'startup',
        state: handedOver,
        cutoverLedger,
        appliedLedger: [],
        bundled,
      }),
    ).toEqual({ pending: [CLASSIFICATION_RULE, FRAMELEAF_CLOUD], skipped: 'awaiting-return' });
  });

  it('applies them during the return of a handed-over library', () => {
    expect(
      planIsolatedFrameleafMigrations({
        context: 'return',
        state: handedOver,
        cutoverLedger,
        appliedLedger: [],
        bundled,
      }),
    ).toEqual({ pending: [CLASSIFICATION_RULE, FRAMELEAF_CLOUD], skipped: null });
  });

  it.each([
    { phase: 'active', schemaVersion: '2' },
    { phase: 'inactive', schemaVersion: '1' },
    { phase: 'legacy', schemaVersion: '1' },
    undefined,
  ])('refuses the return for state %o', (state) => {
    expect(() =>
      planIsolatedFrameleafMigrations({ context: 'return', state, cutoverLedger, appliedLedger: [], bundled }),
    ).toThrow('The return applies Frameleaf migrations only to a handed-over library');
  });

  it.each(['legacy', 'dual-write', 'failed'])('does not run in the unexpected schema version 2 phase %s', (phase) => {
    expect(
      planIsolatedFrameleafMigrations({
        context: 'startup',
        state: { phase, schemaVersion: '2' },
        cutoverLedger,
        appliedLedger: [],
        bundled,
      }),
    ).toEqual({ pending: [CLASSIFICATION_RULE, FRAMELEAF_CLOUD], skipped: 'unexpected-phase' });
  });

  it('waits for activation of a schema version 2 library in the ready phase', () => {
    expect(
      planIsolatedFrameleafMigrations({
        context: 'startup',
        state: { phase: 'ready', schemaVersion: '2' },
        cutoverLedger,
        appliedLedger: [],
        bundled,
      }),
    ).toEqual({ pending: [CLASSIFICATION_RULE, FRAMELEAF_CLOUD], skipped: 'awaiting-activation' });
  });

  it.each([
    { phase: 'inactive', schemaVersion: '1' },
    { phase: 'legacy', schemaVersion: '1' },
    { phase: 'active', schemaVersion: '1' },
    undefined,
  ])('leaves a library that was not cut over alone (state %o)', (state) => {
    expect(
      planIsolatedFrameleafMigrations({ context: 'startup', state, cutoverLedger: [], appliedLedger: [], bundled }),
    ).toEqual({ pending: [], skipped: 'not-cut-over' });
  });

  it('leaves a library cut over without the Frameleaf schema alone', () => {
    expect(
      planIsolatedFrameleafMigrations({
        context: 'startup',
        state: active,
        cutoverLedger: [],
        appliedLedger: [],
        bundled,
      }),
    ).toEqual({ pending: [], skipped: 'no-frameleaf-schema' });
  });

  it('refuses Frameleaf migrations recorded without a cutover ledger', () => {
    expect(() =>
      planIsolatedFrameleafMigrations({
        context: 'startup',
        state: active,
        cutoverLedger: [],
        appliedLedger: [CLASSIFICATION_RULE],
        bundled,
      }),
    ).toThrow('cut over without the Frameleaf schema');
  });

  it.each([
    ['cutover', { cutoverLedger: [...cutoverLedger, '2100000009990-FromANewerVersion'], appliedLedger: [] }],
    ['applied', { cutoverLedger, appliedLedger: ['2100000009990-FromANewerVersion'] }],
  ])('refuses a %s ledger that names a migration this version does not bundle', (_source, ledgers) => {
    expect(() => planIsolatedFrameleafMigrations({ context: 'startup', state: active, bundled, ...ledgers })).toThrow(
      'Frameleaf migration(s) 2100000009990-FromANewerVersion were already applied to this library but are not in this version',
    );
  });

  it.each([
    LEGACY_WORKFLOW_MIGRATION,
    CERTIFIED_TAG_MIGRATIONS[0]!,
    [...POST_CERTIFIED_UPSTREAM_MIGRATIONS][0]!,
    '9999999999999-Unknown',
  ])('refuses a provider that yields %s', (name) => {
    expect(() =>
      planIsolatedFrameleafMigrations({
        context: 'startup',
        state: active,
        cutoverLedger,
        appliedLedger: [],
        bundled: [...bundled, name],
      }),
    ).toThrow(`Frameleaf public migrations must not include ${name}`);
  });
});
