import { Kysely, RawNode, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, QueueName } from 'src/enum.js';
import { connectImportDatabase } from 'src/immich-import/database.js';
import { insertRunJobs } from 'src/immich-import/derived-work.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { QueueClaim } from 'src/queue/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let repository: JobRepository;
beforeAll(async () => {
  db = await getKyselyDB();
  repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
});
beforeEach(async () => {
  await sql`TRUNCATE job,job_run,job_queue,"user",cluster_group,physical_file,user_audit,
    frameleaf_library_import_mapping,frameleaf_library_import,frameleaf_immich_import CASCADE`.execute(db);
  await sql`INSERT INTO job_queue(name) VALUES(${QueueName.MetadataExtraction})`.execute(db);
});

const setup = async (count = 2) => {
  const plan = parseDestinationImportPlan(fixture.plan);
  plan.owners = [0, 1].map((index) => ({ sourceId: `owner-${index}`, destinationId: randomUUID() }));
  const original = plan.files[0];
  plan.files = Array.from({ length: count }, (_, index) => ({
    ...original,
    id: `file-${index}`,
    sourcePath: `original-${index}.jpg`,
    destinationPath: `owner-${index % 2}/original-${index}.jpg`,
    sha256: index.toString(16).padStart(64, '0'),
    sourceIdentity: { ...original.sourceIdentity, inode: String(index + 3) },
  }));
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
    users: plan.owners.map((owner) => ({ id: owner.sourceId, name: 'Private synthetic name' })),
    files: plan.files.map((file) => ({
      id: file.id,
      path: file.sourcePath,
      bytes: file.bytes,
      sha256: file.sha256,
      role: 'original',
    })),
    assets: Array.from({ length: count }, (_, index) => ({
      id: `source-${index}`,
      ownerId: plan.owners[index % 2].sourceId,
      fileIds: [plan.files[index].id],
      primaryFileId: plan.files[index].id,
      originalFileNames: { [plan.files[index].id]: 'original.jpg' },
      type: index % 2 ? 'VIDEO' : 'IMAGE',
      fileModifiedAt: '2020-01-02T03:04:05Z',
      visibility: 'timeline',
      metadata: {},
    })),
    albums: [],
    losses: [],
  });
  const binding = {
    operationId: randomUUID(),
    manifestSha256: manifestFingerprint(manifest),
    planSha256: destinationPlanFingerprint(plan),
    source: plan.source,
  };
  await sql`INSERT INTO frameleaf_library_import(operation_id,binding,status,reviewed_manifest,reviewed_plan)
    VALUES(${binding.operationId}::uuid,${JSON.stringify(binding)}::text::jsonb,'verifying',
      ${JSON.stringify(manifest)}::text::jsonb,${JSON.stringify(plan)}::text::jsonb)`.execute(db);
  for (const owner of plan.owners) {
    await sql`WITH g AS (INSERT INTO cluster_group DEFAULT VALUES RETURNING id)
      INSERT INTO "user"(id,email,"clusterGroupId") SELECT ${owner.destinationId}::uuid,
        ${`${owner.sourceId}@example.test`},id FROM g`.execute(db);
    await sql`INSERT INTO frameleaf_library_import_mapping(operation_id,entity_kind,source_id,destination_id,record_sha256)
      VALUES(${binding.operationId}::uuid,'owner',${owner.sourceId},${owner.destinationId}::uuid,${'a'.repeat(64)})`.execute(
      db,
    );
  }
  const ids: string[] = [];
  for (const [index, asset] of manifest.assets.entries()) {
    const id = randomUUID();
    ids.push(id);
    await sql`INSERT INTO asset(id,"ownerId",type,"originalPath","fileCreatedAt","fileModifiedAt",checksum,
      "checksumAlgorithm","originalFileName","localDateTime") VALUES(${id}::uuid,
      ${plan.owners[index % 2].destinationId}::uuid,${'type' in asset ? asset.type : ''},${`/fixture/original-${index}`},
      now(),now(),decode(${index.toString(16).padStart(64, '0')},'hex'),'sha256','original.jpg',now())`.execute(db);
    await sql`INSERT INTO frameleaf_library_import_mapping(operation_id,entity_kind,source_id,destination_id,record_sha256)
      VALUES(${binding.operationId}::uuid,'asset',${asset.id},${id}::uuid,${'b'.repeat(64)})`.execute(db);
  }
  const stageQueues = [
    [JobName.AssetExtractMetadata, QueueName.MetadataExtraction],
    [JobName.AssetGenerateThumbnails, QueueName.ThumbnailGeneration],
    [JobName.SmartSearch, QueueName.SmartSearch],
    [JobName.AssetDetectFaces, QueueName.FaceDetection],
    [JobName.AssetEncodeVideo, QueueName.VideoConversion],
    [JobName.PersonGenerateThumbnail, QueueName.ThumbnailGeneration],
  ] as const;
  for (const [jobName, queueName] of stageQueues)
    repository['handlers'][jobName] = { jobName, queueName, handler: vi.fn(), label: 'synthetic import' };
  return { context: { binding, destinationId: plan.destinationId }, plan, manifest, ids, stageQueues };
};

