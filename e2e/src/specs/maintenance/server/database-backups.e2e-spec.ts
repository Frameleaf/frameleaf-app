import { LoginResponseDto, ManualJobName } from '@frameleaf/sdk';
import { setupCode } from 'src/fixtures.js';
import { ownedWait } from 'src/harness-context.js';
import { pollRequest } from 'src/harness-wait.js';
import { settleMaintenanceCleanup } from 'src/maintenance-cleanup.js';
import { errorDto } from 'src/responses.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Use the existing maintenance exit startup profile, with requests owned by the current test.
const waitForServerRestart = () =>
  ownedWait('Waiting for the server to leave maintenance', 60_000, (context) =>
    pollRequest(
      context,
      () => request(app).get('/server/config'),
      ({ status, body }) => {
        if (status >= 500) {
          throw new Error(`Server restart failed: HTTP ${status}`);
        }
        return status === 200 && !body.maintenanceMode;
      },
    ),
  );

describe('/admin/database-backups', () => {
  let cookie: string | undefined;
  let admin: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({
      onboarding: false,
    });
  });

  beforeEach(async () => {
    await utils.resetBackups(admin.accessToken);
  });

  describe('GET /', async () => {
    it('should succeed and be empty', async () => {
      const { status, body } = await request(app)
        .get('/admin/database-backups')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({
        backups: [],
      });
    });

    it('should contain a created backup', async () => {
      await utils.createJob(admin.accessToken, {
        name: ManualJobName.BackupDatabase,
      });

      await utils.waitForQueueFinish(admin.accessToken, 'backupDatabase');

      await expect
        .poll(
          async () => {
            const { status, body } = await request(app)
              .get('/admin/database-backups')
              .set('Authorization', `Bearer ${admin.accessToken}`);

            expect(status).toBe(200);
            return body;
          },
          {
            interval: 500,
            timeout: 10_000,
          },
        )
        .toEqual(
          expect.objectContaining({
            backups: [
              expect.objectContaining({
                filename: expect.stringMatching(
                  /^frameleaf-db-backup-\d{8}T\d{6}-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}-v[^/]+-pg19(?:[.\d]+|(?:alpha|beta|rc)\d+)\.sql\.gz$/,
                ),
                filesize: expect.any(Number),
              }),
            ],
          }),
        );
    });
  });

  describe('DELETE /', async () => {
    it('should delete backup', async () => {
      const filename = await utils.createBackup(admin.accessToken);

      const { status } = await request(app)
        .delete(`/admin/database-backups`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ backups: [filename] });

      expect(status).toBe(200);

      const { status: listStatus, body } = await request(app)
        .get('/admin/database-backups')
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(listStatus).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          backups: [],
        }),
      );
    });
  });

  // => action: restore database flow

  describe.sequential('POST /start-restore', () => {
    // The hook covers End, the bounded restart wait, and recreating the admin.
    afterAll(async () => {
      await request(app)
        .post('/admin/maintenance')
        .set('cookie', cookie!)
        .send({ action: 'end' })
        .timeout({ deadline: 5000 })
        .expect(201);
      await vi.waitFor(
        async () => {
          const { status, body } = await request(app).get('/server/config').timeout({ deadline: 5000 });
          expect({ status, maintenanceMode: body.maintenanceMode }).toEqual({ status: 200, maintenanceMode: false });
        },
        // Match the maintenance exit test's restart budget; connection errors retry at this interval.
        { interval: 500, timeout: 60_000 },
      );

      admin = await utils.adminSetup({
        onboarding: false,
      });
    }, 70_000);

    it.sequential('should not work when the server is configured', async () => {
      const { status, body } = await request(app)
        .post('/admin/database-backups/start-restore')
        .send({ code: setupCode });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Admin setup is not available'));
    });

    it.sequential('should enter maintenance mode in "database restore mode"', async () => {
      await utils.resetDatabase(); // reset database before running this test

      // FL-292: starting a restore on an unclaimed server takes the setup code, like admin sign-up.
      const { status, headers } = await request(app)
        .post('/admin/database-backups/start-restore')
        .send({ code: setupCode });

      expect(status).toBe(201);

      cookie = headers['set-cookie'][0].split(';', 1)[0];

      await expect
        .poll(
          async () => {
            const { status, body } = await request(app).get('/server/config');
            expect(status).toBe(200);
            return body.maintenanceMode;
          },
          {
            interval: 500,
            timeout: 10_000,
          },
        )
        .toBeTruthy();

      const { status: status2, body } = await request(app).get('/admin/maintenance/status').send({ token: 'token' });
      expect(status2).toBe(200);
      expect(body).toEqual({
        active: true,
        action: 'select_database_restore',
      });
    });
  });

  // => action: restore database

  describe.sequential('POST /backups/restore', () => {
    // Register teardown before entering maintenance: failed assertions must not strand later specs.
    afterEach(async () => {
      if (!cookie) {
        return;
      }
      await settleMaintenanceCleanup({
        config: async (timeoutMs) => {
          const response = await request(app).get('/server/config').timeout({ deadline: timeoutMs });
          expect(response.status).toBe(200);
          return response.body;
        },
        status: async (timeoutMs) => {
          const response = await request(app)
            .get('/admin/maintenance/status')
            .set('cookie', cookie!)
            .timeout({ deadline: timeoutMs });
          expect(response.status).toBe(200);
          return response.body;
        },
        end: (timeoutMs) =>
          request(app)
            .post('/admin/maintenance')
            .set('cookie', cookie!)
            .send({ action: 'end' })
            .timeout({ deadline: timeoutMs })
            .expect(201),
      });
      cookie = undefined;
    }, 60_000);

    beforeAll(async () => {
      await utils.disconnectDatabase();
    });

    afterAll(async () => {
      await utils.connectDatabase();
    });

    it.sequential('should restore a backup', { timeout: 60_000 }, async () => {
      const filename = await utils.createBackup(admin.accessToken);

      const { status, headers } = await request(app)
        .post('/admin/maintenance')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          action: 'restore_database',
          restoreBackupFilename: filename,
        });

      cookie = headers['set-cookie']?.[0]?.split(';', 1)[0];
      expect(status).toBe(201);

      await expect
        .poll(
          async () => {
            const { status, body } = await request(app).get('/server/config');
            expect(status).toBe(200);
            return body.maintenanceMode;
          },
          {
            interval: 500,
            timeout: 10_000,
          },
        )
        .toBeTruthy();

      const { status: status2, body } = await request(app).get('/admin/maintenance/status').send({ token: 'token' });
      expect(status2).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          active: true,
          action: 'restore_database',
        }),
      );

      await expect
        .poll(
          async () => {
            const { status, body } = await request(app).get('/server/config');
            expect(status).toBe(200);
            return body.maintenanceMode;
          },
          {
            interval: 500,
            timeout: 60_000,
          },
        )
        .toBeFalsy();
    });

    it.sequential(
      'refuses a noncanonical source before changing the current database',
      { timeout: 60_000 },
      async () => {
        const filename = 'noncanonical.sql';
        await utils.putTextFile('SELECT 1;\n-- PostgreSQL database dump complete\n', `/data/backups/${filename}`);
        const { status, headers } = await request(app)
          .post('/admin/maintenance')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({ action: 'restore_database', restoreBackupFilename: filename });
        cookie = headers['set-cookie']?.[0]?.split(';', 1)[0];
        expect(status).toBe(201);
        await expect
          .poll(
            async () => {
              const answer = await request(app).get('/admin/maintenance/status').set('cookie', cookie!);
              expect(answer.status).toBe(200);
              return answer.body;
            },
            { interval: 500, timeout: 10_000 },
          )
          .toEqual(
            expect.objectContaining({
              active: true,
              action: 'restore_database',
              error: expect.stringContaining('Restore requires a complete Frameleaf PostgreSQL 19 backup.'),
            }),
          );
        await request(app).post('/admin/maintenance').set('cookie', cookie!).send({ action: 'end' }).expect(201);
        await expect
          .poll(
            async () => {
              const answer = await request(app).get('/users/me').set('Authorization', `Bearer ${admin.accessToken}`);
              expect(answer.status).toBe(200);
              return answer.body.id;
            },
            { interval: 500, timeout: 10_000 },
          )
          .toBe(admin.userId);
      },
    );

    it.sequential('fail to restore a corrupted backup', { timeout: 60_000 }, async () => {
      const filename = await utils.prepareTestBackup('corrupted', admin.accessToken);

      const { status, headers } = await request(app)
        .post('/admin/maintenance')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          action: 'restore_database',
          restoreBackupFilename: filename,
        });

      cookie = headers['set-cookie']?.[0]?.split(';', 1)[0];
      expect(status).toBe(201);

      await expect
        .poll(
          async () => {
            const { status, body } = await request(app).get('/server/config');
            expect(status).toBe(200);
            return body.maintenanceMode;
          },
          {
            interval: 500,
            timeout: 10_000,
          },
        )
        .toBeTruthy();

      await expect
        .poll(
          async () => {
            const { status, body } = await request(app).get('/admin/maintenance/status').send({ token: 'token' });
            expect(status).toBe(200);
            return body;
          },
          {
            interval: 500,
            timeout: 30_000,
          },
        )
        .toEqual(
          expect.objectContaining({
            active: true,
            action: 'restore_database',
            error: 'Something went wrong, see logs!',
          }),
        );

      const { status: status2, body: body2 } = await request(app)
        .get('/admin/maintenance/status')
        .set('cookie', cookie!)
        .send({ token: 'token' });
      expect(status2).toBe(200);
      expect(body2).toEqual(
        expect.objectContaining({
          active: true,
          action: 'restore_database',
          error: expect.stringContaining('IM CORRUPTED'),
        }),
      );

      await request(app).post('/admin/maintenance').set('cookie', cookie!).send({ action: 'end' }).expect(201);
      await waitForServerRestart();
    });

    it.sequential('rollback to restore point if backup is missing admin', { timeout: 60_000 }, async () => {
      const filename = await utils.prepareTestBackup('empty', admin.accessToken);

      const { status, headers } = await request(app)
        .post('/admin/maintenance')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          action: 'restore_database',
          restoreBackupFilename: filename,
        });

      cookie = headers['set-cookie']?.[0]?.split(';', 1)[0];
      expect(status).toBe(201);

      await expect
        .poll(
          async () => {
            const { status, body } = await request(app).get('/server/config');
            expect(status).toBe(200);
            return body.maintenanceMode;
          },
          {
            interval: 500,
            timeout: 10_000,
          },
        )
        .toBeTruthy();

      // The restore and completed rollback share this test's unchanged 60-second deadline.
      const failedRestore = await ownedWait('Waiting for missing-admin rollback', 60_000, (context) =>
        pollRequest(
          context,
          () => request(app).get('/admin/maintenance/status').send({ token: 'token' }),
          ({ status, body }) => {
            expect(status).toBe(200);
            return body.task === 'error';
          },
        ),
      );
      expect(failedRestore.body).toEqual(
        expect.objectContaining({
          active: true,
          action: 'restore_database',
          error: 'Something went wrong, see logs!',
        }),
      );

      const { status: status2, body: body2 } = await request(app)
        .get('/admin/maintenance/status')
        .set('cookie', cookie!)
        .send({ token: 'token' });
      expect(status2).toBe(200);
      expect(body2).toEqual(
        expect.objectContaining({
          active: true,
          action: 'restore_database',
          error: expect.stringContaining('Server health check failed, no admin exists.'),
        }),
      );

      await request(app).post('/admin/maintenance').set('cookie', cookie!).send({ action: 'end' }).expect(201);
      await waitForServerRestart();
    });

    // FL-81: a backup from a newer server cannot be migrated down; it is refused before anything changes.
    it.sequential('refuses a backup made by a newer server', { timeout: 60_000 }, async () => {
      const created = await utils.createBackup(admin.accessToken);
      const filename = created.replace(/-v.+-pg/, '-v999.0.0-pg');
      expect(filename).not.toBe(created);
      await utils.move(`/data/backups/${created}`, `/data/backups/${filename}`);

      const { status, headers } = await request(app)
        .post('/admin/maintenance')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ action: 'restore_database', restoreBackupFilename: filename });

      cookie = headers['set-cookie']?.[0]?.split(';', 1)[0];
      expect(status).toBe(201);

      await expect
        .poll(
          async () => {
            const { status, body } = await request(app).get('/admin/maintenance/status').set('cookie', cookie!);
            expect(status).toBe(200);
            return body;
          },
          { interval: 500, timeout: 30_000 },
        )
        .toEqual(
          expect.objectContaining({
            action: 'restore_database',
            task: 'error',
            error: expect.stringContaining('This backup was made by a newer server (v999.0.0)'),
          }),
        );

      await request(app).post('/admin/maintenance').set('cookie', cookie!).send({ action: 'end' }).expect(201);
      await waitForServerRestart();
    });

    // FL-81: while a restore runs, a second restore or End (which would restart the worker mid-restore) is refused.
    it.sequential('refuses conflicting actions while a restore runs', { timeout: 60_000 }, async () => {
      const filename = await utils.createBackup(admin.accessToken);

      const { status, headers } = await request(app)
        .post('/admin/maintenance')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ action: 'restore_database', restoreBackupFilename: filename });

      cookie = headers['set-cookie']?.[0]?.split(';', 1)[0];
      expect(status).toBe(201);

      await utils.poll(
        () => request(app).get('/admin/maintenance/status').set('cookie', cookie!),
        ({ status, body }) => status === 200 && body.action === 'restore_database' && body.task !== undefined,
      );

      for (const action of [{ action: 'end' }, { action: 'restore_database', restoreBackupFilename: filename }]) {
        const { status: conflict } = await request(app).post('/admin/maintenance').set('cookie', cookie!).send(action);
        expect(conflict).toBe(409);
      }

      await expect
        .poll(
          async () => {
            const { status, body } = await request(app).get('/server/config');
            expect(status).toBe(200);
            return body.maintenanceMode;
          },
          { interval: 500, timeout: 60_000 },
        )
        .toBeFalsy();
    });
  });
});
