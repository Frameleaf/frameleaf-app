import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { QueueName, SystemMetadataKey } from 'src/enum.js';
import { SqlQueueStore, setDesktopQueueCapacity } from 'src/queue/store.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { DesktopMlRepository } from 'src/repositories/desktop-ml.repository.js';
import { DesktopWorkerRepository } from 'src/repositories/desktop-worker.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { DESKTOP_PRESENCE_SECONDS } from 'src/utils/desktop-worker-timing.js';
import { seedDesktopQualification } from 'test/desktop-qualification.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const clip = `clip:${'a'.repeat(64)}`;
const face = `face:${'b'.repeat(64)}`;
const ocr = `ocr:${'c'.repeat(64)}`;
const request = { config: {}, inputKind: 'image' as const };
const queues = [QueueName.SmartSearch, QueueName.FaceDetection, QueueName.Ocr];

/**
 * Several desktops work one queue at once: each one that can take the queue's work now lets one more job
 * start, on top of the administrator's concurrency (docs/desktop-worker-setup-protocol.md in frameleaf-desktop).
 */
describe('desktop helpers widen a queue', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  let policies: DesktopAssistancePolicyService;
  /** What the desktop service works out from the settings and routes: the model keys each queue's work needs now. */
  let scopes: Record<string, string[]>;
  const worker = randomUUID();
  beforeEach(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    policies = new DesktopAssistancePolicyService(new SystemMetadataRepository(db));
    await store.initialize(queues, worker);
    for (const queue of queues) await store.setConcurrency(queue, 1);
    scopes = { [QueueName.SmartSearch]: [clip], [QueueName.FaceDetection]: [face], [QueueName.Ocr]: [ocr] };
    const broker = new DesktopMlRepository(db);
    setDesktopQueueCapacity(async (queue) => (await broker.helperCapacity(scopes))[queue] ?? 0);
  });
  afterEach(async () => {
    setDesktopQueueCapacity(null);
    await db.destroy();
  });

  const helper = async (modelKeys: string[]) => {
    const user = await mediumFactory.userWithClusterGroup(db, { isAdmin: true });
    await new UserRepository(db).create(user);
    await policies.enable(user.id);
    const photo = await new SessionRepository(db).create({ userId: user.id, token: randomBytes(32) });
    const device = (await new DesktopDeviceRepository(db).enroll({
      userId: user.id,
      installationId: randomUUID(),
      publicKey: Buffer.alloc(32, 2).toString('base64'),
      name: 'helper',
      platform: 'windows',
      architecture: 'x86_64',
      mode: 'client-worker',
      state: 'preparing',
    }))!;
    const session = (await new DesktopWorkerRepository(db).issue({
      deviceId: device.id,
      authorizationEpoch: device.authorizationEpoch,
      photoSessionId: photo.id,
      tokenHash: randomBytes(32),
      modelKeys,
    }))!;
    const grant = {
      deviceId: device.id,
      authorizationEpoch: device.authorizationEpoch,
      sessionId: session.id,
      credentialHash: session.tokenHash,
    };
    for (const modelKey of modelKeys) await seedDesktopQualification(db, grant, { ...request, modelKey });
    // A helper that is polling for work is seen on every request it makes.
    await sql`UPDATE desktop_worker_session SET "lastSeenAt" = now() WHERE id = ${session.id}::uuid`.execute(db);
    return { ...grant, userId: user.id };
  };
  /** Jobs for photos of these accounts, in turn. */
  const enqueue = async (count: number, queue: QueueName, owners: string[]) => {
    const assets = new AssetRepository(db);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const asset = await assets.create(mediumFactory.assetInsert({ ownerId: owners[i % owners.length] }));
      ids.push(asset.id);
    }
    await store.enqueue(
      ids.map((id) => ({
        queue,
        name: queue,
        data: { id },
        safeToRetry: true,
        sensitive: false,
        deadlineMs: 600_000,
      })),
    );
  };
  const claimed = async (queue: QueueName = QueueName.SmartSearch) => (await store.claim(queue, worker)).length;
  /** The jobs a queue would start now, without starting them. */
  const capacity = async () => new DesktopMlRepository(db).helperCapacity(scopes);

  it('starts one job per desktop that can take the queue’s work now, on top of the server’s own concurrency', async () => {
    const first = await helper([clip]);
    const second = await helper([clip]);
    const other = await helper([ocr]); // holds no model for this queue
    const old = await helper([`clip:${'d'.repeat(64)}`]); // holds the model the settings asked for before, not the one they ask for now
    const stale = await helper([clip]);
    await sql`UPDATE desktop_worker_session SET "lastSeenAt" = now() - interval '5 minutes' WHERE id = ${stale.sessionId}::uuid`.execute(
      db,
    );
    const expired = await helper([clip]);
    await sql`UPDATE desktop_worker_qualification SET "createdAt" = now() - interval '2 hours',
      "expiresAt" = now() - interval '1 hour' WHERE "sessionId" = ${expired.sessionId}::uuid`.execute(db);
    const off = await helper([clip]);
    // Desktop AI processing is no longer on for this one's account
    await sql`UPDATE system_metadata SET value = value #- ${`{accounts,${off.userId}}`}::text[]
      WHERE key = ${SystemMetadataKey.FrameleafDesktopAssistance}`.execute(db);
    // every one of them has photos waiting, so only its own state decides whether it counts
    await enqueue(
      14,
      QueueName.SmartSearch,
      [first, second, other, old, stale, expired, off].map((desktop) => desktop.userId),
    );
    expect(await claimed()).toBe(3);
    expect(await claimed()).toBe(0);
  });

  it('keeps the server’s own concurrency when no helper is ready, or nothing counts them', async () => {
    const desktop = await helper([clip]);
    setDesktopQueueCapacity(null);
    await enqueue(3, QueueName.SmartSearch, [desktop.userId]);
    expect(await claimed()).toBe(1);
    expect((await capacity())[QueueName.SmartSearch]).toBe(1);
    // nothing registered (a process without the desktop service): the administrator's concurrency is the limit
    expect(await claimed()).toBe(0);
  });

  it('comes back down when the model changes, a qualification runs out or the desktop stops asking', async () => {
    const one = await helper([clip]);
    const two = await helper([clip]);
    const three = await helper([clip]);
    await enqueue(3, QueueName.SmartSearch, [one.userId, two.userId, three.userId]);
    expect((await capacity())[QueueName.SmartSearch]).toBe(3);
    // one desktop's qualification runs out
    await sql`UPDATE desktop_worker_qualification SET "createdAt" = now() - interval '2 hours',
      "expiresAt" = now() - interval '1 hour' WHERE "sessionId" = ${one.sessionId}::uuid`.execute(db);
    expect((await capacity())[QueueName.SmartSearch]).toBe(2);
    // one stops asking for work: silent for longer than the presence window
    await sql`UPDATE desktop_worker_session SET "lastSeenAt" = now() - make_interval(secs => ${DESKTOP_PRESENCE_SECONDS + 1})
      WHERE id = ${two.sessionId}::uuid`.execute(db);
    expect((await capacity())[QueueName.SmartSearch]).toBe(1);
    // silent for less than that, it still counts: a lease it holds is still good
    await sql`UPDATE desktop_worker_session SET "lastSeenAt" = now() - make_interval(secs => ${DESKTOP_PRESENCE_SECONDS - 5})
      WHERE id = ${three.sessionId}::uuid`.execute(db);
    expect((await capacity())[QueueName.SmartSearch]).toBe(1);
    // the administrator saves another search model: the desktops still hold the old one
    scopes[QueueName.SmartSearch] = [`clip:${'e'.repeat(64)}`];
    expect((await capacity())[QueueName.SmartSearch]).toBe(0);
    // or the queue's work would not go to desktops (this server first, and answering)
    scopes[QueueName.SmartSearch] = [];
    expect((await capacity())[QueueName.SmartSearch]).toBe(0);
    expect(await claimed()).toBe(1);
  });

  it('counts a desktop only when a photo it may take is coming up', async () => {
    const desktop = await helper([clip]);
    const someone = await helper([ocr]);
    // the next jobs are all another account's photos: this desktop would not take them, so starting one more
    // job would only put it on the next place in the order, on top of that place's own concurrency
    await enqueue(3, QueueName.SmartSearch, [someone.userId]);
    expect((await capacity())[QueueName.SmartSearch]).toBe(0);
    expect(await claimed()).toBe(1);
    // a computer that works on everyone's photos does take them
    await sql`UPDATE system_metadata SET value = jsonb_set(value, '{household}',
      ${JSON.stringify({ revisionId: randomUUID(), devices: [desktop.deviceId] })}::text::jsonb)
      WHERE key = ${SystemMetadataKey.FrameleafDesktopAssistance}`.execute(db);
    expect((await capacity())[QueueName.SmartSearch]).toBe(1);
    await sql`UPDATE system_metadata SET value = value - 'household'
      WHERE key = ${SystemMetadataKey.FrameleafDesktopAssistance}`.execute(db);
    expect((await capacity())[QueueName.SmartSearch]).toBe(0);
    // and so does its own account's photo, once one is among the next jobs
    await enqueue(1, QueueName.SmartSearch, [desktop.userId]);
    expect((await capacity())[QueueName.SmartSearch]).toBe(1);
    // a job that is not for a photo at all is nobody's
    scopes[QueueName.Ocr] = [clip];
    await store.enqueue([
      { queue: QueueName.Ocr, name: QueueName.Ocr, data: {}, safeToRetry: true, sensitive: false, deadlineMs: 600_000 },
    ]);
    expect((await capacity())[QueueName.Ocr]).toBe(0);
  });

  it('counts a desktop once: it holds one lease across all three queues', async () => {
    const { userId } = await helper([clip, face, ocr]);
    await enqueue(3, QueueName.FaceDetection, [userId]);
    await enqueue(3, QueueName.Ocr, [userId]);
    // a free desktop is counted for the first queue it can work that has jobs waiting
    expect(await capacity()).toEqual({ [QueueName.SmartSearch]: 0, [QueueName.FaceDetection]: 1, [QueueName.Ocr]: 0 });
    await enqueue(3, QueueName.SmartSearch, [userId]);
    expect(await capacity()).toEqual({ [QueueName.SmartSearch]: 1, [QueueName.FaceDetection]: 0, [QueueName.Ocr]: 0 });
    expect(await claimed(QueueName.SmartSearch)).toBe(2);
    expect(await claimed(QueueName.FaceDetection)).toBe(1);
    expect(await claimed(QueueName.Ocr)).toBe(1);
  });

  it('counts a desktop for the queue whose job it is running, so this server keeps its own slot there', async () => {
    const desktop = await helper([clip, face, ocr]);
    await enqueue(3, QueueName.FaceDetection, [desktop.userId]);
    await enqueue(3, QueueName.Ocr, [desktop.userId]);
    const [job] = await store.claim(QueueName.Ocr, worker, 1);
    // the job the desktop took became a desktop task, which it now holds a lease for
    const { rows } = await sql<{ id: string }>`
      INSERT INTO desktop_ml_task ("ownerId", "modelKey", "authorityKey", disclosure, config, "configSha256",
        "inputSha256", "inputKind", input, state, generation, "deadlineAt")
      VALUES (${desktop.userId}::uuid, ${ocr}, 'authority', ${JSON.stringify({ job: { id: job.id } })}::text::jsonb, '{}'::jsonb,
        ${'0'.repeat(64)}, ${'0'.repeat(64)}, 'image', 'x'::bytea, 'running', 1, now() + interval '5 minutes')
      RETURNING id`.execute(db);
    const { rows: attempts } = await sql<{ id: string }>`
      INSERT INTO desktop_ml_attempt ("taskId", "deviceId", "workerSessionId", "authorizationEpoch", generation, "expiresAt")
      VALUES (${rows[0].id}::uuid, ${desktop.deviceId}::uuid, ${desktop.sessionId}::uuid, ${desktop.authorizationEpoch}, 1,
        now() + interval '2 minutes') RETURNING id`.execute(db);
    await sql`UPDATE desktop_ml_task SET "attemptId" = ${attempts[0].id}::uuid WHERE id = ${rows[0].id}::uuid`.execute(
      db,
    );
    // busy there: not offered to faces, though faces come first and have jobs waiting
    expect(await capacity()).toEqual({ [QueueName.SmartSearch]: 0, [QueueName.FaceDetection]: 0, [QueueName.Ocr]: 1 });
    // this server's own job in that queue still starts beside the desktop's
    expect(await claimed(QueueName.Ocr)).toBe(1);
    expect(await claimed(QueueName.Ocr)).toBe(0);
    expect(await claimed(QueueName.FaceDetection)).toBe(1);
    // the lease ends: the desktop is free again, for the first queue with work
    await sql`UPDATE desktop_ml_attempt SET outcome = 'completed' WHERE id = ${attempts[0].id}::uuid`.execute(db);
    expect(await capacity()).toEqual({ [QueueName.SmartSearch]: 0, [QueueName.FaceDetection]: 1, [QueueName.Ocr]: 0 });
  });
});
