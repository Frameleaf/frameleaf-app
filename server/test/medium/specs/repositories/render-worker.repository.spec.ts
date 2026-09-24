import { Kysely } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { MediaOperationDestination, MediaOperationKind } from 'src/enum.js';
import { RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const hour = 60 * 60 * 1000;

const setup = () => ({ sut: new RenderWorkerRepository(defaultDatabase) });

const newWorker = (sut: RenderWorkerRepository) =>
  sut.createWorker({
    name: `gpu ${randomUUID()}`,
    destination: MediaOperationDestination.Lan,
    kinds: [MediaOperationKind.StudioExport],
    enrolmentSecret: randomBytes(32),
    engineDigest: 'sha256:engine',
    conformanceMaxAgeMs: 24 * hour,
    maxConcurrentOperations: 1,
    maxWallClockMs: null,
    maxOutputBytes: null,
    gpuMemoryBytes: null,
    createdBy: null,
  });

const newSession = (sut: RenderWorkerRepository, workerId: string, expiresAt = new Date(Date.now() + hour)) =>
  sut.createSession({
    workerId,
    token: randomBytes(32),
    scopes: [MediaOperationKind.StudioExport],
    gpuMemoryBytes: null,
    engineDigest: 'sha256:engine',
    conformanceReportedAt: new Date(Date.now() - hour),
    expiresAt,
  });

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(RenderWorkerRepository.name, () => {
  describe('listLiveSessions (FL-42)', () => {
    it('lists unrevoked, unexpired sessions of active workers with their worker', async () => {
      const { sut } = setup();
      const worker = await newWorker(sut);
      const live = await newSession(sut, worker.id);
      await newSession(sut, worker.id, new Date(Date.now() - 1000));

      const found = (await sut.listLiveSessions()).filter((entry) => entry.worker.id === worker.id);

      expect(found).toHaveLength(1);
      expect(found[0].session).toEqual(live);
      expect(found[0].worker).toEqual(worker);
    });

    it('leaves out revoked sessions and every session of a revoked worker', async () => {
      const { sut } = setup();
      const kept = await newWorker(sut);
      await newSession(sut, kept.id);
      await sut.revokeSessions(kept.id);
      const revoked = await newWorker(sut);
      await newSession(sut, revoked.id);
      await sut.revokeWorker(revoked.id);

      const ids = new Set((await sut.listLiveSessions()).map((entry) => entry.worker.id));

      expect(ids.has(kept.id)).toBe(false);
      expect(ids.has(revoked.id)).toBe(false);
    });
  });
});
