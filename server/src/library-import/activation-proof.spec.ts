import { randomUUID } from 'node:crypto';
import { readLibraryImportActivation, sealLibraryImportActivation } from 'src/library-import/activation-proof.js';
import { libraryImportDerivedRunId } from 'src/library-import/derived-work.js';
import { at, context, manager, report } from 'test/fixtures/library-import-activation.js';

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

it('retains restricted-account counts without pretending their preserved passwords enable sign-in', () => {
  const value = {
    ...report(),
    owners: { ...report().owners, claimPending: 2, restricted: { owners: 1, preservedPasswords: 1 } },
  };
  const sealed = sealLibraryImportActivation(context, value, manager, at);
  expect(readLibraryImportActivation(sealed, context).report.owners).toMatchObject(value.owners);
  for (const restricted of [
    { owners: 3, preservedPasswords: 1 },
    { owners: 1, preservedPasswords: 2 },
  ])
    expect(() =>
      sealLibraryImportActivation(context, { ...value, owners: { ...value.owners, restricted } }, manager, at),
    ).toThrow('IMPORT_ACTIVATION_PROOF_INVALID');
});
