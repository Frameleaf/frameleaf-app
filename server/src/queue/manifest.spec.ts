import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { queueExecution } from 'src/queue/context.js';
import { shareSelections } from 'src/queue/manifest.js';

describe('selection sharing cancellation', () => {
  let db: Kysely<any>;

  beforeEach(() => {
    db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (kysely) => new PostgresIntrospector(kysely),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
  });
  afterEach(() => db.destroy());

  it.each(['explicit', 'execution'] as const)(
    'stops between real sharing pages when the %s signal is cancelled',
    async (mode) => {
      const abort = new AbortController();
      let catalogueVisits = 0;
      await db.transaction().execute(async (tx) => {
        vi.spyOn(tx.getExecutor(), 'executeQuery').mockImplementation(async (query) => {
          if (query.sql.startsWith('select name from job_queue') && ++catalogueVisits > 1)
            throw new Error('unexpected second sharing page');
          if (query.sql.startsWith('with candidates as materialized')) {
            abort.abort(new Error('sharing cancelled'));
            return { rows: [{ runId: 'attached-run' }] };
          }
          return { rows: [] };
        });
        const sharing = () => shareSelections(tx, 'producer', mode === 'explicit' ? abort.signal : undefined);
        await expect(
          mode === 'execution' ? queueExecution.run({ signal: abort.signal } as never, sharing) : sharing(),
        ).rejects.toThrow('sharing cancelled');
      });
      expect(catalogueVisits).toBe(1);
    },
  );

  it.each(['explicit', 'execution'] as const)(
    'takes no SQL locks after an already cancelled %s signal',
    async (mode) => {
      const abort = new AbortController();
      abort.abort(new Error('sharing cancelled'));
      await db.transaction().execute(async (tx) => {
        const execute = vi.spyOn(tx.getExecutor(), 'executeQuery').mockResolvedValue({ rows: [] });
        const sharing = () => shareSelections(tx, 'producer', mode === 'explicit' ? abort.signal : undefined);
        await expect(
          mode === 'execution' ? queueExecution.run({ signal: abort.signal } as never, sharing) : sharing(),
        ).rejects.toThrow('sharing cancelled');
        expect(execute).not.toHaveBeenCalled();
      });
    },
  );

  it('permits sharing outside queue execution when no signal was supplied', async () => {
    await db.transaction().execute(async (tx) => {
      vi.spyOn(tx.getExecutor(), 'executeQuery').mockResolvedValue({ rows: [] });
      await expect(shareSelections(tx, 'producer')).resolves.toBeUndefined();
    });
  });
});