/** No queue would start any of the import's work. */
const expectNothingClaimable = async (stageQueues: ReadonlyArray<readonly [JobName, QueueName]>) => {
  const store = new SqlQueueStore(db);
  const worker = randomUUID();
  const queues = [...new Set(stageQueues.map(([, queue]) => queue))];
  await store.initialize(queues, worker);
  for (const queue of queues) expect(await store.claim(queue, worker)).toEqual([]);
};

it.each([0, 2, 301])('retains exactly the sealed %s-photo cohort and video work without activation', async (count) => {
  const { context, ids, stageQueues } = await setup(count);
  const id = await repository.prepareImportedLibraryWork(context);
  const snapshot = await sql`SELECT "itemKey",name AS stage,data AS selection FROM job ORDER BY name,"itemKey"`.execute(
    db,
  );
  const expected = ids.flatMap((asset, index) => [
    ...[JobName.AssetExtractMetadata, JobName.AssetGenerateThumbnails, JobName.SmartSearch].map((stage) => ({
      itemKey: asset,
      stage,
      selection: { id: asset },
    })),
    { itemKey: asset, stage: JobName.AssetDetectFaces, selection: { id: asset, preserveImportedFaces: true } },
    ...(index % 2 ? [{ itemKey: asset, stage: JobName.AssetEncodeVideo, selection: { id: asset } }] : []),
  ]);
  expect(snapshot.rows).toHaveLength(expected.length);
  expect(snapshot.rows).toEqual(expect.arrayContaining(expected));
  expect(await repository.prepareImportedLibraryWork(context)).toBe(id);
  expect(
    (await sql`SELECT "itemKey",name AS stage,data AS selection FROM job ORDER BY name,"itemKey"`.execute(db)).rows,
  ).toEqual(snapshot.rows);
  await expectNothingClaimable(stageQueues);
  expect((await sql`SELECT DISTINCT state,attempt,"availableAt"='infinity' AS held FROM job`.execute(db)).rows).toEqual(
    count === 0 ? [] : [{ state: 'pending', attempt: 0, held: true }],
  );
  const [{ selection, enumerationDone }] = (
    await sql<{
      selection: unknown;
      enumerationDone: boolean;
    }>`SELECT selection,"enumerationDone" FROM job_run`.execute(db)
  ).rows;
  expect(enumerationDone).toBe(false);
  expect(JSON.stringify(selection)).not.toMatch(/Private synthetic|fixture|synthetic-library|owner-0/);
});

it.each([0, 2])('recovers finalized held work after a lost acknowledgement with %s photos', async (count) => {
  const { context, stageQueues } = await setup(count);
  const id = await repository.prepareImportedLibraryWork(context);
  await new SqlQueueStore(db).finishEnumeration(id);
  const before = (await sql`SELECT * FROM job ORDER BY name,"itemKey"`.execute(db)).rows;
  const runBefore = (await sql`SELECT * FROM job_run WHERE id=${id}::uuid`.execute(db)).rows;
  expect(await repository.prepareImportedLibraryWork(context)).toBe(id);
  expect((await sql`SELECT * FROM job ORDER BY name,"itemKey"`.execute(db)).rows).toEqual(before);
  expect((await sql`SELECT * FROM job_run WHERE id=${id}::uuid`.execute(db)).rows).toEqual(runBefore);
  await expectNothingClaimable(stageQueues);
});

