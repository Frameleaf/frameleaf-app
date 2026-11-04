import { hash } from 'bcrypt';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadLibraryImportBundle } from 'src/library-import/bundle-input.js';
import { writeLibraryImportBundle } from 'src/library-import/bundle-output.js';
import fixture from 'src/library-import/fixtures/manager-plan-v2.json' with { type: 'json' };
import { sourceKinds, type SourceKind } from 'src/library-import/manifest.js';
import { ImportedPassword, verifyImportedPassword } from 'src/library-import/passwords.js';

let stagingRoot: string;
beforeEach(async () => {
  stagingRoot = await realpath(await mkdtemp(join(tmpdir(), 'frameleaf-bundle-output-')));
  await writeFile(join(stagingRoot, 'previous.json'), 'retained', { mode: 0o600 });
});
afterEach(async () => rm(stagingRoot, { recursive: true, force: true }));
const records = [
  { table: 'photos', value: { id: 1n, caption: 'Edited caption\u0000retained', bytes: Buffer.from([0, 255]) } },
  { table: 'albums', value: { id: 'album-1', description: 'Manual album description' } },
];
const input = (kind: SourceKind = 'photoprism') => {
  const source = { ...fixture.plan.source, kind, version: 'synthetic-bundle-contract' };
  const plan = { ...fixture.plan, source, files: [] };
  return {
    stagingRoot,
    operationId: randomUUID(),
    destinationId: plan.destinationId,
    manifest: {
      format: 'frameleaf-library-import',
      version: 3,
      source,
      inventory: {
        complete: true,
        ownershipComplete: true,
        privacyComplete: true,
        writersStopped: true,
        revisionBefore: source.revision,
        revisionAfter: source.revision,
      },
      users: plan.owners.map((owner) => ({ id: owner.sourceId, name: owner.sourceId })),
      files: [],
      assets: [],
      albums: [],
      losses: [],
    },
    plan,
    owners: plan.owners.map((owner) => ({
      intent: {
        sourceUserId: owner.sourceId,
        email: owner.sourceId + '@example.test',
        login: {
          revision: source.revision,
          snapshotSha256: 'b'.repeat(64),
          accountEnabled: true,
          passwordLoginEnabled: true,
          secondFactorRequired: false,
          externalIdentityRequired: false,
          ownedLibraryAccess: 'full',
          otherRestrictions: 'none',
        },
        disposition: { kind: 'claim', reason: 'no-local-verifier', claimPermitted: true },
      },
    })),
    records,
  };
};
const load = (value: ReturnType<typeof input>, directory: string) =>
  loadLibraryImportBundle(
    {
      format: 'frameleaf-library-import-command',
      version: 1,
      operationId: value.operationId,
      destinationId: value.destinationId,
      bundleDirectory: directory,
      stateDirectory: join(stagingRoot, 'state'),
    },
    value.plan.source.kind,
  );

// Common serialization coverage only. Native schema, source fencing and privacy qualification remain adapter duties.
it.each(sourceKinds)('round-trips the common private bundle contract for %s', async (kind) => {
  const value = input(kind);
  const result = await writeLibraryImportBundle(value);
  const bundle = await load(value, result.bundleDirectory);
  await bundle.assertUnchanged();
  expect(bundle.context.manifest).toEqual(value.manifest);
  expect(bundle.context.plan).toEqual(value.plan);
  const restored = [];
  for await (const record of bundle.records()) restored.push(record);
  expect(restored).toEqual(records);
  expect(bundle.descriptor.rows).toBe('2');
  expect((await stat(result.bundleDirectory)).mode & 0o777).toBe(0o700);
  expect((await readdir(result.bundleDirectory)).sort()).toEqual([
    'archive.json',
    'archive.jsonl',
    'manifest.json',
    'owners.json',
    'plan.json',
  ]);
  for (const file of await readdir(result.bundleDirectory))
    expect((await stat(join(result.bundleDirectory, file))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(stagingRoot, 'previous.json'), 'utf8')).toBe('retained');
});

it('retains a compatible password capability privately with its explicit owner and operation binding', async () => {
  const value = input();
  const password = 'Synthetic migrated account password';
  const credential = await ImportedPassword.fromSource(
    {
      operationId: value.operationId,
      sourceUserId: value.plan.owners[0].sourceId,
      destinationUserId: value.plan.owners[0].destinationId,
    },
    'bcrypt',
    await hash(password, 4),
  );
  const owners = [
    { intent: { ...value.owners[0].intent, disposition: { kind: 'preserve' } }, credential },
    value.owners[1],
  ];
  const result = await writeLibraryImportBundle({ ...value, owners });
  expect(JSON.stringify(result)).not.toContain(credential.forImport());
  expect(JSON.stringify(result)).not.toContain(password);
  const bundle = await load(value, result.bundleDirectory);
  const restored = bundle.owners.find(
    (owner) => owner.intent.sourceUserId === value.plan.owners[0].sourceId,
  )!.credential!;
  expect(restored.forImport()).toBe(credential.forImport());
  expect(await verifyImportedPassword(password, restored.forImport())).toBe(true);
  expect(await verifyImportedPassword('wrong', restored.forImport())).toBe(false);
  expect(JSON.stringify(bundle.owners)).not.toContain(credential.forImport());
});

it.each([
  'missing owner',
  'wrong destination',
  'credential archive',
  'interrupted inventory',
  'shared staging',
  'symlink staging',
])('refuses %s without replacing earlier captures or exposing raw failure text', async (failure) => {
  const value = input();
  let candidate: Parameters<typeof writeLibraryImportBundle>[0] = value;
  if (failure === 'missing owner') candidate = { ...value, owners: value.owners.slice(1) };
  if (failure === 'wrong destination') candidate = { ...value, destinationId: randomUUID() };
  if (failure === 'credential archive')
    candidate = { ...value, records: [{ table: 'users', value: { password: 'private-verifier-value' } }] };
  if (failure === 'interrupted inventory')
    candidate = {
      ...value,
      records: (async function* () {
        yield records[0];
        throw new Error('private-verifier-value');
      })(),
    };
  if (failure === 'shared staging') await chmod(stagingRoot, 0o755);
  if (failure === 'symlink staging') {
    await symlink(stagingRoot, join(stagingRoot, 'alias'));
    candidate = { ...value, stagingRoot: join(stagingRoot, 'alias') };
  }
  const failureResult: unknown = await writeLibraryImportBundle(candidate).catch((error: unknown) => error);
  expect(failureResult).toMatchObject({ message: expect.stringMatching(/^Library import refused:/u) });
  expect(String(failureResult)).not.toContain('private-verifier-value');
  expect((await readdir(stagingRoot)).sort()).toEqual(
    failure === 'symlink staging' ? ['alias', 'previous.json'] : ['previous.json'],
  );
  expect(await readFile(join(stagingRoot, 'previous.json'), 'utf8')).toBe('retained');
});
