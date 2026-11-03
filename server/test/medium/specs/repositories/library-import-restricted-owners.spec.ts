import { hash } from 'bcrypt';
import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { connectImportDatabase } from 'src/immich-import/database.js';
import { LibraryImportController } from 'src/library-import/controller.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { ImportedPassword } from 'src/library-import/passwords.js';
import { EMPTY_SOURCE_ARCHIVE_HASH } from 'src/library-import/source-archive-codec.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

// Destination protocol checks, not source qualification evidence.
let db: Kysely<DB>, sourceHash: string;
let connection: ReturnType<typeof connectImportDatabase>;
const restrictions = [
  { reason: 'account-disabled', change: { accountEnabled: false } },
  { reason: 'password-login-disabled', change: { passwordLoginEnabled: false } },
  { reason: 'second-factor-required', change: { secondFactorRequired: true } },
  { reason: 'external-identity-required', change: { externalIdentityRequired: true } },
  { reason: 'restricted-library-access', change: { ownedLibraryAccess: 'restricted' } },
  { reason: 'other-source-restrictions', change: { otherRestrictions: 'present' } },
];
beforeAll(async () => {
  db = await getKyselyDB();
  sourceHash = await hash('synthetic restricted password', 9);
});
beforeEach(async () => {
  await sql`TRUNCATE public.job,public.job_run,public.job_queue,public.frameleaf_library_import_mapping,public.frameleaf_library_import,public.frameleaf_immich_import,public."user",public.cluster_group CASCADE`.execute(
    db,
  );
  await sql`WITH g AS (INSERT INTO public.cluster_group DEFAULT VALUES RETURNING id)
    INSERT INTO public."user"(email,"clusterGroupId","isAdmin") SELECT 'bootstrap@example.test',id,true FROM g`.execute(
    db,
  );
  const [{ name }] = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows;
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = '/' + name;
  connection = connectImportDatabase(url.href, false);
});
afterEach(async () => {
  await connection?.close();
});
afterAll(async () => {
  await db?.destroy();
});
const jobs = () => {
  const repository = new JobRepository({} as never, {} as never, {} as never, { setContext: () => {} } as never, db);
  for (const [jobName, queueName] of [
    [JobName.AssetExtractMetadata, QueueName.MetadataExtraction],
    [JobName.AssetGenerateThumbnails, QueueName.ThumbnailGeneration],
    [JobName.SmartSearch, QueueName.SmartSearch],
    [JobName.AssetDetectFaces, QueueName.FaceDetection],
    [JobName.AssetEncodeVideo, QueueName.VideoConversion],
    [JobName.PersonGenerateThumbnail, QueueName.ThumbnailGeneration],
  ] as const)
    repository['handlers'][jobName] = { jobName, queueName, handler: vi.fn(), label: 'synthetic import' };
  return repository;
};
async function setup(restriction?: { reason: string; change: Record<string, unknown> }, preserve = false) {
  const plan = parseDestinationImportPlan(fixture.plan);
  plan.files = [];
  plan.owners = ['restricted', 'claim'].map((sourceId) => ({ sourceId, destinationId: randomUUID() }));
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 3,
    source: plan.source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: plan.source.revision,
      revisionAfter: plan.source.revision,
    },
    users: plan.owners.map(({ sourceId }) => ({ id: sourceId, name: 'Source ' + sourceId })),
    files: [],
    assets: [],
    albums: [],
    losses: [],
  });
  const binding = {
    operationId: randomUUID(),
    manifestSha256: manifestFingerprint(manifest),
    planSha256: destinationPlanFingerprint(plan),
    source: plan.source,
  };
  const context = { binding, plan, manifest, destinationId: plan.destinationId };
  const login = {
    revision: plan.source.revision,
    snapshotSha256: 'e'.repeat(64),
    accountEnabled: true,
    passwordLoginEnabled: true,
    secondFactorRequired: false,
    externalIdentityRequired: false,
    ownedLibraryAccess: 'full',
    otherRestrictions: 'none',
  };
  const credential = preserve
    ? await ImportedPassword.fromSource(
        {
          operationId: binding.operationId,
          sourceUserId: 'restricted',
          destinationUserId: plan.owners[0].destinationId,
        },
        'bcrypt',
        sourceHash,
      )
    : undefined;
  const owners = [
    {
      intent: {
        sourceUserId: 'restricted',
        email: 'restricted@example.test',
        login: { ...login, ...restriction?.change },
        disposition: restriction
          ? {
              kind: 'restricted',
              reasons: [restriction.reason],
              acknowledged: true,
              credential: preserve ? 'preserve' : 'unavailable',
            }
          : preserve
            ? { kind: 'preserve' }
            : { kind: 'claim', reason: 'no-local-verifier', claimPermitted: true },
      },
      ...(credential ? { credential } : {}),
    },
    {
      intent: {
        sourceUserId: 'claim',
        email: 'claim@example.test',
        login,
        disposition: { kind: 'claim', reason: 'no-local-verifier', claimPermitted: true },
      },
    },
  ];
  const controller = new LibraryImportController(connection.db, context);
  await controller.run(
    owners,
    { format: 'frameleaf-source-archive', version: 1, rows: '0', sha256: EMPTY_SOURCE_ARCHIVE_HASH },
    [],
  );
  return {
    context,
    owners,
    controller,
    credential,
    ownerId: plan.owners[0].destinationId,
    claimId: plan.owners[1].destinationId,
  };
}
async function claimLink(id: string) {
  const user = await db.selectFrom('user').select(['email']).where('id', '=', id).executeTakeFirstOrThrow();
  const repository = new UserRepository(db);
  const token = createHash('sha256').update(randomUUID()).digest();
  await repository.setPasswordLink(id, user.email, token, new Date(Date.now() + 60_000));
  return { repository, token };
}
it.each(restrictions.flatMap((restriction) => [false, true].map((preserve) => ({ ...restriction, preserve }))))(
  'keeps $reason owners inactive with compatible password preservation=$preserve',
  async ({ reason, change, preserve }) => {
    const f = await setup({ reason, change }, preserve);
    expect((await f.controller.verify()).owners).toMatchObject({
      owners: 2,
      preservedPasswords: preserve ? 1 : 0,
      claimPending: 2,
      restricted: { owners: 1, preservedPasswords: preserve ? 1 : 0 },
    });
    const activated = await f.controller.activate(jobs(), async () => {});
    expect(activated.report.owners).toMatchObject({ restricted: { owners: 1, preservedPasswords: preserve ? 1 : 0 } });
    const owner = await db.selectFrom('user').selectAll().where('id', '=', f.ownerId).executeTakeFirstOrThrow();
    expect(owner).toMatchObject({ isAdmin: false, importClaimPending: true, shouldChangePassword: !preserve });
    if (preserve)
      expect(await new CryptoRepository().compareBcrypt('synthetic restricted password', owner.password!)).toBe(true);
    else expect(owner.password).toBeNull();
    const { repository, token } = await claimLink(f.ownerId);
    expect(await repository.getByPasswordLink(token)).toBeUndefined();
    expect(await repository.redeemImportedAccountClaim(token, 'synthetic changed hash')).toBeUndefined();
    expect(
      await db
        .selectFrom('user')
        .select(['password', 'importClaimPending'])
        .where('id', '=', f.ownerId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ password: owner.password, importClaimPending: true });
    const allowed = await claimLink(f.claimId);
    expect(await allowed.repository.getByPasswordLink(allowed.token)).toMatchObject({ id: f.claimId });
    expect(
      await allowed.repository.redeemImportedAccountClaim(allowed.token, 'synthetic destination hash'),
    ).toMatchObject({ id: f.claimId });
  },
);
it('does not claim a generic owner before verified activation', async () => {
  const f = await setup();
  const { repository, token } = await claimLink(f.claimId);
  expect(await repository.redeemImportedAccountClaim(token, 'synthetic changed hash')).toBeUndefined();
  expect(
    (await db.selectFrom('user').select('importClaimPending').where('id', '=', f.claimId).executeTakeFirstOrThrow())
      .importClaimPending,
  ).toBe(true);
});
it.each(['missing-policy', 'changed-policy', 'missing-mapping', 'changed-mapping', 'changed-proof', 'missing-inputs'])(
  'refuses a claim when generic retained evidence is $0',
  async (damage) => {
    const f = await setup();
    await f.controller.activate(jobs(), async () => {});
    const { repository, token } = await claimLink(f.claimId);
    switch (damage) {
      case 'missing-policy': {
        await sql`UPDATE frameleaf_library_import SET private_owners=NULL,private_owners_sha256=NULL`.execute(db);
        break;
      }
      case 'changed-policy': {
        await sql`UPDATE frameleaf_library_import SET private_owners_sha256=${'0'.repeat(64)}`.execute(db);
        break;
      }
      case 'missing-mapping': {
        await sql`DELETE FROM frameleaf_library_import_mapping WHERE destination_id=${f.claimId}::uuid`.execute(db);
        break;
      }
      case 'changed-mapping': {
        await sql`UPDATE frameleaf_library_import_mapping SET record_sha256=${'0'.repeat(64)} WHERE destination_id=${f.claimId}::uuid`.execute(
          db,
        );
        break;
      }
      case 'changed-proof': {
        await sql`UPDATE frameleaf_library_import SET activation_sha256=${'0'.repeat(64)}`.execute(db);
        break;
      }
      case 'missing-inputs': {
        await sql`UPDATE frameleaf_library_import SET reviewed_manifest=NULL,reviewed_plan=NULL`.execute(db);
        break;
      }
    }
    expect(await repository.redeemImportedAccountClaim(token, 'synthetic changed hash')).toBeUndefined();
    expect(
      (await db.selectFrom('user').select('importClaimPending').where('id', '=', f.claimId).executeTakeFirstOrThrow())
        .importClaimPending,
    ).toBe(true);
  },
);

it('does not silently discard or contradict a restricted owner credential disposition', async () => {
  const f = await setup(restrictions[2], true);
  const missing = f.owners.map(({ intent }) => ({ intent }));
  await expect(f.controller.preflight(missing)).rejects.toThrow('OWNER_CREDENTIAL_DISPOSITION_MISMATCH');
  const inconsistent = [
    {
      ...f.owners[0],
      intent: {
        ...f.owners[0].intent,
        disposition: {
          kind: 'restricted',
          reasons: ['second-factor-required'],
          acknowledged: true,
          credential: 'unavailable',
        },
      },
    },
    f.owners[1],
  ];
  await expect(f.controller.preflight(inconsistent)).rejects.toThrow('OWNER_CREDENTIAL_DISPOSITION_MISMATCH');
  expect(
    (await db.selectFrom('user').select('password').where('id', '=', f.ownerId).executeTakeFirstOrThrow()).password,
  ).toBe(f.credential!.forImport());
});