it('finalizes generic work through the repository without releasing it or duplicating a retry', async () => {
  const { context } = await setup();
  const id = await repository.dispatchImportedLibraryWork(context);
  expect(await repository.dispatchImportedLibraryWork(context)).toBe(id);
  expect((await sql`SELECT "enumerationDone" FROM job_run WHERE id=${id}::uuid`.execute(db)).rows).toEqual([
    { enumerationDone: true },
  ]);
  expect(
    (await sql`SELECT DISTINCT state,"availableAt"='infinity' AS held FROM job WHERE "runId"=${id}::uuid`.execute(db))
      .rows,
  ).toEqual([{ state: 'pending', held: true }]);
});

it('refuses finalized work that has been released or has processed an item', async () => {
  const { context } = await setup();
  const id = await repository.prepareImportedLibraryWork(context);
  await new SqlQueueStore(db).finishEnumeration(id);
  await sql`UPDATE job SET "availableAt"=now() WHERE "runId"=${id}::uuid`.execute(db);
  await expect(repository.prepareImportedLibraryWork(context)).rejects.toThrow('DERIVED_WORK_MANIFEST_MISMATCH');
  await sql`UPDATE job SET "availableAt"='infinity' WHERE "runId"=${id}::uuid`.execute(db);
  await sql`UPDATE job SET state='completed',"finishedAt"=now() WHERE "runId"=${id}::uuid`.execute(db);
  await expect(repository.prepareImportedLibraryWork(context)).rejects.toThrow('DERIVED_WORK_MANIFEST_MISMATCH');
});

const importConnection = async () => {
  const [{ name }] = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows;
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = '/' + name;
  return connectImportDatabase(url.href, false);
};

it('revalidates prepared work on the locked session without committing its outer transaction', async () => {
  const { context } = await setup();
  const id = await repository.dispatchImportedLibraryWork(context);
  const connection = await importConnection();
  try {
    await expect(repository.validateImportedLibraryWork(connection.db, context)).rejects.toThrow(
      'DERIVED_WORK_PREPARATION_FAILED',
    );
    await expect(
      connection.db.withSession!(async (session) => {
        await session.query('SELECT pg_advisory_lock($1::bigint)', [LIBRARY_IMPORT_LOCK]);
        await session.transaction(async (tx) => {
          expect(await repository.validateImportedLibraryWork(tx, context)).toBe(id);
          await tx.query('UPDATE job_run SET "finishedAt"=clock_timestamp() WHERE id=$1::uuid', [id]);
          throw new Error('synthetic outer activation failure');
        });
      }),
    ).rejects.toThrow('synthetic outer activation failure');
    expect((await sql`SELECT "finishedAt" FROM job_run WHERE id=${id}::uuid`.execute(db)).rows).toEqual([
      { finishedAt: null },
    ]);
    expect((await sql`SELECT 1 FROM job WHERE "availableAt"<>'infinity'`.execute(db)).rows).toEqual([]);
  } finally {
    await connection.close();
  }
});

it('takes no queue lock while waiting for the prepared run header', async () => {
  const { context } = await setup();
  const id = await repository.dispatchImportedLibraryWork(context);
  const connection = await importConnection();
  let validation: Promise<string> | undefined;
  try {
    await db.transaction().execute(async (header) => {
      await sql`SELECT id FROM job_run WHERE id=${id}::uuid FOR UPDATE`.execute(header);
      const { promise: waiting, resolve: reached } = Promise.withResolvers<void>();
      validation = connection.db.withSession!((session) =>
        session.transaction((tx) =>
          repository.validateImportedLibraryWork(
            {
              ...tx,
              query: (statement, parameters) => {
                if (statement.includes("SELECT selection #>> '{managerSetup,preparedAt}'")) reached();
                return tx.query(statement, parameters);
              },
            },
            context,
          ),
        ),
      );
      await waiting;
      await expect(
        db
          .transaction()
          .execute((worker) => sql`SELECT name FROM job_queue ORDER BY name FOR NO KEY UPDATE NOWAIT`.execute(worker)),
      ).resolves.toBeDefined();
    });
    expect(await validation).toBe(id);
  } finally {
    await validation?.catch(() => {});
    await connection.close();
  }
});

