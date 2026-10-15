import { DummyDriver, Kysely, PostgresDialect } from 'kysely';
import { ICloudAuditRepository } from 'src/repositories/icloud-audit.repository.js';
import { ICloudScheduledStagingRepository } from 'src/repositories/icloud-scheduled-staging.repository.js';
import { ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { DB } from 'src/schema/index.js';

// The real repositories compile their queries; no database, pool, or SQL execution is used.
function fixture(rows: (query: string) => object[]) {
  const queries: string[] = [];
  class Driver extends DummyDriver {
    acquireConnection() {
      return Promise.resolve({
        executeQuery: (query: { sql: string }) => {
          queries.push(query.sql);
          return Promise.resolve({ rows: rows(query.sql) } as never);
        },
        async *streamQuery(): AsyncGenerator<never> {},
      });
    }
  }
  const dialect = new PostgresDialect({ pool: {} as never });
  dialect.createDriver = () => new Driver();
  const db = new Kysely<DB>({ dialect });
  return { db, queries };
}

const resource = {
  id: '00000000-0000-4000-8000-000000000001',
  ownerId: '00000000-0000-4000-8000-000000000002',
  connectionId: '00000000-0000-4000-8000-000000000003',
  leaseToken: '00000000-0000-4000-8000-000000000004',
  auditRequestId: '00000000-0000-4000-8000-000000000005',
  sourceAssetId: 'ITEM',
  verification: { auditValidationInputs: { unknown: true } },
  status: 'failed',
  reservedBytes: 20,
  stagingPath: '/owned/source',
  pendingJobs: [],
  attempts: 0,
};

describe('validation input release boundaries', () => {
  it('restart progress rejects an unauthenticated disposed label without changing charge or scheduling', async () => {
    const current = {
      ...resource,
      verification: { auditValidationInputs: { payload: { current: { payload: { state: 'disposed' } } } } },
    };
    const f = fixture(() => [current]);
    const sut = new ICloudScheduledStagingRepository(f.db, {} as never);
    try {
      expect(
        await sut.deferDisposedValidationInput({
          ownerId: resource.ownerId,
          resource: { id: resource.id, leaseToken: resource.leaseToken },
          authority: {
            purpose: 'scheduled-weekly',
            auditRequestId: resource.auditRequestId,
            operationId: resource.id,
            operationClaimToken: resource.leaseToken,
          },
        }),
      ).toBe(false);
      expect(f.queries.some((query) => /UPDATE public.icloud_resource/.test(query))).toBe(false);
    } finally {
      await f.db.destroy();
    }
  });

  it('refuses direct terminal release when the input cannot authenticate as disposed', async () => {
    const f = fixture(() => [resource]);
    const sut = new ICloudScheduledStagingRepository(f.db, {} as never);
    vi.spyOn(sut, 'authenticateDisposedValidationInputs').mockResolvedValue(false);
    try {
      await sut.releaseRefusedBytes({
        ownerId: resource.ownerId,
        resource: { id: resource.id, leaseToken: resource.leaseToken },
        authority: {
          purpose: 'scheduled-weekly',
          auditRequestId: resource.auditRequestId,
          operationId: resource.id,
          operationClaimToken: resource.leaseToken,
        },
      });
      expect(f.queries.some((query) => /UPDATE public.icloud_resource/.test(query))).toBe(false);
    } finally {
      await f.db.destroy();
    }
  });

  it.each([true, false])(
    'generic finish refuses scheduled or input-envelope custody (scheduled: %s)',
    async (scheduled) => {
      const current = { ...resource, auditRequestId: scheduled ? resource.auditRequestId : null };
      const f = fixture(() => [current]);
      const sut = new ICloudSyncRepository(
        f.db,
        new ICloudScheduledStagingRepository(f.db, new ICloudTransportRepository()),
      );
      const cleanup = vi.fn();
      try {
        await sut.finish(current as never, 'finalized', null, cleanup);
        expect(cleanup).not.toHaveBeenCalled();
        expect(f.queries.some((query) => /UPDATE public.icloud_resource/.test(query))).toBe(false);
      } finally {
        await f.db.destroy();
      }
    },
  );

  it('ordinary deferral excludes scheduled and unknown-envelope rows at its write boundary', async () => {
    const f = fixture(() => []);
    try {
      await new ICloudSyncRepository(
        f.db,
        new ICloudScheduledStagingRepository(f.db, new ICloudTransportRepository()),
      ).waitForClaim(resource as never, new Date());
      const update = f.queries.find((query) => /UPDATE public.icloud_resource/.test(query))!;
      expect(update).toMatch(/"auditRequestId" IS NULL/);
      expect(update).toMatch(/auditValidationInputs/);
    } finally {
      await f.db.destroy();
    }
  });
  it('audit housekeeping retains the resource and skips physical cleanup on unknown input custody', async () => {
    const sha256 = Buffer.alloc(32, 1);
    const current = {
      ...resource,
      status: 'committed',
      sha256,
      expectedSize: 10,
      verification: {
        auditValidationInputs: { unknown: true },
        kind: 'audit-match-staging',
        sha256: sha256.toString('hex'),
        sizeInBytes: 10,
        stagingPath: resource.stagingPath,
        resourceId: resource.id,
        requestId: resource.auditRequestId,
        ownerId: resource.ownerId,
      },
    };
    const f = fixture((query) =>
      query.includes('FROM public.icloud_identity_audit')
        ? [
            {
              id: resource.auditRequestId,
              connectionId: resource.connectionId,
              result: 'match',
            },
          ]
        : [current],
    );
    const staging = { authenticateDisposedValidationInputs: vi.fn().mockResolvedValue(false) };
    const cleanup = vi.fn();
    try {
      await new ICloudAuditRepository(f.db, staging as never).housekeeping(cleanup);
      expect(cleanup).not.toHaveBeenCalled();
      expect(f.queries.some((query) => query.includes("SET status='finalized'"))).toBe(false);
      expect(staging.authenticateDisposedValidationInputs).toHaveBeenCalledOnce();
    } finally {
      await f.db.destroy();
    }
  });

  it('connection deletion refuses source-only retained custody before cleanup and cascade', async () => {
    const f = fixture((query) => {
      if (query.includes('FROM public.icloud_connection'))
        return [{ id: resource.connectionId, state: 'disconnected' }];
      if (query.includes('FROM public.icloud_resource') && query.includes('auditValidationInputs'))
        return [{ ...resource, stagingPath: null }];
      return [];
    });
    const staging = { authenticateDisposedValidationInputs: vi.fn().mockResolvedValue(false) };
    const sut = new ICloudSyncRepository(f.db, staging as never);
    const cleanup = vi.fn();
    try {
      expect(await sut.remove(resource.connectionId, resource.ownerId, cleanup)).toBe('in-flight');
      expect(cleanup).not.toHaveBeenCalled();
      expect(f.queries.some((query) => query.includes('DELETE FROM public.icloud_connection'))).toBe(false);
    } finally {
      await f.db.destroy();
    }
  });

  it('ordinary repair and finalization exclude envelope evidence even without an audit ID', async () => {
    const f = fixture(() => []);
    const sut = new ICloudSyncRepository(f.db, {} as never);
    try {
      await sut.claim(resource.connectionId, 100);
      const repair = f.queries.find((query) => query.includes('SET "reservedBytes"=0'))!;
      expect(repair).toMatch(/"auditRequestId" IS NULL/);
      expect(repair).toMatch(/auditValidationInputs/);
      await sut.finalize(resource as never, vi.fn());
      const final = f.queries.find((query) => query.includes("status='committed'") && query.includes('FOR UPDATE'))!;
      expect(final).toMatch(/"auditRequestId" IS NULL/);
      expect(final).toMatch(/auditValidationInputs/);
    } finally {
      await f.db.destroy();
    }
  });
  it.each([false, true])('preserves ordinary and manual no-envelope retry behavior (manual: %s)', async (manual) => {
    const current = { ...resource, auditRequestId: manual ? resource.auditRequestId : null, verification: {} };
    const f = fixture((query) =>
      query.includes('FROM public.icloud_identity_audit') ? [{ purpose: 'manual-session' }] : [current],
    );
    try {
      await new ICloudSyncRepository(f.db, {} as never).finish(current as never, 'retry', 'audit_retry');
      expect(f.queries.some((query) => /UPDATE public.icloud_resource/.test(query))).toBe(true);
    } finally {
      await f.db.destroy();
    }
  });
});
