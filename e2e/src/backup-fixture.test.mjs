import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { amendBackupFixture } from './backup-fixture.ts';
import { settleMaintenanceCleanup } from './maintenance-cleanup.ts';

const dump = `-- PostgreSQL database dump
-- Dumped from database version 19beta4
SELECT pg_catalog.set_config('search_path', '', false);
CREATE TABLE public.frameleaf_migrations (name text);
CREATE TABLE public."user" ("isAdmin" boolean);
INSERT INTO public."user" VALUES (true);
-- PostgreSQL database dump complete
`;

test('SQL corruption preserves the canonical header, ledger, source data and completion marker', () => {
  const result = gunzipSync(amendBackupFixture(gzipSync(dump), 'corrupted')).toString();
  assert.equal(result.replace('IM CORRUPTED;\n\n', ''), dump);
  assert.ok(result.indexOf('IM CORRUPTED;') < result.indexOf('-- PostgreSQL database dump complete'));
});

test('missing-admin control changes only the post-restore health condition', () => {
  const result = gunzipSync(amendBackupFixture(gzipSync(dump), 'empty')).toString();
  const amendment = 'SET LOCAL search_path = pg_catalog, public;\nUPDATE public."user" SET "isAdmin" = false;';
  assert.equal(result.replace(`${amendment}\n\n`, ''), dump);
  assert.ok(result.indexOf(amendment) > result.indexOf("pg_catalog.set_config('search_path', '', false)"));
  assert.ok(result.indexOf(amendment) < result.indexOf('-- PostgreSQL database dump complete'));
});

test('refuses broken gzip and noncanonical source fixtures instead of inventing restore headers', () => {
  assert.throws(() => amendBackupFixture(Buffer.from('broken'), 'corrupted'));
  for (const invalid of [
    'SELECT 1;',
    dump.replace('19beta4', '18.3'),
    dump.replace('frameleaf_migrations', 'kysely_migrations'),
    dump.replace('-- PostgreSQL database dump complete', ''),
  ]) {
    assert.throws(() => amendBackupFixture(gzipSync(invalid), 'empty'), /complete canonical PostgreSQL 19/);
  }
});

test('a status response at the deadline settles before failure and cannot start End or late requests', async () => {
  let clock = 0;
  const calls = [];
  let active = false;
  await assert.rejects(
    settleMaintenanceCleanup(
      {
        config: async (budget) => {
          calls.push(['config', budget]);
          clock = 49;
          return { maintenanceMode: true };
        },
        status: async (budget) => {
          active = true;
          calls.push(['status', budget]);
          await Promise.resolve();
          clock = 50;
          active = false;
          return { action: 'restore_database', error: 'failed' };
        },
        end: async () => calls.push(['end']),
      },
      {
        timeoutMs: 50,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    ),
    /cleanup deadline/,
  );
  assert.equal(active, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    ['config', 50],
    ['status', 1],
  ]);
});

test('healthy restores cannot be ended and explicit failures return to the normal API', async () => {
  let clock = 0;
  let reads = 0;
  let ended = false;
  const actions = ['restore_database', 'restore_database'];
  await settleMaintenanceCleanup(
    {
      config: async () => ({ maintenanceMode: !ended }),
      status: async () => ({ action: actions[reads++], error: reads === 2 ? 'failed' : undefined }),
      end: async () => {
        assert.equal(reads, 2);
        ended = true;
      },
    },
    {
      timeoutMs: 2000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  );
  assert.equal(ended, true);
  assert.equal(reads, 2);
});

test('failed requests settle and exhaust their shared budget without detached retry work', async () => {
  let clock = 0;
  let active = false;
  let reads = 0;
  const failure = new Error('connection refused');
  await assert.rejects(
    settleMaintenanceCleanup(
      {
        config: async () => {
          active = true;
          reads++;
          await Promise.resolve();
          active = false;
          throw failure;
        },
        status: async () => assert.fail('status must not start'),
        end: async () => assert.fail('End must not start'),
      },
      {
        timeoutMs: 50,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    ),
    (error) => error.message.includes('cleanup deadline') && error.cause === failure,
  );
  assert.equal(active, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
});