it('independently refuses a corrupt captured payload in the activation transaction', async () => {
  const { context } = await setup();
  const id = await repository.dispatchImportedLibraryWork(context);
  const before = (await sql`SELECT name,"itemKey",data FROM job ORDER BY name,"itemKey"`.execute(db)).rows;
  const connection = await importConnection();
  try {
    await expect(
      connection.db.withSession!((session) =>
        session.transaction(async (tx) => {
          await tx.query('UPDATE job SET data=\'{}\'::jsonb WHERE "runId"=$1::uuid', [id]);
          await repository.validateImportedLibraryWork(tx, context);
        }),
      ),
    ).rejects.toThrow('DERIVED_WORK_MANIFEST_MISMATCH');
    expect((await sql`SELECT name,"itemKey",data FROM job ORDER BY name,"itemKey"`.execute(db)).rows).toEqual(before);
  } finally {
    await connection.close();
  }
});

it.each(['copying', 'abandoned', 'activated'])('refuses %s preparation without retaining work', async (status) => {
  const { context } = await setup();
  await sql`UPDATE frameleaf_library_import SET status=${status}`.execute(db);
  await expect(repository.prepareImportedLibraryWork(context)).rejects.toThrow('IMPORT_NOT_VERIFYING');
  expect((await sql`SELECT 1 FROM job_run`.execute(db)).rows).toEqual([]);
});

it('rolls every captured stage back after an interruption and then recovers', async () => {
  const { context } = await setup();
  let captures = 0;
  const interrupted = db.withPlugin({
    transformQuery: ({ node }) => {
      if (
        node.kind === 'RawNode' &&
        (node as RawNode).sqlFragments.join(' ').startsWith('insert into job(') &&
        ++captures === 3
      )
        throw new Error('synthetic private source detail');
      return node;
    },
    transformResult: ({ result }) => Promise.resolve(result),
  });
  const broken = new JobRepository(
    {} as never,
    {} as never,
    {} as never,
    { setContext: vi.fn() } as never,
    interrupted,
  );
  Object.assign(broken['handlers'], repository['handlers']);
  await expect(broken.prepareImportedLibraryWork(context)).rejects.toThrow('DERIVED_WORK_PREPARATION_FAILED');
  expect(captures).toBe(3);
  expect((await sql`SELECT 1 FROM job_run UNION ALL SELECT 1 FROM job`.execute(db)).rows).toEqual([]);
  await repository.prepareImportedLibraryWork(context);
});

it('recovers committed work after reconnect without releasing it or inserting it twice', async () => {
  const { context } = await setup();
  const id = await repository.prepareImportedLibraryWork(context);
  const rows = (await sql`SELECT * FROM job ORDER BY name,"itemKey"`.execute(db)).rows;
  const [{ name }] = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows;
  const handlers = repository['handlers'];
  await db.destroy();
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = `/${name}`;
  db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: url.href }));
  repository = new JobRepository({} as never, {} as never, {} as never, { setContext: vi.fn() } as never, db);
  Object.assign(repository['handlers'], handlers);
  expect(await repository.prepareImportedLibraryWork(context)).toBe(id);
  expect((await sql`SELECT * FROM job ORDER BY name,"itemKey"`.execute(db)).rows).toEqual(rows);
  await expectNothingClaimable([[JobName.AssetExtractMetadata, QueueName.MetadataExtraction]]);
});

