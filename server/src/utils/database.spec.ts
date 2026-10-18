import {
  CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import postgres from 'postgres';
import { DB } from 'src/schema/index.js';
import { boundPoolClose, getKyselyConfig, withTagId } from 'src/utils/database.js';
import { DATABASE_CLOSE_TIMEOUT_SECONDS, RESTART_BUDGET } from 'src/utils/shutdown.js';

describe(withTagId.name, () => {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const tagId = '00000000-0000-4000-8000-000000000001';
  const compile = (withChildTags?: boolean) =>
    withTagId(db.selectFrom('asset').select('asset.id'), tagId, withChildTags).compile();

  it('matches the tags inside the tag through the closure by default', () => {
    const { sql, parameters } = compile();
    expect(sql).toContain('"tag_closure"."id_ancestor" = $1');
    expect(parameters).toEqual([tagId]);
    expect(compile(true)).toEqual(compile());
  });

  it('matches only the tag itself when the tags inside are left out (DISCOVERY-P4)', () => {
    const { sql, parameters } = compile(false);
    expect(sql).not.toContain('tag_closure');
    expect(sql).toContain('"tag_asset"."assetId" = "asset"."id"');
    expect(sql).toContain('"tag_asset"."tagId" = $1');
    expect(parameters).toEqual([tagId]);
  });
});

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
  it.each(['desktop_ml_task', 'desktop_ml_attempt', 'desktop_worker_session', 'desktop_worker_challenge'])(
    'redacts private inputs, output and error details for %s',
    async (table) => {
      const config = getKyselyConfig({
        connectionType: 'url',
        url: 'postgres://postgres:postgres@127.0.0.1:1/frameleaf',
      });
      const database = new Kysely(config);
      // eslint-disable-next-line import-x/no-named-as-default-member -- postgres exposes this class on its default ESM export.
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
