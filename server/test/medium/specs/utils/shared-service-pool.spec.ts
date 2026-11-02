import type { DatabaseConnectionParams } from '@frameleaf/sql-tools';
import { createDatabasePool } from 'src/utils/shared-service-pool.js';

const params = (ssl: 'prefer' | 'allow' | 'require'): DatabaseConnectionParams => {
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  return {
    connectionType: 'parts',
    host: url.hostname,
    port: Number(url.port),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: 'postgres',
    ssl,
  } as DatabaseConnectionParams;
};

describe('database pg pool SSL modes against a server without SSL', () => {
  it.each(['prefer', 'allow'] as const)('falls back to plaintext for %s, like the main pool', async (ssl) => {
    const pool = createDatabasePool(params(ssl), { max: 1 });
    try {
      await expect(pool.query('select 1 as ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
      const client = await pool.connect();
      client.release();
    } finally {
      await pool.end();
    }
  });

  it('still refuses plaintext for require', async () => {
    const pool = createDatabasePool(params('require'), { max: 1 });
    try {
      await expect(pool.query('select 1')).rejects.toThrow('The server does not support SSL connections');
    } finally {
      await pool.end();
    }
  });
});
