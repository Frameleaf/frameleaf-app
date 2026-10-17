import { DummyDriver, Kysely, PostgresDialect } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  ICloudScheduledStagingRepository,
  ScheduledStagingInput,
} from 'src/repositories/icloud-scheduled-staging.repository.js';
import { ICloudResource } from 'src/repositories/icloud-sync.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { DB } from 'src/schema/index.js';
import {
  ScheduledPrivateCopyRecord,
  ScheduledPrivateWorkRecord,
  privateCopyScope,
  privateWorkScope,
} from 'src/utils/icloud-private-copy.js';
import { canonicalJson } from 'src/utils/studio-project.js';

// Actual work producer/finisher and query compiler; admission is isolated, no SQL executes.
async function fixture(disposedCopy = false) {
  const seals = new Map<string, { scope: string; payload: string }>();
  const transport = {
    withSessionCrypto<T>(action: () => Promise<T>) {
      return action();
    },
    encodeSession: (scope: string, payload: unknown) => {
      const seal = randomUUID();
      seals.set(seal, { scope, payload: canonicalJson(payload) });
      return Promise.resolve(seal);
    },
    decodeSession: (scope: string, seal: string) => {
      const record = seals.get(seal);
      if (!record || record.scope !== scope) return Promise.reject(new Error('unproven'));
      return Promise.resolve(JSON.parse(record.payload));
    },
  } as unknown as ICloudTransportRepository;
  const input: ScheduledStagingInput = {
    ownerId: randomUUID(),
    resource: { id: randomUUID(), leaseToken: randomUUID() },
    authority: {
      purpose: 'scheduled-weekly',
      auditRequestId: randomUUID(),
      operationId: randomUUID(),
      operationClaimToken: randomUUID(),
    },
  };
  const oldItem = randomUUID();
  const work: ScheduledPrivateWorkRecord = {
    payload: {
      version: 1,
      purpose: 'scheduled-weekly-private-work',
      generation: randomUUID(),
      ownerId: input.ownerId,
      resourceId: input.resource.id,
      auditRequestId: input.authority.auditRequestId,
      operationId: input.authority.operationId!,
      operationClaimToken: input.authority.operationClaimToken!,
      resourceLeaseToken: input.resource.leaseToken,
      itemClaimId: oldItem,
      copyGeneration: disposedCopy ? randomUUID() : null,
      pending: [],
      settled: true,
    },
    seal: null,
  };
  work.seal = await transport.encodeSession(privateWorkScope(work.payload), work.payload);
  const resource = {
    id: input.resource.id,
    ownerId: input.ownerId,
    auditRequestId: input.authority.auditRequestId,
    connectionId: randomUUID(),
    sourceAssetId: 'ITEM',
    expectedSize: 10,
    stagingPath: '/owned/complete',
    reservedBytes: 10,
    verification: { auditOwnedWork: work, unrelatedWitness: true },
  } as unknown as ICloudResource;
  let copy: ScheduledPrivateCopyRecord | undefined;
  if (disposedCopy) {
    const promotedPath = '/owned/.icloud-recovery/recovery';
    copy = {
      payload: {
        version: 1,
        purpose: 'scheduled-weekly-private-copy',
        generation: work.payload.copyGeneration!,
        ownerId: input.ownerId,
        resourceId: resource.id,
        connectionId: resource.connectionId,
        auditRequestId: input.authority.auditRequestId,
        operationId: input.authority.operationId!,
        operationClaimToken: input.authority.operationClaimToken!,
        resourceLeaseToken: input.resource.leaseToken,
        itemClaimId: oldItem,
        sourceAssetId: resource.sourceAssetId,
        stagingPath: resource.stagingPath!,
        promotedPath,
        temporaryPath: `${promotedPath}.${work.payload.copyGeneration}.partial`,
        reservedCopyBytes: 10,
        identity: { dev: 1, ino: 2, uid: 501, size: 10 },
        promoted: true,
        settled: true,
        disposed: true,
      },
      pending: [],
      seal: null,
    };
    copy.seal = await transport.encodeSession(privateCopyScope(copy.payload), copy.payload);
    resource.verification = { ...resource.verification, auditPrivateCopy: copy };
  }
  const writes: string[] = [];
  class Driver extends DummyDriver {
    acquireConnection() {
      return Promise.resolve({
        executeQuery: (query: { sql: string; parameters: readonly unknown[] }) => {
          if (query.sql.startsWith('UPDATE')) {
            writes.push(query.sql);
            const fields = query.parameters.find(
              (value) => typeof value === 'string' && value.startsWith('{"auditOwnedWork"'),
            );
            if (fields) resource.verification = { ...resource.verification, ...JSON.parse(fields as string) };
            return Promise.resolve({ rows: [{ id: resource.id }] } as never);
          }
          return Promise.resolve({ rows: [resource] } as never);
        },
        async *streamQuery(): AsyncGenerator<never> {},
      });
    }
  }
  const dialect = new PostgresDialect({ pool: {} as never });
  dialect.createDriver = () => new Driver();
  const db = new Kysely<DB>({ dialect });
  const sut = new ICloudScheduledStagingRepository(db, transport);
  let itemClaimId = oldItem;
  const admission = sut as unknown as {
    admitted: (
      input: ScheduledStagingInput,
      action: (db: Kysely<DB>, admission: never) => Promise<boolean>,
    ) => Promise<boolean | undefined>;
  };
  vi.spyOn(admission, 'admitted').mockImplementation((_input, action) =>
    action(db, { resource, guarded: { request: { itemClaimId } } } as never),
  );
  const renew = () => {
    input.resource.leaseToken = randomUUID();
    input.authority.operationClaimToken = randomUUID();
    itemClaimId = randomUUID();
  };
  return { sut, db, input, resource, transport, work, copy, writes, renew, item: () => itemClaimId };
}

