import { CompiledQuery, Kysely } from 'kysely';
import postgres from 'postgres';
import { boundPoolClose, getKyselyConfig } from 'src/utils/database.js';
import { DATABASE_CLOSE_TIMEOUT_SECONDS, RESTART_BUDGET } from 'src/utils/shutdown.js';

describe(boundPoolClose.name, () => {
  it('closes the pool with a timeout when the driver asks for none (FL-299)', async () => {
    const end = vi.fn(() => Promise.resolve());

    await boundPoolClose({ end }).end();

    expect(end).toHaveBeenCalledWith({ timeout: DATABASE_CLOSE_TIMEOUT_SECONDS });
  });

  it('keeps a timeout the caller chose', async () => {
    const end = vi.fn((_options?: { timeout?: number }) => Promise.resolve());

    await boundPoolClose({ end }).end({ timeout: 0 });

    expect(end).toHaveBeenCalledWith({ timeout: 0 });
  });

  it('fits between the grace period and the worker deadline of a restart', () => {
    expect(DATABASE_CLOSE_TIMEOUT_SECONDS * 1000).toBeLessThan(
      RESTART_BUDGET.workerDeadlineMs - RESTART_BUDGET.graceMs,
    );
  });
});

describe('desktop inference database diagnostics', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(['desktop_ml_task', 'desktop_ml_attempt'])(
    'redacts private inputs, output and error details for %s',
    async (table) => {
      const config = getKyselyConfig({
        connectionType: 'url',
        url: 'postgres://postgres:postgres@127.0.0.1:1/frameleaf',
      });
      const database = new Kysely(config);
      const error = Object.assign(new postgres.PostgresError('private photo contents'), {
        code: '23514',
        detail: 'private photo contents',
      });
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        if (typeof config.log !== 'function') throw new Error('Missing database logger');
        await config.log({
          level: 'error',
          error,
          queryDurationMillis: 1,
          query: CompiledQuery.raw(`insert into "${table}" values ($1)`, [{ caption: 'private photo contents' }]),
        });
        expect(JSON.stringify(log.mock.calls)).not.toContain('private photo contents');
        expect(log.mock.calls[0][1]).toMatchObject({ params: '[redacted]', error: { code: '23514' } });
      } finally {
        await database.destroy();
      }
    },
  );
});

it('keeps ordinary database failures diagnosable', async () => {
  const config = getKyselyConfig({ connectionType: 'url', url: 'postgres://postgres:postgres@127.0.0.1:1/frameleaf' });
  const database = new Kysely(config);
  const error = new Error('ordinary diagnostic');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    if (typeof config.log !== 'function') throw new Error('Missing database logger');
    await config.log({ level: 'error', error, queryDurationMillis: 1, query: CompiledQuery.raw('select $1', [123]) });
    expect(log.mock.calls[0][1]).toMatchObject({ error, params: [123] });
  } finally {
    log.mockRestore();
    await database.destroy();
  }
});