it('refuses concurrent importer access before preparing work', async () => {
  const { context } = await setup();
  await db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(${LIBRARY_IMPORT_LOCK}::bigint)`.execute(tx);
    await expect(repository.prepareImportedLibraryWork(context)).rejects.toThrow('IMPORT_ALREADY_RUNNING');
  });
  expect((await sql`SELECT 1 FROM job_run`.execute(db)).rows).toEqual([]);
});

it.each(['binding', 'destination', 'manifest', 'plan', 'missing inputs'] as const)(
  'refuses changed %s before capturing any stage',
  async (kind) => {
    const { context } = await setup();
    let code = 'IMPORT_PLAN_BINDING_CHANGED';
    switch (kind) {
      case 'binding': {
        context.binding.operationId = randomUUID();
        code = 'IMPORT_BINDING_CHANGED';
        break;
      }
      case 'destination': {
        context.destinationId = randomUUID();
        code = 'IMPORT_PLAN_DESTINATION_CHANGED';
        break;
      }
      case 'manifest': {
        await sql`UPDATE frameleaf_library_import SET reviewed_manifest=jsonb_set(reviewed_manifest,'{users,0,name}','"changed"')`.execute(
          db,
        );
        break;
      }
      case 'plan': {
        await sql`UPDATE frameleaf_library_import SET reviewed_plan=jsonb_set(reviewed_plan,'{roots,0,path}','"/changed-root"')`.execute(
          db,
        );
        break;
      }
      case 'missing inputs': {
        await sql`UPDATE frameleaf_library_import SET reviewed_manifest=null,reviewed_plan=null`.execute(db);
        code = 'IMPORT_REVIEWED_INPUTS_MISSING';
        break;
      }
    }
    await expect(repository.prepareImportedLibraryWork(context)).rejects.toThrow(code);
    expect((await sql`SELECT 1 FROM job_run`.execute(db)).rows).toEqual([]);
  },
);

it("selects each owner's own imported face even when a shared group features another owner's photo", async () => {
  const { context, ids, plan } = await setup();
  const group = randomUUID();
  const faces = [randomUUID(), randomUUID()];
  await sql`UPDATE "user" SET "clusterGroupId"=(SELECT "clusterGroupId" FROM "user"
    WHERE id=${plan.owners[0].destinationId}::uuid) WHERE id=${plan.owners[1].destinationId}::uuid`.execute(db);
  await sql`INSERT INTO person_group(id,"clusterGroupId") SELECT ${group}::uuid,"clusterGroupId" FROM "user"
    WHERE id=${plan.owners[0].destinationId}::uuid`.execute(db);
  for (const index of plan.owners.keys()) {
    await sql`INSERT INTO asset_face(id,"assetId","personGroupId","imageWidth","imageHeight",
      "boundingBoxX1","boundingBoxY1","boundingBoxX2","boundingBoxY2") VALUES(${faces[index]}::uuid,
      ${ids[index]}::uuid,${group}::uuid,100,100,10,10,50,50)`.execute(db);
  }
  for (const owner of plan.owners) {
    await sql`INSERT INTO person("ownerId","personGroupId","faceAssetId",name,"thumbnailPath")
      VALUES(${owner.destinationId}::uuid,${group}::uuid,${faces[1]}::uuid,'Manual person','')`.execute(db);
  }
  await repository.prepareImportedLibraryWork(context);
  expect(
    (
      await sql`SELECT "itemKey","rootItemKey",data AS selection FROM job WHERE name=${JobName.PersonGenerateThumbnail}`.execute(
        db,
      )
    ).rows,
  ).toEqual(
    expect.arrayContaining(
      plan.owners.map((owner, index) => ({
        itemKey: `${owner.destinationId}/${group}`,
        rootItemKey: ids[index],
        selection: {
          id: `${owner.destinationId}/${group}`,
          ownerId: owner.destinationId,
          personGroupId: group,
          selectionFaceId: faces[index],
        },
      })),
    ),
  );
});

it.each(['missing', 'extra', 'owner', 'type', 'duplicate'] as const)(
  'refuses a changed %s canonical cohort',
  async (kind) => {
    const { context, ids, plan } = await setup();
    switch (kind) {
      case 'missing': {
        await sql`DELETE FROM frameleaf_library_import_mapping WHERE source_id='source-0'`.execute(db);
        break;
      }
      case 'extra': {
        await sql`INSERT INTO frameleaf_library_import_mapping(operation_id,entity_kind,source_id,destination_id,record_sha256)
      VALUES(${context.binding.operationId}::uuid,'asset','unexpected',${ids[0]}::uuid,${'a'.repeat(64)})`.execute(db);
        break;
      }
      case 'owner': {
        await sql`UPDATE asset SET "ownerId"=${plan.owners[1].destinationId}::uuid WHERE id=${ids[0]}::uuid`.execute(
          db,
        );
        break;
      }
      case 'type': {
        await sql`UPDATE asset SET type='VIDEO' WHERE id=${ids[0]}::uuid`.execute(db);
        break;
      }
      case 'duplicate': {
        await sql`UPDATE frameleaf_library_import_mapping SET destination_id=${ids[0]}::uuid WHERE source_id='source-1'`.execute(
          db,
        );
        break;
      }
    }
    await expect(repository.prepareImportedLibraryWork(context)).rejects.toThrow('DERIVED_ASSET_COHORT_MISMATCH');
    expect((await sql`SELECT 1 FROM job_run`.execute(db)).rows).toEqual([]);
  },
);

it.each([
  'missing item',
  'extra item',
  'changed data',
  'released stage',
  'cancelled item',
  'started item',
  'foreign run',
] as const)('refuses %s on recovery without repairing immutable work', async (kind) => {
  const { context, ids } = await setup();
  const id = await repository.prepareImportedLibraryWork(context);
  switch (kind) {
    case 'missing item': {
      await sql`DELETE FROM job WHERE "itemKey"=${ids[0]} AND name=${JobName.SmartSearch}`.execute(db);
      break;
    }
    case 'extra item': {
      await sql`INSERT INTO job(id,queue,name,data,"safeToRetry",sensitive,"deadlineMs","availableAt","runId","itemKey","rootItemKey")
        VALUES(${randomUUID()}::uuid,${QueueName.SmartSearch},${JobName.SmartSearch},'{"id":"extra"}'::jsonb,true,false,
          60000,'infinity',${id}::uuid,'extra','extra')`.execute(db);
      break;
    }
    case 'changed data': {
      await sql`UPDATE job SET data='{}'::jsonb WHERE name=${JobName.AssetDetectFaces}`.execute(db);
      break;
    }
    case 'released stage': {
      await sql`UPDATE job SET "availableAt"=now() WHERE name=${JobName.SmartSearch}`.execute(db);
      break;
    }
    case 'cancelled item': {
      await sql`UPDATE job SET state='cancelled',"finishedAt"=now() WHERE name=${JobName.SmartSearch}`.execute(db);
      break;
    }
    case 'started item': {
      await sql`UPDATE job SET attempt=1 WHERE name=${JobName.SmartSearch}`.execute(db);
      break;
    }
    case 'foreign run': {
      await sql`UPDATE job_run SET kind='manual' WHERE id=${id}::uuid`.execute(db);
      break;
    }
  }
  const before = (await sql`SELECT * FROM job ORDER BY name,"itemKey"`.execute(db)).rows;
  await expect(repository.prepareImportedLibraryWork(context)).rejects.toThrow(
    kind === 'foreign run' ? 'DERIVED_RUN_IDENTITY_MISMATCH' : 'DERIVED_WORK_MANIFEST_MISMATCH',
  );
  expect((await sql`SELECT * FROM job ORDER BY name,"itemKey"`.execute(db)).rows).toEqual(before);
});
afterAll(async () => db?.destroy());

const run = async (kind: string) => {
  const id = randomUUID();
  await sql`INSERT INTO job_run(id,kind,selection) VALUES(${id}::uuid,${kind},'{}'::jsonb)`.execute(db);
  return id;
};
const claim = (runId: string | null = null): QueueClaim => ({
  id: randomUUID(),
  name: JobName.AssetExtractMetadata,
  queue: QueueName.MetadataExtraction,
  data: { id: randomUUID() },
  token: randomUUID(),
  workerId: randomUUID(),
  attempt: 1,
  startedAt: new Date(),
  runId,
  itemKey: null,
  deadlineMs: 30_000,
  safeToRetry: true,
});
const inspect = (input: QueueClaim) =>
  queueExecution.run(
    {
      claim: input,
      signal: new AbortController().signal,
      progress: vi.fn(),
      progressUnits: 0,
      adoptions: [],
      followups: [],
      buffering: false,
    },
    () => repository.isImportedMetadataJob(),
  );

it.each(['immich-import-derived', 'library-import-derived'])(
  'protects metadata executing directly in %s without rewriting retained intent data',
  async (kind) => {
    const id = await run(kind);
    await expect(inspect(claim(id))).resolves.toBe(true);
    expect((await sql`SELECT selection FROM job_run WHERE id=${id}::uuid`.execute(db)).rows).toEqual([
      { selection: {} },
    ]);
  },
);
it('reads import context through the active publication transaction', async () => {
  await db.transaction().execute(async (tx) => {
    const id = randomUUID();
    await sql`INSERT INTO job_run(id,kind,selection) VALUES(${id}::uuid,'library-import-derived','{}'::jsonb)`.execute(
      tx,
    );
    await expect(publicationTransaction.run(tx, () => inspect(claim(id)))).resolves.toBe(true);
  });
});
it('leaves ordinary and absent execution contexts unchanged', async () => {
  await expect(repository.isImportedMetadataJob()).resolves.toBe(false);
  await expect(inspect(claim(await run('manual')))).resolves.toBe(false);
  await expect(inspect(claim())).resolves.toBe(false);
  await expect(inspect(claim(randomUUID()))).resolves.toBe(false);
});
it('ignores a non-metadata execution even inside an import run', async () => {
  await expect(
    inspect({ ...claim(await run('library-import-derived')), name: JobName.AssetGenerateThumbnails }),
  ).resolves.toBe(false);
});
const metadataIntent = {
  name: JobName.AssetExtractMetadata,
  queue: QueueName.MetadataExtraction,
  data: {},
  safeToRetry: true,
  sensitive: false,
  deadlineMs: 30_000,
};
it('inserts held work inside the import transaction without letting it run', async () => {
  const id = randomUUID();
  await sql`INSERT INTO job_run(id,kind,selection) VALUES(${id}::uuid,'library-import-derived',
    ${JSON.stringify({ holds: { [JobName.AssetExtractMetadata]: 'setup' } })}::text::jsonb)`.execute(db);
  const asset = randomUUID();
  await db
    .transaction()
    .execute((tx) => insertRunJobs(tx, id, metadataIntent, tx.selectNoFrom(sql<string>`${asset}`.as('id'))));
  expect((await sql`SELECT "itemKey",state,"availableAt"='infinity' AS held FROM job`.execute(db)).rows).toEqual([
    { itemKey: asset, state: 'pending', held: true },
  ]);
  await expectNothingClaimable([[JobName.AssetExtractMetadata, QueueName.MetadataExtraction]]);
});
it('rolls back both the run and captured work when import preparation is interrupted', async () => {
  await expect(
    db.transaction().execute(async (tx) => {
      const id = randomUUID();
      await sql`INSERT INTO job_run(id,kind,selection) VALUES(${id}::uuid,'library-import-derived','{}'::jsonb)`.execute(
        tx,
      );
      await insertRunJobs(tx, id, metadataIntent, tx.selectNoFrom(sql<string>`${randomUUID()}`.as('id')));
      throw new Error('synthetic import preparation interrupted');
    }),
  ).rejects.toThrow('synthetic import preparation interrupted');
  expect(
    (
      await sql`SELECT (SELECT count(*)::int FROM job_run) AS runs,
        (SELECT count(*)::int FROM job) AS executions`.execute(db)
    ).rows,
  ).toEqual([{ runs: 0, executions: 0 }]);
});

it('retains immutable Manager setup authority with the held generic work', async () => {
  const { context } = await setup();
  const manager = { installation: '114900000001', operationId: context.binding.operationId };
  const id = await repository.prepareImportedLibraryWork(context, manager);
  const read = async () =>
    (
      await sql<{
        selection: { managerSetup: { installation: string; operationId: string; preparedAt: string; startedAt: null } };
      }>`SELECT selection FROM job_run WHERE id=${id}::uuid`.execute(db)
    ).rows[0].selection.managerSetup;
  const first = await read();
  expect(first).toEqual({ ...manager, preparedAt: expect.any(String), startedAt: null });
  expect(await repository.prepareImportedLibraryWork(context, manager)).toBe(id);
  expect(await read()).toEqual(first);
  await expect(
    repository.prepareImportedLibraryWork(context, { ...manager, installation: '114900000002' }),
  ).rejects.toThrow('DERIVED_MANAGER_SETUP_IDENTITY_MISMATCH');
  await expect(repository.prepareImportedLibraryWork(context)).rejects.toThrow(
    'DERIVED_MANAGER_SETUP_IDENTITY_MISMATCH',
  );
  expect(
    (await sql`SELECT 1 FROM job WHERE "runId"=${id}::uuid AND "availableAt"<>'infinity'`.execute(db)).rows,
  ).toEqual([]);
});

it.each(['installation', 'operation', 'extra-field'])(
  'refuses invalid Manager %s authority before retaining work',
  async (change) => {
    const { context } = await setup();
    const manager = { installation: '114900000001', operationId: context.binding.operationId };
    const invalid =
      change === 'installation'
        ? { ...manager, installation: 'invalid' }
        : change === 'operation'
          ? { ...manager, operationId: randomUUID() }
          : { ...manager, apiKey: 'synthetic-not-an-accepted-field' };
    await expect(repository.prepareImportedLibraryWork(context, invalid as never)).rejects.toThrow(
      'DERIVED_MANAGER_SETUP_IDENTITY_MISMATCH',
    );
    expect((await sql`SELECT 1 FROM job_run`.execute(db)).rows).toEqual([]);
    expect((await sql`SELECT 1 FROM job`.execute(db)).rows).toEqual([]);
  },
);
