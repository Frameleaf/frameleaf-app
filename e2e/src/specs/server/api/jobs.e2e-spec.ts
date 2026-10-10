import { JobName, LoginResponseDto, QueueCommand, QueueName, getQueue, updateConfig } from '@frameleaf/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Client } from 'pg';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, testAssetDir, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

describe('/jobs', () => {
  let admin: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
  });

  describe('PUT /jobs', () => {
    afterEach(async () => {
      await utils.queueCommand(admin.accessToken, QueueName.MetadataExtraction, {
        command: QueueCommand.Resume,
        force: false,
      });

      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Resume,
        force: false,
      });

      await utils.queueCommand(admin.accessToken, QueueName.FaceDetection, {
        command: QueueCommand.Resume,
        force: false,
      });

      await utils.queueCommand(admin.accessToken, QueueName.SmartSearch, {
        command: QueueCommand.Resume,
        force: false,
      });

      await utils.queueCommand(admin.accessToken, QueueName.DuplicateDetection, {
        command: QueueCommand.Resume,
        force: false,
      });

      const config = await utils.getSystemConfig(admin.accessToken);
      config.machineLearning.duplicateDetection.enabled = false;
      config.machineLearning.enabled = false;
      config.metadata.faces.import = false;
      config.machineLearning.clip.enabled = false;
      await updateConfig({ adminConfigDto: config }, { headers: asBearerAuth(admin.accessToken) });
    });

    it('should queue metadata extraction for missing assets', async () => {
      const path = `${testAssetDir}/formats/raw/Nikon/D700/philadelphia.nef`;

      await utils.queueCommand(admin.accessToken, QueueName.MetadataExtraction, {
        command: QueueCommand.Pause,
        force: false,
      });

      const { id } = await utils.createAsset(admin.accessToken, {
        assetData: { bytes: await readFile(path), filename: basename(path) },
      });

      const paused = await utils.waitForQueueIdle(admin.accessToken, 'metadataExtraction');
      expect(paused.isPaused).toBe(true);
      expect(paused.hasUnfinishedWork).toBe(true);
      expect(paused.statistics.paused).toBeGreaterThan(0);

      {
        const asset = await utils.getAssetInfo(admin.accessToken, id);

        expect(asset.exifInfo).toBeDefined();
        expect(asset.exifInfo?.make).toBeNull();
      }

      await utils.queueCommand(admin.accessToken, QueueName.MetadataExtraction, {
        command: QueueCommand.Empty,
        force: false,
      });

      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

      await utils.queueCommand(admin.accessToken, QueueName.MetadataExtraction, {
        command: QueueCommand.Resume,
        force: false,
      });

      await utils.queueCommand(admin.accessToken, QueueName.MetadataExtraction, {
        command: QueueCommand.Start,
        force: false,
      });

      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

      {
        const asset = await utils.getAssetInfo(admin.accessToken, id);

        expect(asset.exifInfo).toBeDefined();
        expect(asset.exifInfo?.make).toBe('NIKON CORPORATION');
      }
    });

    it('should not re-extract metadata for existing assets', async () => {
      const path = `${testAssetDir}/temp/metadata/asset.jpg`;

      cpSync(`${testAssetDir}/formats/raw/Nikon/D700/philadelphia.nef`, path);

      const { id } = await utils.createAsset(admin.accessToken, {
        assetData: { bytes: await readFile(path), filename: basename(path) },
      });

      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

      {
        const asset = await utils.getAssetInfo(admin.accessToken, id);

        expect(asset.exifInfo).toBeDefined();
        expect(asset.exifInfo?.model).toBe('NIKON D700');
      }

      cpSync(`${testAssetDir}/formats/raw/Nikon/D80/glarus.nef`, path);

      await utils.queueCommand(admin.accessToken, QueueName.MetadataExtraction, {
        command: QueueCommand.Start,
        force: false,
      });

      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

      {
        const asset = await utils.getAssetInfo(admin.accessToken, id);

        expect(asset.exifInfo).toBeDefined();
        expect(asset.exifInfo?.model).toBe('NIKON D700');
      }

      rmSync(path);
    });

    it('should queue thumbnail extraction for assets missing thumbs', async () => {
      const path = `${testAssetDir}/albums/nature/tanners_ridge.jpg`;

      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Pause,
        force: false,
      });

      const { id } = await utils.createAsset(admin.accessToken, {
        assetData: { bytes: await readFile(path), filename: basename(path) },
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.MetadataExtraction);
      await utils.waitForQueueFinish(admin.accessToken, QueueName.StorageTemplateMigration);
      const paused = await utils.waitForQueueIdle(admin.accessToken, QueueName.ThumbnailGeneration);
      expect(paused.isPaused).toBe(true);
      expect(paused.hasUnfinishedWork).toBe(true);
      expect(paused.statistics.paused).toBeGreaterThan(0);

      const assetBefore = await utils.getAssetInfo(admin.accessToken, id);
      expect(assetBefore.thumbhash).toBeNull();

      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Empty,
        force: false,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.MetadataExtraction);
      await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);

      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Resume,
        force: false,
      });

      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Start,
        force: false,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.MetadataExtraction);
      await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);

      const assetAfter = await utils.getAssetInfo(admin.accessToken, id);
      expect(assetAfter.thumbhash).not.toBeNull();
    });

    it('should not reload existing thumbnail when running thumb job for missing assets', async () => {
      const path = `${testAssetDir}/temp/thumbs/asset1.jpg`;

      cpSync(`${testAssetDir}/albums/nature/tanners_ridge.jpg`, path);

      const { id } = await utils.createAsset(admin.accessToken, {
        assetData: { bytes: await readFile(path), filename: basename(path) },
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.MetadataExtraction);
      await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);

      const assetBefore = await utils.getAssetInfo(admin.accessToken, id);

      cpSync(`${testAssetDir}/albums/nature/notocactus_minimus.jpg`, path);

      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Resume,
        force: false,
      });

      // This runs the missing thumbnail job
      await utils.queueCommand(admin.accessToken, QueueName.ThumbnailGeneration, {
        command: QueueCommand.Start,
        force: false,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.MetadataExtraction);
      await utils.waitForQueueFinish(admin.accessToken, QueueName.ThumbnailGeneration);

      const assetAfter = await utils.getAssetInfo(admin.accessToken, id);

      // Asset 1 thumbnail should be untouched since its thumb should not have been reloaded, even though the file was changed
      expect(assetAfter.thumbhash).toEqual(assetBefore.thumbhash);

      rmSync(path);
    });
  });

  describe('POST /queues/:name/jobs/retry-failed (FL-71)', () => {
    let failed = 0;
    const assetId = randomUUID();
    const jobId = randomUUID();
    const runId = randomUUID();
    const workerId = randomUUID();
    const failure = 'Seeded terminal failure for the queue API contract';
    let db: Client | undefined;
    let setup: Promise<void> | undefined;
    let seeded = false;
    let seedAttempted = false;
    let originallyPaused = false;

    beforeAll(() => {
      setup = (async () => {
        // This setup uses the existing default 10-second hook budget. It seeds API state;
        // it does not prove worker failure, the 30-second backoff, or retry exhaustion.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Terminal job fixture setup timed out')), 10_000);
        const options = { headers: asBearerAuth(admin.accessToken), signal: controller.signal };
        let transaction = false;
        try {
          db = await utils.connectDatabase();
          controller.signal.throwIfAborted();
          await db.query("SET statement_timeout = '1s'; SET lock_timeout = '1s'");
          const initial = await getQueue({ name: QueueName.ThumbnailGeneration }, options);
          expect(initial.hasUnfinishedWork).toBe(false);
          expect(initial.statistics.failed).toBe(0);
          await db.query('BEGIN');
          transaction = true;
          await db.query("SET LOCAL statement_timeout = '1s'; SET LOCAL lock_timeout = '1s'");
          const { rows: queueRows } = await db.query('SELECT paused FROM job_queue WHERE name = $1 FOR NO KEY UPDATE', [
            QueueName.ThumbnailGeneration,
          ]);
          const [queue] = queueRows;
          originallyPaused = queue.paused;
          await db.query('UPDATE job_queue SET paused = true WHERE name = $1', [QueueName.ThumbnailGeneration]);
          controller.signal.throwIfAborted();
          // New, uniquely owned rows only. The queue stays paused through requeue and teardown,
          // so the synthetic original path is never dispatched to a real media handler.
          seedAttempted = true;
          const { rows: insertedRows } = await db.query(
            `
            WITH fixture_asset AS (
              INSERT INTO asset (id, "ownerId", type, "originalPath", "originalFileName", checksum,
                "checksumAlgorithm", "fileCreatedAt", "fileModifiedAt", "localDateTime")
              VALUES ($1::uuid, $7::uuid, 'IMAGE', '/test-assets/seeded-job/' || $1::text || '.png',
                'seeded-terminal-job.png', $10::bytea, 'sha256', now(), now(), now()) RETURNING id
            ), fixture_worker AS (
              INSERT INTO job_worker (id, "startedAt", "heartbeatAt", state)
              VALUES ($4::uuid, now() - interval '35 seconds', now() - interval '1 second', 'lost') RETURNING id
            ), fixture_run AS (
              INSERT INTO job_run (id, kind, selection, "enumerationDone", "createdAt", "finishedAt")
              VALUES ($3::uuid, 'e2e-terminal-failed-api', jsonb_build_object('fixture', 'terminal-failed-api'),
                true, now() - interval '35 seconds', now() - interval '1 second') RETURNING id
            ), fixture_item AS (
              INSERT INTO job_run_item ("runId", "itemKey", "rootItemKey", stage, queue, selection, "jobId", state)
              SELECT r.id, a.id::text, a.id::text, $9::text, $8::text, jsonb_build_object('id', a.id), $2::uuid, 'failed'
              FROM fixture_run r CROSS JOIN fixture_asset a RETURNING "runId", "itemKey"
            ), fixture_job AS (
              INSERT INTO job (id, queue, name, data, state, "safeToRetry", sensitive, "deadlineMs", attempt,
                "retryBaseAttempt", "runId", "itemKey", "rootItemKey", "workerId", "availableAt", "createdAt",
                "startedAt", "finishedAt", "progressAt", error)
              SELECT $2::uuid, $8::text, $9::text, jsonb_build_object('id', i."itemKey"), 'failed', true, false,
                600000, 2, 0, i."runId", i."itemKey", i."itemKey", w.id, now() + interval '29 seconds',
                now() - interval '35 seconds', now() - interval '2 seconds', now() - interval '1 second',
                now() - interval '2 seconds', $11::text FROM fixture_item i CROSS JOIN fixture_worker w RETURNING id
            ), fixture_attempts AS (
              INSERT INTO job_attempt ("jobId", attempt, token, "workerId", "startedAt", "finishedAt", outcome, error)
              SELECT j.id, a.attempt, a.token, $4::uuid, now() - a.started, now() - a.finished, a.outcome, $11::text
              FROM fixture_job j CROSS JOIN (VALUES
                (1, $5::uuid, interval '34 seconds', interval '33 seconds', 'pending'),
                (2, $6::uuid, interval '2 seconds', interval '1 second', 'failed')) a(attempt, token, started, finished, outcome)
              RETURNING "jobId"
            ) SELECT id, (SELECT count(*)::integer FROM fixture_attempts) attempts FROM fixture_job`,
            [
              assetId,
              jobId,
              runId,
              workerId,
              randomUUID(),
              randomUUID(),
              admin.userId,
              QueueName.ThumbnailGeneration,
              JobName.AssetGenerateThumbnails,
              createHash('sha256').update(`seeded-terminal-api:${assetId}`).digest(),
              failure,
            ],
          );
          const [inserted] = insertedRows;
          expect(inserted).toEqual({ id: jobId, attempts: 2 });
          controller.signal.throwIfAborted();
          await db.query('COMMIT');
          transaction = false;
          seeded = true;
          const current = await getQueue({ name: QueueName.ThumbnailGeneration }, options);
          expect(current.isPaused).toBe(true);
          expect(current.hasUnfinishedWork).toBe(false);
          expect(current.statistics.failed).toBe(1);
          failed = current.statistics.failed;
        } catch (error) {
          if (transaction && db) {
            try {
              await db.query('ROLLBACK');
            } catch (error_) {
              throw new AggregateError([error, error_], 'Terminal fixture setup and rollback failed', {
                cause: error_,
              });
            }
          }
          throw error;
        } finally {
          clearTimeout(timer);
          controller.abort(new Error('Terminal fixture setup settled'));
        }
      })();
      return setup;
    });

    afterAll(async () => {
      // If the hook deadline won, first join its bounded request/SQL settlement. Never
      // run teardown SQL concurrently with an old setup continuation on this connection.
      try {
        await setup;
      } catch {
        // The setup hook reports its failure; still join it before owned cleanup.
      }
      if (!db) {
        return;
      }
      let cleanupError: unknown;
      let cleanupFailed = false;
      try {
        if (seedAttempted && !seeded) {
          // Resolve an ambiguous COMMIT using the exact fixture identity. All fixture
          // rows and the pause change share one transaction, so absence means rollback.
          const { rows: currentRows } = await db.query('SELECT EXISTS (SELECT 1 FROM job WHERE id = $1) present', [
            jobId,
          ]);
          const [current] = currentRows;
          seeded = current.present;
        }
        if (seeded) {
          await db.query('BEGIN');
          try {
            await db.query("SET LOCAL statement_timeout = '1s'; SET LOCAL lock_timeout = '1s'");
            const { rows: queueRows } = await db.query(
              'SELECT paused FROM job_queue WHERE name = $1 FOR NO KEY UPDATE',
              [QueueName.ThumbnailGeneration],
            );
            const [queue] = queueRows;
            expect(queue.paused).toBe(true);
            const removed = await db.query(
              `DELETE FROM job WHERE id = $1 AND "workerId" = $2 AND attempt = 2
              AND token IS NULL AND state IN ('failed', 'pending') RETURNING id`,
              [jobId, workerId],
            );
            expect(removed.rows).toEqual([{ id: jobId }]);
            await db.query('DELETE FROM job_run_item WHERE "runId" = $1 AND "jobId" = $2', [runId, jobId]);
            await db.query('DELETE FROM job_run WHERE id = $1', [runId]);
            await db.query('DELETE FROM job_worker WHERE id = $1', [workerId]);
            await db.query('DELETE FROM asset WHERE id = $1 AND "ownerId" = $2', [assetId, admin.userId]);
            await db.query('UPDATE job_queue SET paused = $2 WHERE name = $1', [
              QueueName.ThumbnailGeneration,
              originallyPaused,
            ]);
            await db.query('COMMIT');
          } catch (error) {
            try {
              await db.query('ROLLBACK');
            } catch (error_) {
              throw new AggregateError([error, error_], 'Terminal fixture cleanup and rollback failed', {
                cause: error_,
              });
            }
            throw error;
          }
        }
      } catch (error) {
        cleanupError = error;
        cleanupFailed = true;
      }
      try {
        await utils.disconnectDatabase(db);
      } catch (closeError) {
        if (cleanupFailed) {
          throw new AggregateError(
            [cleanupError, closeError],
            'Terminal fixture cleanup and owned connection close failed',
            { cause: closeError },
          );
        }
        throw closeError;
      }
      if (cleanupFailed) {
        throw cleanupError;
      }
    });

    it('lists the failed job with the account that owns its asset and the server as its worker', async () => {
      expect(failed).toBe(1);
      const { status, body } = await request(app)
        .get(`/queues/${QueueName.ThumbnailGeneration}/jobs`)
        .query({ status: ['failed'] })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toHaveLength(failed);
      const job = body.find((job: { id: string }) => job.id === jobId);
      expect(job).toBeDefined();
      expect(job.data.id).toBe(assetId);
      expect(job.attemptsMade).toBe(2);
      expect(job.failedReason).toBe(failure);
      expect(job.account).toEqual({ id: admin.userId, name: expect.any(String) });
      expect(job.worker).toEqual({ kind: 'server', name: null });
    });

    it('is for administrators only', async () => {
      const user = await utils.userSetup(admin.accessToken, createUserDto.user1);
      const { status } = await request(app)
        .post(`/queues/${QueueName.ThumbnailGeneration}/jobs/retry-failed`)
        .set('Authorization', `Bearer ${user.accessToken}`);

      expect(status).toBe(403);
    });

    it('puts every failed job back in the queue and reports how many', async ({ signal }) => {
      expect(failed).toBe(1);
      const { status, body } = await request(app)
        .post(`/queues/${QueueName.ThumbnailGeneration}/jobs/retry-failed`)
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual({ count: failed });
      const current = await getQueue(
        { name: QueueName.ThumbnailGeneration },
        { headers: asBearerAuth(admin.accessToken), signal },
      );
      expect(current.isPaused).toBe(true);
      expect(current.hasUnfinishedWork).toBe(true);
      expect(current.statistics).toMatchObject({ failed: 0, paused: 1, active: 0 });
      const { rows: retriedRows } = await db!.query(
        `SELECT j.state, j.attempt, j."retryBaseAttempt", j.token,
        i.state AS "itemState", r."finishedAt" AS "runFinishedAt" FROM job j
        JOIN job_run_item i ON i."jobId" = j.id JOIN job_run r ON r.id = i."runId" WHERE j.id = $1`,
        [jobId],
      );
      const [retried] = retriedRows;
      expect(retried).toEqual({
        state: 'pending',
        attempt: 2,
        retryBaseAttempt: 2,
        token: null,
        itemState: 'pending',
        runFinishedAt: null,
      });
      const { rows: attempts } = await db!.query(
        'SELECT attempt, outcome FROM job_attempt WHERE "jobId" = $1 ORDER BY attempt',
        [jobId],
      );
      expect(attempts).toEqual([
        { attempt: 1, outcome: 'pending' },
        { attempt: 2, outcome: 'failed' },
      ]);
    });
  });
});
