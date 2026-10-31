import { DummyDriver, Kysely, PostgresDialect } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from 'src/schema/index.js';
import { LivePhotoRepository } from 'src/repositories/live-photo.repository.js';
import { tryPromise } from 'src/utils/promise.js';

describe('Live Photo relink transaction', () => {
  let db: Kysely<DB>;
  let sut: LivePhotoRepository;
  let queries: string[];
  let parameters: readonly unknown[][];
  let memberships: string[][];
  let failure: string | undefined;
  let rolledBack: boolean;
  beforeEach(() => {
    queries = [];
    parameters = [];
    memberships = [['album'], ['album']];
    failure = undefined;
    rolledBack = false;
    class Driver extends DummyDriver {
      rollbackTransaction() {
        rolledBack = true;
        return Promise.resolve();
      }
      acquireConnection() {
        return Promise.resolve({
          executeQuery: (query: { sql: string; parameters: readonly unknown[] }) =>
            tryPromise(() => {
              queries.push(query.sql);
              parameters = [...parameters, [...query.parameters]];
              if (failure && query.sql.includes(`from "${failure}"`))
                throw Object.assign(new Error('busy'), { code: '55P03' });
              return {
                rows: query.sql.includes('from "album_asset"')
                  ? (memberships.shift() ?? []).map((albumId) => ({ albumId }))
                  : [],
              } as never;
            }),
          async *streamQuery(): AsyncGenerator<never> {},
        });
      }
    }
    const dialect = new PostgresDialect({ pool: {} as never });
    dialect.createDriver = () => new Driver();
    db = new Kysely<DB>({ dialect });
    sut = new LivePhotoRepository(db);
  });
  afterEach(() => db.destroy());

  it('locks metadata, current albums and both assets before rechecking membership and entering the callback', async () => {
    const callback = vi.fn().mockResolvedValue('linked');
    await expect(sut.withRelinkTransaction('PHOTO', 'video', callback)).resolves.toBe('linked');
    expect(queries.slice(0, 2)).toEqual(
      Array.from({ length: 2 }, () => 'SELECT pg_advisory_xact_lock(-1, hashtext($1)::int)'),
    );
    expect(parameters.slice(0, 2)).toEqual([['photo'], ['video']]);
    expect(queries[2]).toContain('from "album_asset"');
    expect(queries[3]).toMatch(/from "album".*order by "id" for no key update nowait/);
    expect(queries[4]).toMatch(/from "asset".*order by "id" for update nowait/);
    expect(queries[5]).toContain('from "album_asset"');
    expect(callback).toHaveBeenCalledOnce();
    expect(rolledBack).toBe(false);
  });

  it.each(['album', 'asset'])('rolls back a contended %s lock before calling the writer', async (table) => {
    failure = table;
    const callback = vi.fn();
    await expect(sut.withRelinkTransaction('photo', 'video', callback)).rejects.toThrow('retry relinking');
    expect(callback).not.toHaveBeenCalled();
    expect(rolledBack).toBe(true);
  });

  it('rolls back when a new album membership appeared during lock acquisition', async () => {
    memberships = [['album'], ['album', 'new-album']];
    const callback = vi.fn();
    await expect(sut.withRelinkTransaction('photo', 'video', callback)).rejects.toThrow('retry relinking');
    expect(callback).not.toHaveBeenCalled();
    expect(rolledBack).toBe(true);
  });
});
