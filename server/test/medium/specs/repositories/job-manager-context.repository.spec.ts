import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobName, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-71 (Job manager Account and Worker columns) and FL-76 (the administrator's PIN state): the
 * repository reads behind them, against a real database.
 */
let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database: defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return {
    ctx,
    users: new UserRepository(defaultDatabase),
    destinations: new MlDestinationRepository(defaultDatabase),
  };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe('Job manager context', () => {
  describe(UserRepository.prototype.getJobSubjectOwners.name, () => {
    it('resolves the owner of an asset, person, library or account, and ignores unknown ids', async () => {
      const { ctx, users } = setup();
      const { user } = await ctx.newUser({ name: 'Ada' });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const library = await defaultDatabase
        .insertInto('library')
        .values({ name: 'Archive', ownerId: user.id, importPaths: [], exclusionPatterns: [] })
        .returning('id')
        .executeTakeFirstOrThrow();
      const unknown = randomUUID();

      const owners = await users.getJobSubjectOwners([asset.id, person.personGroupId, library.id, user.id, unknown]);

      expect(owners).toHaveLength(4);
      expect(owners).toEqual(
        expect.arrayContaining(
          [asset.id, person.personGroupId, library.id, user.id].map((subjectId) => ({
            subjectId,
            ownerId: user.id,
            ownerName: 'Ada',
          })),
        ),
      );
    });

    it('returns nothing for no ids', async () => {
      const { users } = setup();
      await expect(users.getJobSubjectOwners([])).resolves.toEqual([]);
    });
  });

  describe(UserRepository.prototype.hasPinCode.name, () => {
    it('says whether a PIN is set without returning it, including for a deleted account', async () => {
      const { ctx, users } = setup();
      const { user: without } = await ctx.newUser();
      const { user: withPin } = await ctx.newUser({ pinCode: 'hashed-pin', deletedAt: new Date() });

      await expect(users.hasPinCode(without.id)).resolves.toBe(false);
      await expect(users.hasPinCode(withPin.id)).resolves.toBe(true);
      await expect(users.hasPinCode(randomUUID())).resolves.toBeUndefined();
    });
  });

  describe(MlDestinationRepository.prototype.getLatestJobDestinations.name, () => {
    it("names the destination of each job's latest accounted request", async () => {
      const { destinations } = setup();
      const local = await destinations.create({
        kind: MlDestinationKind.Local,
        name: `local ${randomUUID()}`,
        url: `http://${randomUUID()}:3003`,
        authToken: null,
        enabled: true,
        workloads: [MlWorkload.Clip],
        budgetLimitUsd: null,
        maxRuntimeMinutes: null,
        maxUploadBytes: null,
      });
      const pod = await destinations.create({
        kind: MlDestinationKind.RunPod,
        name: `pod ${randomUUID()}`,
        url: null,
        authToken: null,
        enabled: true,
        workloads: [MlWorkload.Clip],
        budgetLimitUsd: null,
        maxRuntimeMinutes: null,
        maxUploadBytes: null,
      });
      const [first, second, other] = [randomUUID(), randomUUID(), randomUUID()];
      const request = (destination: typeof local, jobId: string, startedAt: Date, jobName = JobName.SmartSearch) =>
        destinations.recordAccounting({
          destinationId: destination.id,
          destinationKind: destination.kind,
          workload: MlWorkload.Clip,
          jobId,
          jobName,
          bytesSent: 1,
          bytesReceived: 1,
          durationMs: 1,
          outcome: 'success',
          costUsd: null,
          startedAt,
          finishedAt: startedAt,
        });
      await request(local, first, new Date('2026-09-01T00:00:00Z'));
      await request(pod, first, new Date('2026-09-02T00:00:00Z'));
      await request(local, second, new Date('2026-09-03T00:00:00Z'));
      await request(pod, second, new Date('2026-09-04T00:00:00Z'), JobName.AssetDetectDuplicates);
      await request(pod, other, new Date('2026-09-05T00:00:00Z'));

      const rows = await destinations.getLatestJobDestinations([first, second], [JobName.SmartSearch]);

      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          {
            jobId: first,
            jobName: JobName.SmartSearch,
            destinationKind: MlDestinationKind.RunPod,
            destinationName: pod.name,
          },
          {
            jobId: second,
            jobName: JobName.SmartSearch,
            destinationKind: MlDestinationKind.Local,
            destinationName: local.name,
          },
        ]),
      );

      await destinations.delete(pod.id);
      await expect(destinations.getLatestJobDestinations([first], [JobName.SmartSearch])).resolves.toEqual([
        {
          jobId: first,
          jobName: JobName.SmartSearch,
          destinationKind: MlDestinationKind.RunPod,
          destinationName: null,
        },
      ]);
    });

    it('returns nothing without ids or names', async () => {
      const { destinations } = setup();
      await expect(destinations.getLatestJobDestinations([], [JobName.SmartSearch])).resolves.toEqual([]);
      await expect(destinations.getLatestJobDestinations([randomUUID()], [])).resolves.toEqual([]);
    });
  });
});
