import {
  AssetMediaResponseDto,
  createUserAdmin,
  getQueuesLegacy,
  IntegrityReportResponseDto,
  login,
  LoginResponseDto,
  ManualJobName,
  QueueCommand,
  QueueName,
  runQueueCommandLegacy,
  signUpAdmin,
  updateAdminOnboarding,
} from '@frameleaf/sdk';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withApiAssetReadiness } from 'src/api-asset-readiness.js';
import { loginDto, signupDto } from 'src/fixtures.js';
import { ownedWait } from 'src/harness-context.js';
import { resetWhilePaused } from 'src/harness-reset.js';
import { withDeadline, type WaitContext } from 'src/harness-wait.js';
import { app, asBearerAuth, testAssetDir, utils } from 'src/utils.js';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Reset 8s + authentication 30s + snapshot 5s + pause 10s + three uploads
// (60s CI / 10s local each) + backup 18s + empty 10s. Reserve another
// 9s for host settlement/self-termination, 10s restoration and 2s settlement.
const INTEGRITY_SETUP_WORK_TIMEOUT = process.env.CI ? 261_000 : 111_000;
const INTEGRITY_SETUP_TIMEOUT = INTEGRITY_SETUP_WORK_TIMEOUT + 21_000;

const assetFilepath = `${testAssetDir}/metadata/gps-position/thompson-springs.jpg`;
const asset1Filepath = `${testAssetDir}/albums/nature/el_torcal_rocks.jpg`;
const asset2Filepath = `${testAssetDir}/albums/nature/wood_anemones.jpg`;

const runIntegrityFixtureCommand = async (context: WaitContext, args: string[], failureMessage: string) => {
  const nativeTimeout = Math.min(5000, Math.floor((context.remaining() - 3000) / 1000) * 1000);
  if (nativeTimeout <= 0) {
    throw new Error('Integrity fixture command refused without a complete native stop budget');
  }
  await new Promise<void>((resolve, reject) => {
    const marker = `FL333_INTEGRITY_DONE_${randomUUID()}`;
    let quarantined = false;
    const quarantine = () => {
      if (quarantined) {
        return;
      }
      quarantined = true;
      // Never resolve/reject into resetWhilePaused while remote work is uncertain.
      // Worker threads share this PID; no parent or unrelated process is killed.
      setTimeout(() => {
        try {
          process.kill(process.pid, 'SIGKILL');
        } catch {
          // eslint-disable-next-line unicorn/no-process-exit -- Throwing could restore queues while remote work remains uncertain.
          process.exit(1);
        }
      }, 1000);
      try {
        process.kill(process.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(process.pid, 'SIGKILL');
        } catch {
          // eslint-disable-next-line unicorn/no-process-exit -- Throwing could restore queues while remote work remains uncertain.
          process.exit(1);
        }
      }
    };
    // Reserve the existing kill allowance 1s and transport settlement 2s.
    const hostTimer = setTimeout(quarantine, nativeTimeout + 3000);
    const child = spawn(
      'docker',
      [
        'exec',
        'immich-e2e-server',
        'sh',
        '-c',
        String.raw`marker=$1; duration=$2; shift 2; timeout --signal=TERM --kill-after=1s "$duration" "$@"; status=$?; printf "%s:%s\n" "$marker" "$status"; exit "$status"`,
        'integrity-fixture',
        marker,
        `${nativeTimeout / 1000}s`,
        ...args,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (quarantined) {
        return;
      }
      if (output.length + chunk.length > 128) {
        quarantine();
        return;
      }
      output += chunk;
    });
    child.once('error', quarantine);
    child.once('close', (code, exitSignal) => {
      if (quarantined) {
        return;
      }
      clearTimeout(hostTimer);
      if (exitSignal || code === null || output !== `${marker}:${code}\n`) {
        quarantine();
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(failureMessage));
      }
    });
  });
  context.remaining();
};

