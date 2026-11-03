import { randomUUID } from 'node:crypto';
import { sealLibraryImportActivation } from 'src/library-import/activation-proof.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { at, context, manager, report } from 'test/fixtures/library-import-activation.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

const sealed = sealLibraryImportActivation(context, report(), manager, at);
const activated = () => ({
  family: 'library',
  status: 'activated',
  binding: context.binding,
  destinationId: context.destinationId,
  activation: structuredClone(sealed.payload),
  activationSha256: sealed.sha256,
});
const check = async (rows: Record<string, unknown>[]) => {
  const { db } = scriptedKysely(() => ({ rows }));
  try {
    const repository = new DatabaseRepository(db, { setContext: vi.fn() } as never, {} as never);
    await repository.assertImportActivated();
  } finally {
    await db.destroy();
  }
};

it.each(['copying', 'verifying', 'abandoned'])('blocks startup during a generic %s import', async (status) => {
  await expect(check([{ ...activated(), status }])).rejects.toThrow('DESTINATION_IMPORT_NOT_ACTIVATED');
});

it('permits a fresh database, legacy Immich activation and independently bound generic activation', async () => {
  await expect(check([])).resolves.toBeUndefined();
  await expect(check([{ family: 'immich', status: 'activated' }])).resolves.toBeUndefined();
  await expect(check([activated()])).resolves.toBeUndefined();
  await expect(check([{ family: 'immich', status: 'copying' }, activated()])).rejects.toThrow(
    'DESTINATION_IMPORT_NOT_ACTIVATED',
  );
});

it.each([
  ['missing proof', () => ({ ...activated(), activation: null, activationSha256: null })],
  ['corrupted digest', () => ({ ...activated(), activationSha256: '0'.repeat(64) })],
  ['foreign destination', () => ({ ...activated(), destinationId: randomUUID() })],
  ['foreign binding', () => ({ ...activated(), binding: { ...context.binding, operationId: randomUUID() } })],
  ['unknown version', () => ({ ...activated(), activation: { ...sealed.payload, version: 2 } })],
  ['missing destination', () => ({ ...activated(), destinationId: null })],
  ['unknown journal', () => ({ ...activated(), family: 'unknown' })],
] as const)('blocks %s without leaking protected identity', async (_, row) => {
  const result = check([row()]);
  await expect(result).rejects.toThrow('DESTINATION_IMPORT_NOT_ACTIVATED');
  await expect(result).rejects.not.toThrow('private source');
});
