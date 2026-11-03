import { randomUUID } from 'node:crypto';
import { readLibraryImportActivation, sealLibraryImportActivation } from 'src/library-import/activation-proof.js';
import { libraryImportDerivedRunId } from 'src/library-import/derived-work.js';
import { type ReviewedImportContext } from 'src/library-import/reviewed-inputs.js';

const context: ReviewedImportContext = {
  destinationId: randomUUID(),
  binding: {
    operationId: randomUUID(),
    manifestSha256: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    source: {
      kind: 'photoprism',
      version: 'synthetic',
      identity: 'private source',
      revision: 'frozen',
      schemaSha256: 'c'.repeat(64),
    },
  },
};
const at = '2026-11-03T07:00:00.000Z';
const manager = { installation: '110100000001', operationId: context.binding.operationId };
const report = () => {
  const common = {
    version: 1,
    operationId: context.binding.operationId,
    manifestSha256: context.binding.manifestSha256,
    planSha256: context.binding.planSha256,
  };
  return {
    ...common,
    format: 'frameleaf-library-import-verification',
    owners: {
      ...common,
      format: 'frameleaf-owner-reconciliation',
      owners: 2,
      preservedPasswords: 1,
      claimPending: 1,
      sha256: 'd'.repeat(64),
    },
    assets: {
      ...common,
      version: 2,
      format: 'frameleaf-asset-reconciliation',
      assets: 3,
      originals: 4,
      tagNodes: 1,
      tagAssignments: 2,
      bytes: '123',
      sha256: 'e'.repeat(64),
    },
    albums: {
      ...common,
      format: 'frameleaf-album-reconciliation',
      albums: 1,
      memberships: 3,
      grants: 1,
      sha256: 'f'.repeat(64),
    },
    stacks: { ...common, format: 'frameleaf-stack-reconciliation', stacks: 1, memberships: 2, sha256: '0'.repeat(64) },
    archive: {
      format: 'frameleaf-source-archive-verification',
      version: 1,
      operationId: common.operationId,
      records: '10',
      bytes: '200',
      sha256: '1'.repeat(64),
      sealed: true,
    },
  };
};

it('retains independently bound verification and Manager authority across JSONB key reordering', () => {
  const sealed = sealLibraryImportActivation(context, report(), manager, at);
  const reorder = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value)
        .toReversed()
        .map(([key, item]) => [key, reorder(item)]),
    );
  };
  const restored = readLibraryImportActivation({ ...sealed, payload: reorder(sealed.payload) }, context);
  expect(restored).toMatchObject({
    destinationId: context.destinationId,
    runId: libraryImportDerivedRunId(context.binding),
    manager,
    activatedAt: at,
  });
  expect(restored.report).toEqual(report());
  expect(JSON.stringify(restored.report)).not.toMatch(/private source|passwordHash|owner@example/);
});

it.each(['owners', 'assets', 'albums', 'stacks', 'archive'] as const)(
  'refuses a %s report from another operation',
  (part) => {
    const value = report();
    value[part].operationId = randomUUID();
    expect(() => sealLibraryImportActivation(context, value, manager, at)).toThrow('IMPORT_ACTIVATION_PROOF_INVALID');
  },
);

it('refuses corruption, destination replay and foreign Manager authority', () => {
  const sealed = sealLibraryImportActivation(context, report(), manager, at);
  expect(() => readLibraryImportActivation({ ...sealed, sha256: '0'.repeat(64) }, context)).toThrow(
    'IMPORT_ACTIVATION_PROOF_INVALID',
  );
  expect(() => readLibraryImportActivation(sealed, { ...context, destinationId: randomUUID() })).toThrow(
    'IMPORT_ACTIVATION_PROOF_INVALID',
  );
  expect(() => sealLibraryImportActivation(context, report(), { ...manager, operationId: randomUUID() }, at)).toThrow(
    'IMPORT_ACTIVATION_PROOF_INVALID',
  );
});

it('normalizes reviewed UUID aliases before deriving the durable run identity', () => {
  const alias = {
    destinationId: context.destinationId.toUpperCase(),
    binding: { ...context.binding, operationId: context.binding.operationId.toUpperCase() },
  };
  expect(sealLibraryImportActivation(alias, report(), manager, at)).toEqual(
    sealLibraryImportActivation(context, report(), manager, at),
  );
});

it('refuses private extras, incoherent account counts, unfinished archives and invalid report hashes', () => {
  for (const value of [
    { ...report(), passwordHash: 'private verifier' },
    { ...report(), owners: { ...report().owners, preservedPasswords: 3 } },
    { ...report(), archive: { ...report().archive, sealed: false } },
    { ...report(), assets: { ...report().assets, sha256: 'invalid' } },
  ])
    expect(() => sealLibraryImportActivation(context, value, manager, at)).toThrow('IMPORT_ACTIVATION_PROOF_INVALID');
});
