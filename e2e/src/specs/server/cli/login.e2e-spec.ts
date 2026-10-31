import { Permission } from '@frameleaf/sdk';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { app, immichCli, utils } from 'src/utils.js';
import { beforeEach, describe, expect, it } from 'vitest';

describe(`immich login`, () => {
  beforeEach(async () => {
    await utils.resetDatabase();
  });

  it('should require a url', async () => {
    const { stderr, exitCode } = await immichCli(['login']);
    expect(stderr).toBe("error: missing required argument 'url'");
    expect(exitCode).toBe(1);
  });

  it('should require a key', async () => {
    const { stderr, exitCode } = await immichCli(['login', app]);
    expect(stderr).toBe("error: missing required argument 'key'");
    expect(exitCode).toBe(1);
  });

  it('should require a valid key', async () => {
    const { stderr, exitCode } = await immichCli(['login', app, 'immich-is-so-cool']);
    expect(stderr).toContain('Failed to connect to server');
    expect(stderr).toContain('Invalid API key');
    expect(stderr).toContain('401');
    expect(exitCode).toBe(1);
  });

  it('should clear unclaimed periodic work without retaining a reset administrator', async () => {
    const db = await utils.connectDatabase();
    const identityCounts = `SELECT
      (SELECT count(*)::int FROM "user") AS users,
      (SELECT count(*)::int FROM cluster_group) AS groups,
      (SELECT count(*)::int FROM session) AS sessions,
      (SELECT count(*)::int FROM user_audit) AS audits`;
    const before = await db.query(identityCounts);
    expect(before.rows[0].users).toBe(0);
    const setupState =
      "SELECT key, value FROM system_metadata WHERE key IN ('admin-onboarding', 'frameleaf-setup') ORDER BY key";
    const setupBefore = await db.query(setupState);
    const { rows: queues } = await db.query("SELECT paused FROM job_queue WHERE name = 'backgroundTask'");
    const jobIds = [randomUUID(), randomUUID()];
    try {
      await db.query("UPDATE job_queue SET paused = true WHERE name = 'backgroundTask'");
      // Real periodic payloads, with no attempt, worker, run or executor to stop.
      await db.query(
        `INSERT INTO job (id, queue, name, data, "safeToRetry", "deadlineMs") VALUES
          ($1, 'backgroundTask', 'CloudMlDescriptionBatch', '{}'::jsonb, false, 60000),
          ($2, 'backgroundTask', 'FrameleafHeartbeat', '{}'::jsonb, false, 60000)`,
        jobIds,
      );

      // No table truncation: cleanup cannot hide behind full reset deleting the transient rows.
      await utils.resetDatabase([]);

      const jobs = await db.query(
        'SELECT state, attempt, token, "finishedAt" IS NOT NULL AS finished FROM job WHERE id = ANY($1::uuid[])',
        [jobIds],
      );
      expect(jobs.rows).toHaveLength(2);
      for (const job of jobs.rows) {
        expect(job).toEqual({ state: 'cancelled', attempt: 0, token: null, finished: true });
      }
      const after = await db.query(identityCounts);
      const setupAfter = await db.query(setupState);
      const pauseAfter = await db.query("SELECT paused FROM job_queue WHERE name = 'backgroundTask'");
      expect(after.rows).toEqual(before.rows);
      expect(setupAfter.rows).toEqual(setupBefore.rows);
      expect(pauseAfter.rows).toEqual([{ paused: true }]);
    } finally {
      await db.query("UPDATE job_queue SET paused = $1 WHERE name = 'backgroundTask'", [queues[0].paused]);
    }
    // The ordinary first-administrator path remains available after temporary authority is revoked.
    await expect(utils.adminSetup()).resolves.toMatchObject({ isAdmin: true });
  });

  it('should login and save auth.yml with 600', async () => {
    const admin = await utils.adminSetup();
    const apiKey = await utils.createApiKey(admin.accessToken, [Permission.All]);
    const { stdout, stderr, exitCode } = await immichCli(['login', app, apiKey.secret]);
    expect(stdout.split('\n')).toEqual([
      'Logging in to http://127.0.0.1:2285/api',
      'Logged in as admin@example.com',
      'Wrote auth info to /tmp/immich/auth.yml',
    ]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);

    const stats = await stat('/tmp/immich/auth.yml');
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toEqual('600');
  });

  it('should login without /api in the url', async () => {
    const admin = await utils.adminSetup();
    const apiKey = await utils.createApiKey(admin.accessToken, [Permission.All]);
    const { stdout, stderr, exitCode } = await immichCli(['login', app.replaceAll('/api', ''), apiKey.secret]);
    expect(stdout.split('\n')).toEqual([
      'Logging in to http://127.0.0.1:2285',
      'Discovered API at http://127.0.0.1:2285/api',
      'Logged in as admin@example.com',
      'Wrote auth info to /tmp/immich/auth.yml',
    ]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });
});