describe('/admin/integrity', () => {
  let admin: LoginResponseDto;
  let asset: AssetMediaResponseDto;

  let user1: LoginResponseDto;
  let asset1: AssetMediaResponseDto;

  let user2: LoginResponseDto;
  let asset2: AssetMediaResponseDto;
  let fixtureRestorationFailed = false;
  let fixtureRestorationFailure: unknown;

  beforeAll(
    withApiAssetReadiness(INTEGRITY_SETUP_WORK_TIMEOUT, async (signal) => {
      await utils.resetDatabase(undefined, signal);
      await ownedWait(
        'Create integrity fixture users',
        30_000,
        async (context) => {
          await signUpAdmin({ signUpDto: signupDto.admin }, { signal: context.signal });
          admin = await login({ loginCredentialDto: loginDto.admin }, { signal: context.signal });
          await updateAdminOnboarding(
            { adminOnboardingUpdateDto: { isOnboarded: true } },
            { headers: asBearerAuth(admin.accessToken), signal: context.signal },
          );
          const users: LoginResponseDto[] = [];
          for (const name of ['1', '2']) {
            context.remaining();
            const credentials = { email: `${name}@example.com`, password: name };
            await createUserAdmin(
              { userAdminCreateDto: { ...credentials, name } },
              { headers: asBearerAuth(admin.accessToken), signal: context.signal },
            );
            users.push(await login({ loginCredentialDto: credentials }, { signal: context.signal }));
          }
          [user1, user2] = users;
        },
        signal,
      );

      await resetWhilePaused({
        // Snapshot only: the first pause write must be inside the protected drain.
        pause: () =>
          ownedWait(
            'Snapshot integrity fixture queues',
            5000,
            async (context) => {
              const queues = await getQueuesLegacy({
                headers: asBearerAuth(admin.accessToken),
                signal: context.signal,
              });
              return Object.values(QueueName)
                .filter((name) => name !== QueueName.IntegrityCheck)
                .map((name) => {
                  const paused = queues[name].queueStatus.isPaused;
                  if (typeof paused !== 'boolean') {
                    throw new TypeError('Queue snapshot did not report authoritative pause state');
                  }
                  return { name, paused };
                });
            },
            signal,
          ),
        drain: async () => {
          await ownedWait(
            'Pause integrity fixture queues',
            10_000,
            async (context) => {
              for (const name of Object.values(QueueName)) {
                if (name === QueueName.IntegrityCheck) {
                  continue;
                }
                context.remaining();
                await runQueueCommandLegacy(
                  { name, queueCommandDto: { command: QueueCommand.Pause } },
                  { headers: asBearerAuth(admin.accessToken), signal: context.signal },
                );
              }
            },
            signal,
          );
          asset = await utils.createAsset(
            admin.accessToken,
            {
              assetData: { filename: 'asset.jpg', bytes: await readFile(assetFilepath, { signal }) },
            },
            { signal },
          );
          asset1 = await utils.createAsset(
            user1.accessToken,
            {
              assetData: { filename: 'asset.jpg', bytes: await readFile(asset1Filepath, { signal }) },
            },
            { signal },
          );
          asset2 = await utils.createAsset(
            user2.accessToken,
            {
              assetData: { filename: 'asset.jpg', bytes: await readFile(asset2Filepath, { signal }) },
            },
            { signal },
          );
          await ownedWait(
            'Back up integrity fixture files',
            18_000,
            async (context) => {
              for (const args of [
                ['mkdir', '-p', '/data/bak'],
                ['cp', '-r', `/data/upload/${admin.userId}`, `/data/bak/${admin.userId}`],
              ]) {
                context.remaining();
                // Only the native wrapper's marker plus matching normal CLI close proves
                // completion. An uncertain stop quarantines this runner before restoration.
                await runIntegrityFixtureCommand(
                  context,
                  args,
                  'Integrity fixture backup command failed after confirmed native completion',
                );
                context.remaining();
              }
            },
            signal,
          );
        },
        mutate: () =>
          ownedWait(
            'Empty integrity fixture queues',
            10_000,
            async (context) => {
              for (const name of Object.values(QueueName)) {
                if (name === QueueName.IntegrityCheck) {
                  continue;
                }
                context.remaining();
                await runQueueCommandLegacy(
                  { name, queueCommandDto: { command: QueueCommand.Empty } },
                  { headers: asBearerAuth(admin.accessToken), signal: context.signal },
                );
              }
            },
            signal,
          ),
        // Independent of the setup signal, including ambiguous/partially applied pauses.
        restore: (snapshot) =>
          withDeadline('Restore integrity fixture queue states', 10_000, async (context) => {
            const failures: unknown[] = [];
            for (const name of Object.values(QueueName)) {
              const queue = snapshot.find((entry) => entry.name === name);
              if (!queue) {
                continue;
              }
              try {
                context.remaining();
                await runQueueCommandLegacy(
                  {
                    name,
                    queueCommandDto: {
                      command: queue.paused ? QueueCommand.Pause : QueueCommand.Resume,
                    },
                  },
                  { headers: asBearerAuth(admin.accessToken), signal: context.signal },
                );
              } catch (error) {
                failures.push(error);
              }
            }
            if (failures.length > 0) {
              throw new AggregateError(failures, 'Integrity fixture queue restoration failed', { cause: failures[0] });
            }
          }),
      });
    }),
    INTEGRITY_SETUP_TIMEOUT,
  );

  beforeEach(() => {
    if (fixtureRestorationFailed) {
      throw fixtureRestorationFailure;
    }
  });

  afterEach(async ({ signal }) => {
    if (fixtureRestorationFailed) {
      throw fixtureRestorationFailure;
    }
    try {
      // A timed-out test signal cannot own this join. Refuse fixture replacement
      // unless admitted server work settles within the existing reset work budget.
      await withDeadline('Settle integrity work before fixture restoration', 8000, async (context) => {
        await utils.settlePendingWaits(signal);
        context.remaining();
        await utils.waitForQueue(admin.accessToken, QueueName.IntegrityCheck, context);
        await runIntegrityFixtureCommand(
          context,
          ['rm', '-rf', `/data/upload/${admin.userId}`],
          'Integrity fixture deletion failed after confirmed native completion',
        );
        await runIntegrityFixtureCommand(
          context,
          ['cp', '-r', `/data/bak/${admin.userId}`, `/data/upload/${admin.userId}`],
          'Integrity fixture restoration failed after confirmed native completion',
        );
      });
    } catch (error) {
      fixtureRestorationFailed = true;
      fixtureRestorationFailure = error;
      throw error;
    }
  });

  describe('GET /runs (FL-81)', async () => {
    it.sequential('records when each check last ran in full', async () => {
      for (const name of [
        ManualJobName.IntegrityUntrackedFiles,
        ManualJobName.IntegrityMissingFiles,
        ManualJobName.IntegrityChecksumMismatch,
      ]) {
        await utils.createJob(admin.accessToken, { name });
      }
      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, body } = await request(app)
        .get('/admin/integrity/runs')
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual({
        missing_file: expect.any(String),
        untracked_file: expect.any(String),
        checksum_mismatch: expect.any(String),
      });
    });

    it('is for administrators only', async () => {
      const { status } = await request(app)
        .get('/admin/integrity/runs')
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(403);
    });
  });

  describe('POST /summary (& jobs)', async () => {
    it.sequential('reports no issues', async () => {
      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityUntrackedFiles,
      });

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityMissingFiles,
      });

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityChecksumMismatch,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityUntrackedFilesDeleteAll,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, body } = await request(app)
        .get('/admin/integrity/summary')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);
      expect(body).toEqual({
        missing_file: 0,
        untracked_file: 0,
        checksum_mismatch: 0,
      });
    });

    it.sequential('should detect an untracked file (job: check untracked files)', async () => {
      await utils.putTextFile('untracked', `/data/upload/${admin.userId}/untracked1.png`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityUntrackedFiles,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, body } = await request(app)
        .get('/admin/integrity/summary')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          untracked_file: 1,
        }),
      );
    });

    it.sequential('should detect outdated untracked file reports (job: refresh untracked files)', async () => {
      // these should not be detected:
      await utils.putTextFile('untracked', `/data/upload/${admin.userId}/untracked2.png`);
      await utils.putTextFile('untracked', `/data/upload/${admin.userId}/untracked3.png`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityUntrackedFilesRefresh,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, body } = await request(app)
        .get('/admin/integrity/summary')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          untracked_file: 0,
        }),
      );
    });

    it.sequential('should delete untracked files (job: delete all untracked file reports)', async () => {
      await utils.putTextFile('untracked', `/data/upload/${admin.userId}/untracked1.png`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityUntrackedFiles,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityUntrackedFilesDeleteAll,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, body } = await request(app)
        .get('/admin/integrity/summary')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          untracked_file: 0,
        }),
      );
    });

    it.sequential('should detect a missing file and not a checksum mismatch (job: check missing files)', async () => {
      await utils.deleteFolder(`/data/upload/${admin.userId}`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityMissingFiles,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, body } = await request(app)
        .get('/admin/integrity/summary')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          missing_file: 1,
          checksum_mismatch: 0,
        }),
      );
    });

    it.sequential('should detect outdated missing file reports (job: refresh missing files)', async () => {
      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityMissingFilesRefresh,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, body } = await request(app)
        .get('/admin/integrity/summary')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          missing_file: 0,
          checksum_mismatch: 0,
        }),
      );
    });

    it.sequential('should delete assets with missing files (job: delete all missing file reports)', async () => {
      await utils.deleteFolder(`/data/upload/${user1.userId}`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityMissingFiles,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status: listStatus, body: listBody } = await request(app)
        .get('/admin/integrity/summary')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(listStatus).toBe(200);
      expect(listBody).toEqual(
        expect.objectContaining({
          missing_file: 1,
        }),
      );

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityMissingFilesDeleteAll,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, body } = await request(app)
        .get('/admin/integrity/summary')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          missing_file: 0,
        }),
      );

      await expect(utils.getAssetInfo(user1.accessToken, asset1.id)).resolves.toEqual(
        expect.objectContaining({
          isTrashed: true,
        }),
      );
    });

    it.sequential('should detect a checksum mismatch (job: check file checksums)', async () => {
      await utils.truncateFolder(`/data/upload/${admin.userId}`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityChecksumMismatch,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, body } = await request(app)
        .get('/admin/integrity/summary')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          checksum_mismatch: 1,
        }),
      );
    });

    it.sequential('should detect outdated checksum mismatch reports (job: refresh file checksums)', async () => {
      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityChecksumMismatchRefresh,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, body } = await request(app)
        .get('/admin/integrity/summary')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          checksum_mismatch: 0,
        }),
      );
    });

    it.sequential(
      'should delete assets with mismatched checksum (job: delete all checksum mismatch reports)',
      async () => {
        await utils.truncateFolder(`/data/upload/${user2.userId}`);

        await utils.createJob(admin.accessToken, {
          name: ManualJobName.IntegrityChecksumMismatch,
        });

        await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

        const { status: listStatus, body: listBody } = await request(app)
          .get('/admin/integrity/summary')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send();

        expect(listStatus).toBe(200);
        expect(listBody).toEqual(
          expect.objectContaining({
            checksum_mismatch: 1,
          }),
        );

        await utils.createJob(admin.accessToken, {
          name: ManualJobName.IntegrityChecksumMismatchDeleteAll,
        });

        await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

        const { status, body } = await request(app)
          .get('/admin/integrity/summary')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send();

        expect(status).toBe(200);
        expect(body).toEqual(
          expect.objectContaining({
            checksum_mismatch: 0,
          }),
        );

        await expect(utils.getAssetInfo(user2.accessToken, asset2.id)).resolves.toEqual(
          expect.objectContaining({
            isTrashed: true,
          }),
        );
      },
    );
  });

  describe('POST /report', async () => {
    it.sequential('reports untracked files', async () => {
      await utils.putTextFile('untracked', `/data/upload/${admin.userId}/untracked1.png`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityUntrackedFiles,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, body } = await request(app)
        .get('/admin/integrity/report?type=untracked_file')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);
      expect(body).toEqual({
        nextCursor: undefined,
        items: expect.arrayContaining([
          {
            id: expect.any(String),
            type: 'untracked_file',
            path: `/data/upload/${admin.userId}/untracked1.png`,
            assetId: null,
            fileAssetId: null,
            createdAt: expect.any(String),
          },
        ]),
      });
    });

    it.sequential('reports missing files', async () => {
      await utils.deleteFolder(`/data/upload/${admin.userId}`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityMissingFiles,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, body } = await request(app)
        .get('/admin/integrity/report?type=missing_file')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);
      expect(body).toEqual({
        nextCursor: undefined,
        items: expect.arrayContaining([
          {
            id: expect.any(String),
            type: 'missing_file',
            path: expect.any(String),
            assetId: asset.id,
            fileAssetId: null,
            createdAt: expect.any(String),
          },
        ]),
      });
    });

    it.sequential('reports checksum mismatched files', async () => {
      await utils.truncateFolder(`/data/upload/${admin.userId}`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityChecksumMismatch,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, body } = await request(app)
        .get('/admin/integrity/report?type=checksum_mismatch')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);
      expect(body).toEqual({
        nextCursor: undefined,
        items: expect.arrayContaining([
          {
            id: expect.any(String),
            type: 'checksum_mismatch',
            path: expect.any(String),
            assetId: asset.id,
            fileAssetId: null,
            createdAt: expect.any(String),
          },
        ]),
      });
    });
  });

  describe('DELETE /report/:id', async () => {
    it.sequential('delete untracked files', async () => {
      await utils.putTextFile('untracked', `/data/upload/${admin.userId}/untracked1.png`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityUntrackedFiles,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status: listStatus, body: listBody } = await request(app)
        .get('/admin/integrity/report?type=untracked_file')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(listStatus).toBe(200);

      const report = (listBody as IntegrityReportResponseDto).items.find(
        (item) => item.path === `/data/upload/${admin.userId}/untracked1.png`,
      )!;

      const { status } = await request(app)
        .delete(`/admin/integrity/report/${report.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityUntrackedFiles,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status: listStatus2, body: listBody2 } = await request(app)
        .get('/admin/integrity/report?type=untracked_file')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(listStatus2).toBe(200);
      expect(listBody2).not.toBe(
        expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({
              id: report.id,
            }),
          ]),
        }),
      );
    });

    it.sequential('delete assets missing files', async () => {
      await utils.deleteFolder(`/data/upload/${admin.userId}`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityMissingFiles,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status: listStatus, body: listBody } = await request(app)
        .get('/admin/integrity/report?type=missing_file')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(listStatus).toBe(200);
      expect(listBody.items.length).toBe(1);

      const report = (listBody as IntegrityReportResponseDto).items[0];

      const { status } = await request(app)
        .delete(`/admin/integrity/report/${report.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityMissingFiles,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status: listStatus2, body: listBody2 } = await request(app)
        .get('/admin/integrity/report?type=missing_file')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(listStatus2).toBe(200);
      expect(listBody2.items.length).toBe(0);
    });

    it.sequential('delete assets with failing checksum', async () => {
      await utils.truncateFolder(`/data/upload/${admin.userId}`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityChecksumMismatch,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status: listStatus, body: listBody } = await request(app)
        .get('/admin/integrity/report?type=checksum_mismatch')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(listStatus).toBe(200);
      expect(listBody.items.length).toBe(1);

      const report = (listBody as IntegrityReportResponseDto).items[0];

      const { status } = await request(app)
        .delete(`/admin/integrity/report/${report.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityChecksumMismatch,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status: listStatus2, body: listBody2 } = await request(app)
        .get('/admin/integrity/report?type=checksum_mismatch')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(listStatus2).toBe(200);
      expect(listBody2.items.length).toBe(0);
    });
  });

  describe('GET /report/:type/csv', () => {
    it.sequential('exports untracked files as csv', async () => {
      await utils.putTextFile('untracked', `/data/upload/${admin.userId}/untracked1.png`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityUntrackedFiles,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { status, headers, text } = await request(app)
        .get('/admin/integrity/report/untracked_file/csv')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      expect(status).toBe(200);
      expect(headers['content-type']).toContain('text/csv');
      expect(headers['content-disposition']).toContain('.csv');
      expect(text).toContain('id,type,assetId,fileAssetId,path');
      expect(text).toContain(`untracked_file`);
      expect(text).toContain(`/data/upload/${admin.userId}/untracked1.png`);
    });
  });

  describe('GET /report/:id/file', () => {
    it.sequential('downloads untracked file', async () => {
      await utils.putTextFile('untracked-content', `/data/upload/${admin.userId}/untracked1.png`);

      await utils.createJob(admin.accessToken, {
        name: ManualJobName.IntegrityUntrackedFiles,
      });

      await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);

      const { body: listBody } = await request(app)
        .get('/admin/integrity/report?type=untracked_file')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send();

      const report = (listBody as IntegrityReportResponseDto).items.find(
        (item) => item.path === `/data/upload/${admin.userId}/untracked1.png`,
      )!;

      const { status, headers, body } = await request(app)
        .get(`/admin/integrity/report/${report.id}/file`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .buffer(true)
        .send();

      expect(status).toBe(200);
      expect(headers['content-type']).toContain('application/octet-stream');
      expect(body.toString()).toBe('untracked-content');
    });
  });
});
