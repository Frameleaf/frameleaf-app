import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { QueueName } from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { DesktopWorkerRepository } from 'src/repositories/desktop-worker.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** Several desktop helpers work one queue at once: each ready one lets one more job start. */
describe('desktop helpers widen a queue', () => {
  let db: Kysely<any>;
  let store: SqlQueueStore;
  const worker = randomUUID();
  beforeEach(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
    await store.initialize([QueueName.SmartSearch], worker);
    await store.setConcurrency(QueueName.SmartSearch, 1);
  });
  afterEach(async () => db.destroy());

  const helper = async (modelKey: string) => {
    const user = await mediumFactory.userWithClusterGroup(db, { isAdmin: true });
    await new UserRepository(db).create(user);
    await new DesktopAssistancePolicyService(new SystemMetadataRepository(db)).enable(user.id);
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
      modelKeys: [modelKey],
    }))!;
    // A helper that is polling for work is seen on every request it makes.
    await sql`UPDATE desktop_worker_session SET "lastSeenAt" = now() WHERE id = ${session.id}::uuid`.execute(db);
    return session.id;
  };
  const enqueue = (count: number) =>
    store.enqueue(
      Array.from({ length: count }, (_, i) => ({
        queue: QueueName.SmartSearch,
        name: 'SmartSearch',
        data: { id: randomUUID(), i },
        safeToRetry: true,
        sensitive: false,
        deadlineMs: 600_000,
      })),
    );

  it('starts one job per ready helper on top of the server’s own concurrency', async () => {
    await enqueue(6);
    await helper(`clip:${'a'.repeat(64)}`);
    await helper(`clip:${'b'.repeat(64)}`);
    await helper(`ocr:${'c'.repeat(64)}`); // holds no model for this queue
    const stale = await helper(`clip:${'d'.repeat(64)}`);
    await sql`UPDATE desktop_worker_session SET "lastSeenAt" = now() - interval '5 minutes' WHERE id = ${stale}::uuid`.execute(
      db,
    );
    expect(await store.claim(QueueName.SmartSearch, worker)).toHaveLength(3);
    expect(await store.claim(QueueName.SmartSearch, worker)).toHaveLength(0);
  });

  it('keeps the server’s own concurrency when no helper is ready', async () => {
    await enqueue(3);
    expect(await store.claim(QueueName.SmartSearch, worker)).toHaveLength(1);
  });
});