describe('private work settled executor renewal', () => {
  it.each([false, true])(
    'starts and finishes twelve renewed executors preserving disposed copy: %s',
    async (withCopy) => {
      const f = await fixture(withCopy);
      const originalCopy = structuredClone(f.copy);
      try {
        for (let index = 0; index < 12; index++) {
          const prior = f.resource.verification!.auditOwnedWork as ScheduledPrivateWorkRecord;
          f.renew();
          const token = await f.sut.beginPrivateWork(f.input);
          const current = f.resource.verification!.auditOwnedWork as ScheduledPrivateWorkRecord;
          expect(current.payload.generation).not.toBe(prior.payload.generation);
          expect(current.payload).toMatchObject({
            resourceLeaseToken: f.input.resource.leaseToken,
            operationClaimToken: f.input.authority.operationClaimToken,
            itemClaimId: f.item(),
            pending: [token],
            settled: false,
          });
          // Raw SELECT * returns bigint expectedSize as text; admitted() casts it to float8.
          (f.resource as unknown as { expectedSize: string }).expectedSize = '10';
          await f.sut.finishPrivateWork(f.input, token);
          f.resource.expectedSize = 10;
          expect((f.resource.verification!.auditOwnedWork as ScheduledPrivateWorkRecord).payload).toMatchObject({
            pending: [],
            settled: true,
          });
          expect(f.resource.verification!.auditPrivateCopy).toEqual(originalCopy);
          expect(f.resource.reservedBytes).toBe(10);
          expect(f.resource.verification!.unrelatedWitness).toBe(true);
        }
      } finally {
        await f.db.destroy();
        vi.restoreAllMocks();
      }
    },
  );

  it.each([
    'pending',
    'malformed',
    'unknown-seal',
    'foreign-obligation',
    'active-copy',
    'pending-copy',
    'unknown-copy-seal',
    'foreign-copy',
    'unknown-copy',
    'unknown-input-history',
  ] as const)('refuses renewed %s evidence without writes', async (reason) => {
    const f = await fixture(['active-copy', 'pending-copy', 'unknown-copy-seal', 'foreign-copy'].includes(reason));
    switch (reason) {
      case 'unknown-seal':
      case 'unknown-copy-seal': {
        break;
      }
      case 'pending': {
        f.work.payload.pending = [randomUUID()];
        f.work.payload.settled = false;
        break;
      }
      case 'malformed': {
        f.work.payload.generation = 'unknown';
        break;
      }
      case 'foreign-obligation': {
        f.work.payload.operationId = randomUUID();
        break;
      }
      case 'active-copy': {
        f.copy!.payload.disposed = false;
        break;
      }
      case 'pending-copy': {
        f.copy!.pending = [randomUUID()];
        break;
      }
      case 'foreign-copy': {
        f.copy!.payload.resourceId = randomUUID();
        break;
      }
      case 'unknown-input-history': {
        f.resource.verification!.auditValidationInputs = { unknown: true };
        break;
      }
      case 'unknown-copy': {
        f.resource.verification!.auditPrivateCopy = { unknown: true };
        break;
      }
    }
    f.work.seal =
      reason === 'unknown-seal'
        ? 'unknown'
        : await f.transport.encodeSession(privateWorkScope(f.work.payload), f.work.payload);
    if (f.copy)
      f.copy.seal =
        reason === 'unknown-copy-seal'
          ? 'unknown'
          : await f.transport.encodeSession(privateCopyScope(f.copy.payload), f.copy.payload);
    f.renew();
    try {
      await expect(f.sut.beginPrivateWork(f.input)).rejects.toThrow();
      expect(f.writes).toEqual([]);
    } finally {
      await f.db.destroy();
      vi.restoreAllMocks();
    }
  });
});
