import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import type { JobDependencyReason, QueueClaim } from 'src/queue/types.js';
import { JobRunReasonSchema } from 'src/dtos/job-run.dto.js';
import { SqlQueueStore } from 'src/queue/store.js';

describe('capacity deferral policy', () => {
  it.each(['local-capacity', 'destination-capacity', 'destination-unavailable'] as JobDependencyReason[])(
    'uses short capacity waits without changing outage backoff (%s)',
    async (reason) => {
      const queries: string[] = [];
      const db = new Kysely<any>({
        dialect: {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => new DummyDriver(),
          createIntrospector: (kysely) => new PostgresIntrospector(kysely),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
        log: (event) => {
          if (event.level === 'query') queries.push(event.query.sql);
        },
      });
      try {
        await new SqlQueueStore(db).defer(
          {
            id: '00000000-0000-4000-8000-000000000001',
            token: '00000000-0000-4000-8000-000000000002',
            queue: 'fixture',
          } as QueueClaim,
          reason,
        );
        const update = queries.find((query) => query.startsWith('update job set'));
        expect(update).toBeDefined();
        expect(update?.includes('power(2')).toBe(reason === 'destination-unavailable');
        expect(update).toContain("interval '30 seconds'");
        expect(update).toContain('"retryBaseAttempt" = "retryBaseAttempt" + 1');
      } finally {
        await db.destroy();
      }
    },
  );

  it('reports remote capacity waiting through the public run contract', () => {
    expect(JobRunReasonSchema.parse('destination-capacity')).toBe('destination-capacity');
  });
});
