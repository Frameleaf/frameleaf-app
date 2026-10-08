/* eslint-disable unicorn/no-top-level-assignment-in-function */
import {
  AssetMediaCreateDto,
  AssetMediaResponseDto,
  AssetMediaSize,
  AssetMediaStatus,
  AssetResponseDto,
  AssetVisibility,
  CreateAlbumDto,
  CreateLibraryDto,
  JobCreateDto,
  MaintenanceAction,
  ManualJobName,
  MetadataSearchDto,
  Permission,
  PersonCreateDto,
  QueueCommandDto,
  QueueName,
  QueuesResponseLegacyDto,
  SharedLinkCreateDto,
  UpdateLibraryDto,
  UserAdminCreateDto,
  UserPreferencesUpdateDto,
  ValidateLibraryDto,
  cancelMediaOperation,
  createAlbum,
  createApiKey,
  createJob,
  createLibrary,
  createPartner,
  createPerson,
  createSharedLink,
  createStack,
  createUserAdmin,
  deleteAssets,
  deleteConfigCredential,
  deleteDatabaseBackup,
  emptyQueue,
  getAssetInfo,
  getConfig,
  getConfigCredentials,
  getConfigDefaults,
  getQueue,
  getQueues,
  getRemoteAccess,
  listDatabaseBackups,
  login,
  removeRemoteHostname,
  runQueueCommandLegacy,
  scanLibrary,
  searchAssets,
  setBaseUrl,
  setMaintenanceMode,
  signUpAdmin,
  tagAssets,
  updateAdminOnboarding,
  updateAlbumUser,
  updateAssets,
  updateConfig,
  updateLibrary,
  updateMyPreferences,
  updateRemoteAccess,
  upsertTags,
  validate,
  viewAsset,
} from '@frameleaf/sdk';
import { BrowserContext } from '@playwright/test';
import { exec, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as setAsyncTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import { amendBackupFixture } from 'src/backup-fixture.js';
import { loginDto, signupDto } from 'src/fixtures.js';
import { makeRandomImage } from 'src/generators.js';
import { ownedWait, settlePendingWaits } from 'src/harness-context.js';
import { assertResetExecutionsStopped, drainAfterExecutorStop } from 'src/harness-reset-executions.mjs';
import { resetWhilePaused, type QueuePauseSnapshot } from 'src/harness-reset.js';
import {
  EventJournal,
  pollRequest,
  requestOnce,
  waitUntil,
  withDeadline,
  type EventType,
  type WaitContext,
} from 'src/harness-wait.js';
import request from 'supertest';
import { playwrightDbHost, playwrightHost, playwriteBaseUrl } from '../playwright.config';

export type { Emitter } from '@socket.io/component-emitter';

type CommandResponse = { stdout: string; stderr: string; exitCode: number | null };
type WaitOptions = { event: EventType; id?: string; total?: number; timeout?: number; signal?: AbortSignal };
type AdminSetupOptions = { onboarding?: boolean };
type FileData = { bytes?: Buffer; filename: string };

const dbUrl = `postgres://postgres:postgres@${playwrightDbHost}:5435/frameleaf`;
export const baseUrl = playwriteBaseUrl;
export const shareUrl = `${baseUrl}/share`;
export const app = `${baseUrl}/api`;
// TODO move test assets into e2e/assets
export const testAssetDir = resolve(import.meta.dirname, '../test-assets');
export const testAssetDirInternal = '/test-assets';
export const tempDir = tmpdir();
export const asBearerAuth = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });
export const asKeyAuth = (key: string) => ({ 'x-api-key': key });
export const immichCli = (args: string[]) =>
  executeCommand(
    process.execPath,
    [resolve(import.meta.dirname, '../../packages/cli/bin/immich'), '-d', `/${tempDir}/immich/`, ...args],
    { cwd: '../packages/cli' },
  ).promise;
export const dockerExec = (args: string[]) =>
  executeCommand('docker', ['exec', '-i', 'immich-e2e-server', '/bin/bash', '-c', args.join(' ')]);
export const immichAdmin = (args: string[]) => dockerExec([`frameleaf-admin ${args.join(' ')}`]);
export const specialCharStrings = ["'", '"', ',', '{', '}', '*'];
export const TEN_TIMES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const executeCommand = (command: string, args: string[], options?: { cwd?: string }) => {
  let _resolve: (value: CommandResponse) => void;
  const promise = new Promise<CommandResponse>((resolve) => (_resolve = resolve));
  const child = spawn(command, args, { stdio: 'pipe', cwd: options?.cwd });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => (stdout += data.toString()));
  child.stderr.on('data', (data) => (stderr += data.toString()));
  child.on('exit', (exitCode) => {
    _resolve({
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    });
  });

  return { promise, child };
};

let client: pg.Client | null = null;
let connecting: Promise<pg.Client> | undefined;
let resetting = false;
let resetFailure: unknown;

const events = new EventJournal();

const execPromise = promisify(exec);

const isTransientDatabaseError = (error: unknown) => {
  const candidate = error as NodeJS.ErrnoException & { code?: string; message?: string };
  const message = candidate?.message ?? '';
  return (
    candidate?.code === '40P01' ||
    candidate?.code === 'ECONNREFUSED' ||
    candidate?.code === 'ECONNRESET' ||
    message.includes('Connection terminated unexpectedly') ||
    message.includes('connect ECONNREFUSED')
  );
};

const onEvent = ({ event, id }: { event: EventType; id: string }) => {
  events.add(event, id);
};

const queueWaitTimeout = () => (process.env.CI ? 60_000 : 10_000);
const readQueue = async (accessToken: string, name: QueueName, context: WaitContext) => {
  context.remaining();
  const queue = await getQueue({ name }, { headers: asBearerAuth(accessToken), signal: context.signal });
  context.remaining();
  if (typeof queue.hasUnfinishedWork !== 'boolean') {
    throw new TypeError(`Queue ${name} did not report authoritative unfinished work`);
  }
  return queue;
};

const readQueues = async (accessToken: string, context: WaitContext) => {
  context.remaining();
  const queues = await getQueues({ headers: asBearerAuth(accessToken), signal: context.signal });
  context.remaining();
  const names = Object.values(QueueName);
  if (
    !Array.isArray(queues) ||
    queues.length !== names.length ||
    names.some((name) => queues.filter((queue) => queue?.name === name).length !== 1) ||
    queues.some((queue) => typeof queue.hasUnfinishedWork !== 'boolean')
  ) {
    throw new TypeError('Queues did not report complete authoritative unfinished work');
  }
  return queues;
};

const waitForQueue = (accessToken: string, name: QueueName, context: WaitContext) =>
  waitUntil(
    context,
    (current) => readQueue(accessToken, name, current),
    (queue) => {
      if (queue.hasUnfinishedWork) {
        return false;
      }
      if (queue.statistics.failed > 0) {
        throw new Error(
          `Queue ${name} has ${queue.statistics.failed} failed or blocked jobs; it did not complete successfully`,
        );
      }
      return true;
    },
  );

/** Whether the server is in (or restarting out of) maintenance mode. */
const isInMaintenance = async () => {
  try {
    const response = await fetch(`${app}/server/config`);
    if (!response.ok) {
      return true;
    }
    const config = await response.json();
    return config.maintenanceMode === true;
  } catch {
    // restarting
    return true;
  }
};

export const utils = {
  connectDatabase: async () => {
    if (client) {
      return client;
    }
    if (connecting) {
      return connecting;
    }
    const pending = ownedWait('Connecting test database', 8000, async (context) => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        context.remaining();
        const nextClient = new pg.Client({
          connectionString: dbUrl,
          connectionTimeoutMillis: Math.min(1000, context.remaining()),
        });
        const forget = () => {
          if (client === nextClient) {
            client = null;
          }
        };
        nextClient.on('end', forget).on('error', forget);
        try {
          await nextClient.connect();
          context.remaining();
          client = nextClient;
          return nextClient;
        } catch (error) {
          try {
            await nextClient.end();
          } catch (error_) {
            throw new AggregateError([error, error_], 'Test database connection and cleanup failed', { cause: error_ });
          }
          context.remaining();
          if (attempt === 5 || !isTransientDatabaseError(error)) {
            throw error;
          }
          await setAsyncTimeout(Math.min(500 * attempt, context.remaining()), undefined, { signal: context.signal });
        }
      }
      throw new Error('Failed to connect to database');
    });
    connecting = pending;
    try {
      return await pending;
    } finally {
      if (connecting === pending) {
        connecting = undefined;
      }
    }
  },

  disconnectDatabase: async (expected?: pg.Client | null) => {
    const owned = expected === undefined ? (client ?? (connecting ? await connecting : null)) : expected;
    if (!owned) {
      return;
    }
    if (client === owned) {
      client = null;
    }
    await owned.end();
  },

  /** Own the paused interval through mutation, then restore exactly the original queue settings.
   * Never fabricate job completion or stopped proof. The public clear API and real coordinator
   * settle cancelled work; a reset that cannot prove quiescence refuses to delete fixture data.
   */
  drainQueues: async (
    mutate?: (db: pg.Client, context: WaitContext) => Promise<void>,
    signal?: AbortSignal,
    resetConfig = false,
  ) => {
    if (resetting || resetFailure) {
      throw new Error(
        resetting ? 'Another database reset is still running' : 'Previous database reset did not settle safely',
        { cause: resetFailure },
      );
    }
    resetting = true;
    const started = performance.now();
    let phase = 'connect';
    let cleanupPhase = 'not started';
    let lastUnfinished: boolean | undefined;
    try {
      await ownedWait(
        'Resetting test database',
        8000,
        async (total) => {
          const cleanupDeadline = performance.now() + 8000;
          const cleanupBudget = () => {
            const remaining = Math.floor(cleanupDeadline - performance.now());
            if (remaining <= 0) {
              throw new Error('Reset cleanup deadline expired');
            }
            return Math.min(2000, remaining);
          };
          const db = new pg.Client({
            connectionString: dbUrl,
            connectionTimeoutMillis: 1000,
            statement_timeout: 1000,
            lock_timeout: 1000,
          });
          // This client belongs only to this reset; it is never the shared assertion client.
          db.on('error', () => {});
          let primary: unknown;
          let failed = false;
          const sessions = new Map<string, { token: string; hashed: Buffer }>();
          let resetAdminId: string | undefined;
          const query = async (context: WaitContext, text: string, values?: unknown[]) => {
            const timeout = Math.min(1000, context.remaining());
            await db.query(`SELECT set_config('statement_timeout', $1, false), set_config('lock_timeout', $1, false)`, [
              `${timeout}ms`,
            ]);
            context.remaining();
            return db.query(text, values);
          };
          try {
            await db.connect();
            const context = total;
            const ownerToken = async (context: WaitContext, ownerId: string) => {
              const existing = sessions.get(ownerId);
              if (existing) {
                return existing.token;
              }
              const token = randomBytes(32).toString('hex');
              const hashed = createHash('sha256').update(token).digest();
              // Record ownership before the write so an ambiguous insert is still cleaned up.
              sessions.set(ownerId, { token, hashed });
              await query(context, `INSERT INTO "session" ("userId", token) VALUES ($1, $2)`, [ownerId, hashed]);
              return token;
            };
            const unfinishedOperations = async (context: WaitContext, id?: string) => {
              const { rows } = await query(
                context,
                `SELECT id, "ownerId", status, "cancelRequestedAt",
            "claimToken" IS NOT NULL AS claimed,
            "remoteJobId" IS NOT NULL AND "remoteReleasedAt" IS NULL AS "remotePending"
            FROM media_operation WHERE ($1::uuid IS NULL OR id = $1::uuid) AND (
              status NOT IN ('completed', 'cancelled', 'failed') OR "claimToken" IS NOT NULL
              OR ("remoteJobId" IS NOT NULL AND "remoteReleasedAt" IS NULL))
            ORDER BY id LIMIT 251`,
                [id ?? null],
              );
              if (rows.length > 250) {
                throw new Error('Reset refused: more than 250 unfinished media operations require owner cleanup');
              }
              return rows;
            };
            const cancelOperations = async (context: WaitContext) => {
              const operations = await unfinishedOperations(context);
              for (const operation of operations) {
                if (['completed', 'cancelled', 'failed'].includes(operation.status)) {
                  throw new Error(
                    `Reset refused: media operation ${operation.id} still has ${operation.remotePending ? 'unreleased remote work' : 'an unsettled worker claim'}`,
                  );
                }
                if (operation.cancelRequestedAt !== null) {
                  continue;
                }
                try {
                  await cancelMediaOperation(
                    { id: operation.id },
                    {
                      headers: asBearerAuth(await ownerToken(context, operation.ownerId)),
                      signal: context.signal,
                    },
                  );
                } catch (error) {
                  // A normal completion may win the cancellation race. It is safe only once the
                  // actual row has no live claim or retained remote-cleanup obligation.
                  let remaining;
                  try {
                    remaining = await unfinishedOperations(context, operation.id);
                  } catch (error_) {
                    throw new AggregateError(
                      [error, error_],
                      `Reset could not confirm media operation ${operation.id} stopped`,
                      { cause: error_ },
                    );
                  }
                  if (remaining.length > 0) {
                    throw new Error(
                      `Reset refused: owner cancellation of media operation ${operation.id} (${operation.status}) was not accepted`,
                      { cause: error },
                    );
                  }
                }
              }
              return operations.length > 0;
            };
            phase = 'authenticate reset';
            const { rows: admins } = await query(
              context,
              `SELECT id FROM "user" WHERE "isAdmin" AND "deletedAt" IS NULL LIMIT 1`,
            );
            let token = admins.length > 0 ? await ownerToken(context, admins[0].id) : undefined;
            const drain = () =>
              withDeadline(
                'Quiescing test database',
                Math.min(6000, total.remaining()),
                async (context) => {
                  phase = 'request active-job cancellation';
                  await query(
                    context,
                    `UPDATE job SET "cancelRequestedAt" = coalesce("cancelRequestedAt", now()), "cancelReason" = 'request' WHERE state = 'active'`,
                  );
                  await waitUntil(
                    context,
                    async () => {
                      // Independent bulk/render/import workers do not claim from job_queue. Cancel
                      // through the owner's real API, preserving edit refusal and remote cleanup.
                      phase = 'cancel media operations';
                      await cancelOperations(context);
                      phase = 'confirm executor stop';
                      return drainAfterExecutorStop(
                        (text) => query(context, text),
                        async () => {
                          if (!token) {
                            phase = 'inspect unauthenticated work';
                            // Periodic jobs can be admitted without an administrator. They cannot drain
                            // while paused, so use owned fixture authentication for the normal clear API.
                            const { rows } = await query(
                              context,
                              `SELECT
                    EXISTS (SELECT 1 FROM job WHERE state IN ('pending','waiting','active'))
                    OR EXISTS (SELECT 1 FROM job_selection WHERE state IN ('enumerating','ready'))
                    OR EXISTS (SELECT 1 FROM job_selection_run m JOIN job_selection s ON s.id = m."selectionId"
                      WHERE NOT m."copyComplete" OR (m."runId" <> s."runId" AND m."libraryVersion" < s."appendSequence"))
                    OR EXISTS (SELECT 1 FROM job_run_item WHERE "jobId" IS NULL AND "selectionId" IS NULL AND state IN ('pending','waiting','active')) unfinished`,
                            );
                            if (!rows[0].unfinished && !resetConfig) {
                              const operations = await unfinishedOperations(context);
                              return operations.length > 0;
                            }
                            // Record ownership before the atomic write, including an ambiguous response.
                            // No signup/onboarding hooks or existing account promotion are involved.
                            resetAdminId = randomUUID();
                            await query(
                              context,
                              `WITH owned_group AS (
                              INSERT INTO cluster_group (id) VALUES ($1) RETURNING id
                            ) INSERT INTO "user" (id, email, "isAdmin", "clusterGroupId")
                              SELECT id, $2, true, id FROM owned_group`,
                              [resetAdminId, `reset-${resetAdminId}@example.invalid`],
                            );
                            token = await ownerToken(context, resetAdminId);
                          }
                          const headers = asBearerAuth(token);
                          phase = 'read queues before clear';
                          const before = await readQueues(token, context);
                          lastUnfinished = before.some((queue) => queue.hasUnfinishedWork);
                          phase = 'inspect sensitive library intents';
                          const { rows: dirtyIntents } = await query(
                            context,
                            `SELECT DISTINCT queue FROM job_run_item WHERE "jobId" IS NULL
                            AND "libraryIntent"->>'sensitive' = 'true'
                            AND ("libraryIntent" ? 'options' OR "libraryIntent"->'data' != '{}'::jsonb)`,
                          );
                          const dirtyQueues = new Set(dirtyIntents.map((row) => row.queue));
                          for (const queue of before) {
                            if (
                              !queue.hasUnfinishedWork &&
                              queue.statistics.failed === 0 &&
                              !dirtyQueues.has(queue.name)
                            ) {
                              continue;
                            }
                            const name = queue.name;
                            phase = `clear queue ${name}`;
                            context.remaining();
                            await emptyQueue(
                              { name, queueDeleteDto: { failed: true } },
                              { headers, signal: context.signal },
                            );
                          }
                          phase = 'read all queues';
                          const queues = await readQueues(token, context);
                          const unfinished = queues.some((queue) => queue.hasUnfinishedWork);
                          lastUnfinished = unfinished;
                          if (unfinished) {
                            return true;
                          }
                          phase = 'inspect media operations';
                          const operations = await unfinishedOperations(context);
                          return operations.length > 0;
                        },
                      );
                    },
                    (unfinished) => !unfinished,
                    100,
                  );
                },
                total.signal,
              );
            await resetWhilePaused({
              pause: async () => {
                phase = 'pause queues';
                await query(context, 'BEGIN');
                try {
                  const { rows } = await query(context, 'SELECT name, paused FROM job_queue ORDER BY name FOR UPDATE');
                  await query(context, 'UPDATE job_queue SET paused = true');
                  await query(context, 'COMMIT');
                  return rows as QueuePauseSnapshot;
                } catch (error) {
                  await db.query('ROLLBACK');
                  throw error;
                }
              },
              drain,
              mutate: async () => {
                if (resetConfig) {
                  phase = 'reset fixture configuration';
                  context.remaining();
                  await utils.resetAdminConfig(token!, context.signal);
                  await drain();
                }
                phase = 'confirm stop before mutation';
                context.remaining();
                // Recheck retained attempts after terminal clearing and immediately before the
                // callback that can delete fixtures. Cleared state/data never substitute for proof.
                await assertResetExecutionsStopped((text) => query(context, text));
                phase = 'mutate fixtures';
                await mutate?.(db, context);
              },
              restore: (snapshot) =>
                withDeadline('Restoring queue pause settings', cleanupBudget(), async (cleanup) => {
                  cleanupPhase = 'restore queue settings';
                  await query(cleanup, 'BEGIN');
                  try {
                    if (resetAdminId) {
                      // Revocation cascades to this fixture's sessions. Full reset may already have
                      // truncated these rows; partial/failed resets still remove only our identity.
                      await query(cleanup, 'DELETE FROM "user" WHERE id = $1', [resetAdminId]);
                      await query(cleanup, 'DELETE FROM user_audit WHERE "userId" = $1', [resetAdminId]);
                      await query(cleanup, 'DELETE FROM cluster_group WHERE id = $1', [resetAdminId]);
                    }
                    await query(
                      cleanup,
                      `UPDATE job_queue q SET paused = original.paused
              FROM jsonb_to_recordset($1::jsonb) AS original(name text, paused boolean) WHERE q.name = original.name`,
                      [JSON.stringify(snapshot)],
                    );
                    await query(cleanup, 'COMMIT');
                  } catch (error) {
                    await db.query('ROLLBACK');
                    throw error;
                  }
                }),
            });
          } catch (error) {
            failed = true;
            primary = error;
          }
          try {
            if (sessions.size > 0) {
              cleanupPhase = 'remove reset sessions';
              await withDeadline('Removing reset session', cleanupBudget(), (cleanup) =>
                query(cleanup, 'DELETE FROM "session" WHERE token = ANY($1::bytea[])', [
                  sessions
                    .values()
                    .map(({ hashed }) => hashed)
                    .toArray(),
                ]),
              );
            }
          } catch (error) {
            primary = failed
              ? new AggregateError([primary, error], 'Reset and temporary session cleanup failed', { cause: error })
              : error;
            failed = true;
          } finally {
            try {
              cleanupPhase = 'close reset connection';
              await db.end();
            } catch (error) {
              primary = failed
                ? new AggregateError([primary, error], 'Reset and owned connection cleanup failed', { cause: error })
                : error;
              failed = true;
            }
          }
          if (failed) {
            throw primary;
          }
        },
        signal,
      );
    } catch (error) {
      // Do not let a retry/new test mutate data after uncertain cancellation or cleanup.
      resetFailure = new Error(
        `Reset failed: lastControlPhase=${phase}; lastCleanupPhase=${cleanupPhase}; elapsedMs=${Math.round(performance.now() - started)}; lastUnfinished=${lastUnfinished ?? 'unknown'}`,
        { cause: error },
      );
      throw resetFailure;
    } finally {
      resetting = false;
    }
  },

  resetDatabase: async (tables?: string[], signal?: AbortSignal) => {
    const partial = tables !== undefined;
    const selected = tables ?? [
      'stack',
      'library',
      'shared_link',
      'person',
      'person_group',
      'cluster_group',
      'album',
      'asset',
      'asset_face',
      'activity',
      'api_key',
      'session',
      'user',
      'system_metadata',
      'tag',
      'integrity_report',
    ];
    if (selected.some((table) => !/^[a-z_]+$/.test(table))) {
      throw new Error('Invalid reset table name');
    }
    await utils.drainQueues(
      async (db, context) => {
        const timeout = Math.min(1000, context.remaining());
        await db.query('BEGIN');
        try {
          await db.query(`SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)`, [
            `${timeout}ms`,
          ]);
          if (selected.includes('system_metadata')) {
            // Delete fixture configuration only. Coordinator cursors, attempt/worker stopped proof,
            // stable server identity and future operational metadata survive ordinary test resets.
            // MediaLocation must survive too: a restarted worker needs it to validate files created after reset.
            await db.query('DELETE FROM system_metadata WHERE key = ANY($1::text[])', [
              [
                'facial-recognition-state',
                'memories-state',
                'admin-onboarding',
                'maintenance-mode',
                'version-check-state',
                'physical-deduplication-migration',
                'frameleaf-cloud-link',
                'frameleaf-service-discovery',
                'frameleaf-ml-wallet',
                'frameleaf-license',
                'frameleaf-pricing',
                'frameleaf-ml-suspension',
                'frameleaf-cloud-backup',
                'frameleaf-remote-access',
                'frameleaf-remote-access-test',
                'hardware-check',
                'frameleaf-cloud-migration-notice',
                'frameleaf-cloud-description-queue',
                'frameleaf-cloud-description-estimates',
                'frameleaf-cloud-ml-job-estimates',
                'integrity-checksum-checkpoint',
                'locked-detections-state',
                'system-config-history',
                'integrity-check-runs',
                'backup-restore-verification',
                'frameleaf-setup',
              ],
            ]);
          }
          const dataTables = selected.filter((table) => table !== 'system_metadata');
          if (partial) {
            for (const table of dataTables) {
              context.remaining();
              await db.query(`DELETE FROM "${table}"`);
            }
          } else if (dataTables.length > 0) {
            context.remaining();
            await db.query(`TRUNCATE ${dataTables.map((table) => `"${table}"`).join(', ')} CASCADE`);
          }
          context.remaining();
          await db.query('COMMIT');
        } catch (error) {
          try {
            await db.query('ROLLBACK');
          } catch (error_) {
            throw new AggregateError([error, error_], 'Fixture reset and rollback failed', { cause: error_ });
          }
          throw error;
        }
      },
      signal,
      selected.includes('system_metadata'),
    );
  },

  unzip: async (input: string, output: string) => {
    await execPromise(`unzip -o -d "${output}" "${input}"`);
  },

  sha1: (bytes: Buffer) => createHash('sha1').update(bytes).digest('base64'),

  sha256: (bytes: Buffer) => createHash('sha256').update(bytes).digest('base64'),

  connectWebsocket: async (accessToken: string, signal?: AbortSignal) => {
    let websocket: Socket | undefined;
    try {
      return await ownedWait(
        'Websocket connection',
        10_000,
        async (context) => {
          const socket = io(baseUrl, {
            path: '/api/socket.io',
            transports: ['websocket'],
            extraHeaders: asBearerAuth(accessToken),
            autoConnect: false,
            reconnection: false,
            forceNew: true,
            timeout: context.remaining(),
          });
          websocket = socket;
          return new Promise<Socket>((resolve, reject) => {
            const cleanup = () => {
              context.signal.removeEventListener('abort', abort);
              socket.off('connect', connected).off('connect_error', failed);
            };
            const failed = (error: Error) => {
              cleanup();
              socket.removeAllListeners();
              socket.disconnect();
              reject(error);
            };
            const abort = () => failed(context.signal.reason);
            const connected = () => {
              if (context.signal.aborted) {
                abort();
                return;
              }
              cleanup();
              resolve(socket);
            };
            context.signal.addEventListener('abort', abort, { once: true });
            socket
              .once('connect', connected)
              .once('connect_error', failed)
              .on('on_upload_success', (data: AssetResponseDto) => onEvent({ event: 'assetUpload', id: data.id }))
              .on('on_asset_update', (data: AssetResponseDto) => onEvent({ event: 'assetUpdate', id: data.id }))
              .on('on_asset_hidden', (assetId: string) => onEvent({ event: 'assetHidden', id: assetId }))
              .on('on_asset_delete', (assetId: string) => onEvent({ event: 'assetDelete', id: assetId }))
              .on('on_user_delete', (userId: string) => onEvent({ event: 'userDelete', id: userId }));
            if (context.signal.aborted) {
              abort();
            } else {
              socket.connect();
            }
          });
        },
        signal,
      );
    } catch (error) {
      // Cover a connection granted at the deadline, after its connect callback removed
      // the listener but before ownedWait accepted the result.
      websocket?.removeAllListeners();
      websocket?.disconnect();
      throw error;
    }
  },

  disconnectWebsocket: (ws: Socket) => {
    ws?.removeAllListeners();
    ws?.disconnect();
    events.clear();
  },

  resetEvents: () => {
    events.clear();
  },

  waitForWebsocketEvent: ({ event, id, total, timeout = 10_000, signal }: WaitOptions): Promise<void> =>
    ownedWait(
      `Waiting for ${event} event`,
      timeout,
      (context) => events.wait({ event, id, total, signal: context.signal }),
      signal,
    ),

  settlePendingWaits,
  waitForQueue,

  initSdk: () => {
    setBaseUrl(app);
  },

  adminSetup: async (options?: AdminSetupOptions) => {
    options ||= { onboarding: true };

    await signUpAdmin({ signUpDto: signupDto.admin });
    const response = await login({ loginCredentialDto: loginDto.admin });
    if (options.onboarding) {
      await updateAdminOnboarding(
        { adminOnboardingUpdateDto: { isOnboarded: true } },
        { headers: asBearerAuth(response.accessToken) },
      );
    }
    return response;
  },

  userSetup: async (accessToken: string, dto: UserAdminCreateDto) => {
    await createUserAdmin({ userAdminCreateDto: dto }, { headers: asBearerAuth(accessToken) });
    return login({
      loginCredentialDto: { email: dto.email, password: dto.password },
    });
  },

  createApiKey: (accessToken: string, permissions: Permission[]) => {
    return createApiKey({ apiKeyCreateDto: { name: 'e2e', permissions } }, { headers: asBearerAuth(accessToken) });
  },

  createAlbum: (accessToken: string, dto: CreateAlbumDto) =>
    createAlbum({ createAlbumDto: dto }, { headers: asBearerAuth(accessToken) }),

  updateAlbumUser: (accessToken: string, args: Parameters<typeof updateAlbumUser>[0]) =>
    updateAlbumUser(args, { headers: asBearerAuth(accessToken) }),

  createAsset: async (
    accessToken: string,
    dto?: Partial<Omit<AssetMediaCreateDto, 'assetData' | 'sidecarData'>> & {
      assetData?: FileData;
      sidecarData?: FileData;
    },
    options: { signal?: AbortSignal; timeout?: number } = {},
  ) => {
    const _dto = {
      fileCreatedAt: new Date().toISOString(),
      fileModifiedAt: new Date().toISOString(),
      ...dto,
    };

    // Large enough for the real person-thumbnail crop used by createFace fixtures.
    const assetData = dto?.assetData?.bytes || makeRandomImage(32, 32);
    const filename = dto?.assetData?.filename || 'example.png';

    if (dto?.assetData?.bytes) {
      console.log(`Uploading ${filename}`);
    }

    const builder = request(app)
      .post(`/assets`)
      .attach('assetData', assetData, filename)
      .set('Authorization', `Bearer ${accessToken}`);

    if (dto?.sidecarData?.bytes) {
      void builder.attach('sidecarData', dto.sidecarData.bytes, dto.sidecarData.filename);
    }

    for (const [key, value] of Object.entries(_dto)) {
      void builder.field(key, String(value));
    }

    const { body, status } = await ownedWait(
      'Uploading test asset',
      options.timeout ?? queueWaitTimeout(),
      (context) => requestOnce<request.Response>(context, () => builder),
      options.signal,
    );
    if (
      (status !== 201 || body.status !== AssetMediaStatus.Created) &&
      (status !== 200 || body.status !== AssetMediaStatus.Duplicate)
    ) {
      throw new Error(`Asset upload failed: HTTP ${status}, status ${String(body.status)}`);
    }
    if (typeof body.id !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(body.id)) {
      throw new Error('Asset upload did not return a valid asset id');
    }
    return body as AssetMediaResponseDto;
  },

  createImageFile: (path: string) => {
    if (!existsSync(dirname(path))) {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(path, makeRandomImage());
  },

  createDirectory: (path: string) => {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  },

  removeImageFile: (path: string) => {
    if (!existsSync(path)) {
      return;
    }

    rmSync(path);
  },

  renameImageFile: (oldPath: string, newPath: string) => {
    if (!existsSync(oldPath)) {
      return;
    }

    renameSync(oldPath, newPath);
  },

  removeDirectory: (path: string) => {
    if (!existsSync(path)) {
      return;
    }

    rmSync(path, { recursive: true });
  },

  getSystemConfig: (accessToken: string) => getConfig({ headers: asBearerAuth(accessToken) }),

  getAssetInfo: (accessToken: string, id: string) => getAssetInfo({ id }, { headers: asBearerAuth(accessToken) }),

  searchAssets: async (accessToken: string, dto: MetadataSearchDto) => {
    return searchAssets({ metadataSearchDto: dto }, { headers: asBearerAuth(accessToken) });
  },

  archiveAssets: (accessToken: string, ids: string[]) =>
    updateAssets(
      { assetBulkUpdateDto: { ids, visibility: AssetVisibility.Archive } },
      { headers: asBearerAuth(accessToken) },
    ),

  deleteAssets: (accessToken: string, ids: string[]) =>
    deleteAssets({ assetBulkDeleteDto: { ids } }, { headers: asBearerAuth(accessToken) }),

  createPerson: async (accessToken: string, dto?: PersonCreateDto) => {
    const person = await createPerson({ personCreateDto: dto || {} }, { headers: asBearerAuth(accessToken) });
    await utils.setPersonThumbnail(person.id);

    return person;
  },

  /**
   * FL-195: a lock record as a sensitive-content detection or the upgrade from the old Locked folder
   * writes it, which no endpoint can create on demand.
   */
  setAssetLock: async (assetId: string, reason: 'marked' | 'detected' | 'immich-locked-folder') => {
    const db = await utils.connectDatabase();

    await db.query(
      `INSERT INTO asset_lock ("assetId", reason, "previousVisibility") VALUES ($1, $2, $3)
       ON CONFLICT ("assetId") DO UPDATE SET reason = excluded.reason, "previousVisibility" = excluded."previousVisibility"`,
      [assetId, reason, reason === 'immich-locked-folder' ? 'locked' : null],
    );
  },

  /**
   * FL-195 follow-up: a published Studio export in the owner's library, made from these sources before
   * any of them was locked, as a render and its publication write it. Rendering needs a render worker,
   * which the API e2e stack does not run.
   */
  seedStudioExport: async ({
    ownerId,
    projectId,
    resultAssetId,
    sourceAssetIds,
    version,
  }: {
    ownerId: string;
    projectId: string;
    resultAssetId: string;
    sourceAssetIds: string[];
    version: number;
  }) => {
    const db = await utils.connectDatabase();

    const { rows } = await db.query(
      `INSERT INTO studio_export_version
         ("ownerId", "projectId", revision, "revisionDigest", state, version, scope, destination, settings,
          "resultAssetId", privacy, "publishedAt")
       VALUES ($1, $2, 1, 'e2e', 'published', $5, 'library', 'local', '{}'::jsonb, $3,
          jsonb_build_object('lockReason', null, 'sourceCount', $4::int), now())
       RETURNING id`,
      [ownerId, projectId, resultAssetId, sourceAssetIds.length, version],
    );
    const [row] = rows;
    for (const assetId of sourceAssetIds) {
      await db.query(
        `INSERT INTO studio_export_version_source
           ("versionId", key, kind, "resourceId", "assetId", "ownerId", "sourceAccess", locked)
         VALUES ($1, $2, 'library-asset', $3::text, $3::uuid, $4, 'owner', false)`,
        [row.id, `library-asset:${assetId}`, assetId, ownerId],
      );
    }
    return row.id as string;
  },

  createFace: async ({
    assetId,
    personGroupId,
    imageWidth = 32,
    imageHeight = 32,
  }: {
    assetId: string;
    personGroupId: string;
    imageWidth?: number;
    imageHeight?: number;
  }) => {
    const db = await utils.connectDatabase();

    await db.query(
      `INSERT INTO asset_face ("assetId", "personGroupId", "imageWidth", "imageHeight",
         "boundingBoxX1", "boundingBoxY1", "boundingBoxX2", "boundingBoxY2")
       VALUES ($1, $2, $3, $4, 0, 0, $3, $4)`,
      [assetId, personGroupId, imageWidth, imageHeight],
    );
  },

  /**
   * FL-37: a face with a recognition embedding that becomes the person's featured face, which is
   * what `GET /people/merge-suggestions` compares. `seed` picks the direction of the 512-d vector:
   * the same seed gives two people identical faces (a suggestion), different seeds orthogonal ones.
   */
  createFeaturedFaceWithEmbedding: async ({
    assetId,
    personGroupId,
    seed,
  }: {
    assetId: string;
    personGroupId: string;
    seed: number;
  }) => {
    const db = await utils.connectDatabase();

    const embedding = Array.from({ length: 512 }, (_, index) => (index === seed % 512 ? 1 : 0.001));
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO asset_face ("assetId", "personGroupId") VALUES ($1, $2) RETURNING id',
      [assetId, personGroupId],
    );
    const faceId = rows[0].id;
    await db.query('INSERT INTO face_search ("faceId", embedding) VALUES ($1, $2)', [
      faceId,
      `[${embedding.join(',')}]`,
    ]);
    await db.query('UPDATE "person" SET "faceAssetId" = $1 WHERE "personGroupId" = $2', [faceId, personGroupId]);
    return faceId;
  },

  /** FL-38: a face as face detection stores it (machine-learning source), with a real box. */
  createDetectedFace: async ({
    assetId,
    personGroupId,
    imageWidth,
    imageHeight,
    box,
  }: {
    assetId: string;
    personGroupId: string | null;
    imageWidth: number;
    imageHeight: number;
    box: { x1: number; y1: number; x2: number; y2: number };
  }) => {
    const db = await utils.connectDatabase();

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO asset_face ("assetId", "personGroupId", "imageWidth", "imageHeight", "boundingBoxX1", "boundingBoxY1", "boundingBoxX2", "boundingBoxY2", "sourceType")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'machine-learning') RETURNING id`,
      [assetId, personGroupId, imageWidth, imageHeight, box.x1, box.y1, box.x2, box.y2],
    );
    return rows[0].id;
  },

  setPersonThumbnail: async (personId: string) => {
    const db = await utils.connectDatabase();

    await db.query(`UPDATE "person" set "thumbnailPath" = '/my/awesome/thumbnail.jpg' where "personGroupId" = $1`, [
      personId,
    ]);
  },

  createSharedLink: (accessToken: string, dto: SharedLinkCreateDto) =>
    createSharedLink({ sharedLinkCreateDto: dto }, { headers: asBearerAuth(accessToken) }),

  createLibrary: (accessToken: string, dto: CreateLibraryDto) =>
    createLibrary({ createLibraryDto: dto }, { headers: asBearerAuth(accessToken) }),

  validateLibrary: (accessToken: string, id: string, dto: ValidateLibraryDto) =>
    validate({ id, validateLibraryDto: dto }, { headers: asBearerAuth(accessToken) }),

  updateLibrary: (accessToken: string, id: string, dto: UpdateLibraryDto) =>
    updateLibrary({ id, updateLibraryDto: dto }, { headers: asBearerAuth(accessToken) }),

  /** Share the caller's library with `id` (FL-326: the partner receives their own copies). */
  createPartner: (accessToken: string, id: string) =>
    createPartner({ partnerCreateDto: { sharedWithId: id } }, { headers: asBearerAuth(accessToken) }),

  /** Wait for the SQL copy/backfill jobs and the recipient's canonical provenance row (FL-326). */
  waitForPartnerCopy: async (recipientId: string, sourceAssetId: string, ms = process.env.CI ? 60_000 : 20_000) => {
    const db = await utils.connectDatabase();
    const deadline = Date.now() + ms;
    let jobs: { name: string; state: string }[] = [];
    while (Date.now() < deadline) {
      // A matching checksum may be a pre-existing upload, and an origin row is committed before
      // the job finishes copying faces, tags and lock state. Neither alone proves a finished copy.
      const { rows } = await db.query<{ id: string | null; jobs: typeof jobs }>(
        `SELECT copy.id,
           coalesce((SELECT jsonb_agg(jsonb_build_object('name', job.name, 'state', job.state))
             FROM public.job job
             WHERE job."dedupKey" IN (
               'partner-copy/' || source.id::text || '/' || $2::text,
               'partner-backfill/' || source."ownerId"::text || '/' || $2::text
             )), '[]'::jsonb) AS jobs
         FROM public.asset source
         LEFT JOIN public.asset_origin origin ON origin."sourceAssetId" = source.id AND origin."ownerId" = $2::uuid
         LEFT JOIN public.asset copy ON copy.id = origin."assetId" AND copy."ownerId" = $2::uuid
           AND copy."deletedAt" IS NULL
         WHERE source.id = $1`,
        [sourceAssetId, recipientId],
      );
      const row = rows[0];
      jobs = row?.jobs ?? [];
      const failed = jobs.filter(({ state }) => ['failed', 'needs_attention', 'blocked', 'cancelled'].includes(state));
      if (failed.length > 0) {
        throw new Error(`Partner copy of ${sourceAssetId} did not complete: ${JSON.stringify(failed)}`);
      }
      if (row?.id && jobs.length > 0 && jobs.every(({ state }) => state === 'completed')) {
        return row.id;
      }
      await setAsyncTimeout(200);
    }
    throw new Error(
      `Timed out waiting for ${recipientId}'s copy of ${sourceAssetId}; SQL jobs: ${JSON.stringify(jobs)}`,
    );
  },

  updateMyPreferences: (accessToken: string, userPreferencesUpdateDto: UserPreferencesUpdateDto) =>
    updateMyPreferences({ userPreferencesUpdateDto }, { headers: asBearerAuth(accessToken) }),

  createStack: (accessToken: string, assetIds: string[]) =>
    createStack({ stackCreateDto: { assetIds } }, { headers: asBearerAuth(accessToken) }),

  setAssetDuplicateId: (accessToken: string, assetId: string, duplicateId: string | null) =>
    updateAssets({ assetBulkUpdateDto: { ids: [assetId], duplicateId } }, { headers: asBearerAuth(accessToken) }),

  upsertTags: (accessToken: string, tags: string[]) =>
    upsertTags({ tagUpsertDto: { tags } }, { headers: asBearerAuth(accessToken) }),

  tagAssets: (accessToken: string, tagId: string, assetIds: string[]) =>
    tagAssets({ id: tagId, bulkIdsDto: { ids: assetIds } }, { headers: asBearerAuth(accessToken) }),

  createJob: async (accessToken: string, jobCreateDto: JobCreateDto) =>
    ownedWait('Create job', queueWaitTimeout(), async (context) => {
      context.remaining();
      return createJob({ jobCreateDto }, { headers: asBearerAuth(accessToken), signal: context.signal });
    }),

  queueCommand: async (accessToken: string, name: QueueName, queueCommandDto: QueueCommandDto) =>
    runQueueCommandLegacy({ name, queueCommandDto }, { headers: asBearerAuth(accessToken) }),

  setAuthCookies: async (context: BrowserContext, accessToken: string, domain = playwrightHost) =>
    await context.addCookies([
      {
        name: 'immich_access_token',
        value: accessToken,
        domain,
        path: '/',
        expires: 2_058_028_213,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
      {
        name: 'immich_auth_type',
        value: 'password',
        domain,
        path: '/',
        expires: 2_058_028_213,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
      {
        name: 'immich_is_authenticated',
        value: 'true',
        domain,
        path: '/',
        expires: 2_058_028_213,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      },
    ]),

  /**
   * Serves the configured map styles (`/v1/style/light.json` and `dark.json`) from the test itself,
   * so a map renders its markers without reaching a tile host. The style is a plain background with
   * no sources, glyphs or sprites, which is all the marker layers need.
   *
   * Passing `failWith` (404 or 500) serves that status instead, for FL-193: the map's offline/
   * unavailable state when the style can't load, rather than one where it actually loads.
   */
  mockMapStyle: async (context: BrowserContext, failWith?: 404 | 500) =>
    await context.route(/\/v1\/style\/(light|dark)\.json(\?.*)?$/, (route) =>
      failWith
        ? route.fulfill({ status: failWith, contentType: 'text/plain', body: 'map style unavailable' })
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              version: 8,
              sources: {},
              layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e8ecef' } }],
            }),
          }),
    ),

  /**
   * Stands in for the whole Frameleaf tile host (FC-69 contract) so no test reaches
   * tiles.frameleaf.cloud: styles at /v1/style/{light,dark}.json name a "protomaps" vector source
   * with plain Z/X/Y tiles (/v1/tiles/<build>/{z}/{x}/{y}.mvt, zoom 0–15), glyphs at
   * /v1/fonts/{fontstack}/{range}.pbf and sprites at /v1/sprites/v4/{light,dark}. Tiles and glyphs
   * answer empty, sprites with an empty atlas. A later `mockMapStyle` still overrides the style.
   */
  mockTileHost: async (context: BrowserContext) =>
    await context.route(/^https:\/\/tiles\.frameleaf\.cloud\//, (route) => {
      const { pathname } = new URL(route.request().url());
      const theme = pathname.includes('dark') ? 'dark' : 'light';
      if (/^\/v1\/style\/(light|dark)\.json$/.test(pathname)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({
            version: 8,
            name: `Frameleaf ${theme}`,
            glyphs: 'https://tiles.frameleaf.cloud/v1/fonts/{fontstack}/{range}.pbf',
            sprite: `https://tiles.frameleaf.cloud/v1/sprites/v4/${theme}`,
            sources: {
              protomaps: {
                type: 'vector',
                tiles: ['https://tiles.frameleaf.cloud/v1/tiles/20260926/{z}/{x}/{y}.mvt'],
                minzoom: 0,
                maxzoom: 15,
                attribution: '© OpenStreetMap contributors Protomaps',
              },
            },
            layers: [
              { id: 'background', type: 'background', paint: { 'background-color': '#cccccc' } },
              {
                id: 'earth',
                type: 'fill',
                source: 'protomaps',
                'source-layer': 'earth',
                paint: { 'fill-color': '#e2dfda' },
              },
            ],
          }),
        });
      }
      if (/^\/v1\/sprites\/v4\/(light|dark)(@2x)?\.json$/.test(pathname)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: '{}',
        });
      }
      if (/^\/v1\/sprites\/v4\/(light|dark)(@2x)?\.png$/.test(pathname)) {
        return route.fulfill({
          status: 200,
          contentType: 'image/png',
          headers: { 'access-control-allow-origin': '*' },
          // a transparent 1×1 PNG
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
            'base64',
          ),
        });
      }
      if (/^\/v1\/(tiles\/\d{8}\/\d+\/\d+\/\d+\.mvt|fonts\/.+\.pbf)$/.test(pathname)) {
        return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      }
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' } });
    }),

  setMaintenanceAuthCookie: async (context: BrowserContext, token: string, domain = '127.0.0.1') =>
    await context.addCookies([
      {
        name: 'immich_maintenance_token',
        value: token,
        domain,
        path: '/',
        expires: 2_058_028_213,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]),

  enterMaintenance: async (accessToken: string) => {
    let setCookie: string[] | undefined;

    await setMaintenanceMode(
      {
        setMaintenanceModeDto: {
          action: MaintenanceAction.Start,
        },
      },
      {
        headers: asBearerAuth(accessToken),
        fetch: (...args: Parameters<typeof fetch>) =>
          // eslint-disable-next-line unicorn/no-invalid-argument-count, unicorn/prefer-await
          fetch(...args).then((response) => {
            setCookie = response.headers.getSetCookie();
            return response;
          }),
      },
    );

    return setCookie;
  },

  /**
   * Ends maintenance mode a web test left on, so a failure does not turn every later test into an
   * HTML 404 (a failed restore keeps the server in maintenance mode by design). A restore that is
   * still running is left to finish. The End request needs a maintenance token: the browser's, or
   * `fallbackToken` for a test that entered maintenance mode through the API.
   */
  endMaintenance: async (context: BrowserContext, fallbackToken?: string) => {
    const cookies = await context.cookies();
    const token = cookies.find(({ name }) => name === 'immich_maintenance_token')?.value ?? fallbackToken;
    const headers = { cookie: `immich_maintenance_token=${token}`, 'content-type': 'application/json' };

    // Inside the default 30 s test timeout, so a stuck server fails with this message, not a hook timeout.
    const deadline = Date.now() + 25_000;
    while (await isInMaintenance()) {
      if (!token || Date.now() > deadline) {
        throw new Error(`The server did not leave maintenance mode${token ? '' : ': no maintenance token'}`);
      }
      try {
        const response = await fetch(`${app}/admin/maintenance/status`, { headers });
        const status = response.ok ? await response.json() : null;
        const restoring = status?.action === MaintenanceAction.RestoreDatabase && !status.error;
        if (status && status.action !== MaintenanceAction.End && !restoring) {
          await fetch(`${app}/admin/maintenance`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ action: MaintenanceAction.End }),
          });
        }
      } catch {
        // restarting; check again
      }
      await setAsyncTimeout(1000);
    }
  },

  resetTempFolder: () => {
    rmSync(`${testAssetDir}/temp`, { recursive: true, force: true });
    mkdirSync(`${testAssetDir}/temp`, { recursive: true });
  },

  putFile(source: string, dest: string) {
    return executeCommand('docker', ['cp', source, `immich-e2e-server:${dest}`]).promise;
  },

  async putTextFile(contents: string, dest: string) {
    const dir = await mkdtemp(join(tmpdir(), 'test-'));
    const fn = join(dir, 'file');
    await pipeline(Readable.from(contents), createWriteStream(fn));
    return executeCommand('docker', ['cp', fn, `immich-e2e-server:${dest}`]).promise;
  },

  async move(source: string, dest: string) {
    return executeCommand('docker', ['exec', 'immich-e2e-server', 'mv', source, dest]).promise;
  },

  async copyFolder(source: string, dest: string) {
    return executeCommand('docker', ['exec', 'immich-e2e-server', 'cp', '-r', source, dest]).promise;
  },

  async deleteFile(path: string) {
    return executeCommand('docker', ['exec', 'immich-e2e-server', 'rm', path]).promise;
  },

  async deleteFolder(path: string) {
    return executeCommand('docker', ['exec', 'immich-e2e-server', 'rm', '-r', path]).promise;
  },

  async truncateFolder(path: string) {
    return executeCommand('docker', [
      'exec',
      'immich-e2e-server',
      'find',
      path,
      '-type',
      'f',
      '-exec',
      'truncate',
      '-s',
      '1',
      '{}',
      ';',
    ]).promise;
  },

  async mkFolder(path: string) {
    return executeCommand('docker', ['exec', 'immich-e2e-server', 'mkdir', '-p', path]).promise;
  },

  createBackup: async (accessToken: string) => {
    await utils.createJob(accessToken, {
      name: ManualJobName.BackupDatabase,
    });

    await utils.waitForQueueFinish(accessToken, 'backupDatabase');

    return utils.poll(
      () => request(app).get('/admin/database-backups').set('Authorization', `Bearer ${accessToken}`),
      ({ status, body }) => status === 200 && body.backups.length === 1,
      ({ body }) => body.backups[0].filename,
    );
  },

  resetBackups: async (accessToken: string) => {
    const { backups } = await listDatabaseBackups({ headers: asBearerAuth(accessToken) });
    await deleteDatabaseBackup(
      { databaseBackupDeleteDto: { backups: backups.map((dto) => dto.filename) } },
      { headers: asBearerAuth(accessToken) },
    );
  },

  prepareTestBackup: async (generate: 'empty' | 'corrupted', accessToken: string) => {
    const filename = await utils.createBackup(accessToken);
    const dir = await mkdtemp(join(tmpdir(), 'test-'));
    const source = join(dir, 'source.sql.gz');
    const fixture = join(dir, 'fixture.sql.gz');
    try {
      const copied = await executeCommand('docker', ['cp', `immich-e2e-server:/data/backups/${filename}`, source])
        .promise;
      if (copied.exitCode !== 0) {
        throw new Error(`Could not copy the canonical backup fixture: ${copied.stderr}`);
      }
      await writeFile(fixture, amendBackupFixture(await readFile(source), generate));
      const installed = await executeCommand('docker', ['cp', fixture, `immich-e2e-server:/data/backups/${filename}`])
        .promise;
      if (installed.exitCode !== 0) {
        throw new Error(`Could not install the canonical backup fixture: ${installed.stderr}`);
      }
      return filename;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },

  resetAdminConfig: async (accessToken: string, signal?: AbortSignal) => {
    const options = { headers: asBearerAuth(accessToken), signal };
    const defaultConfig = await getConfigDefaults(options);
    // Whole-config saves deliberately retain same-account credentials and remote authority.
    // A disposable E2E fixture owns these values and clears them only through their explicit APIs.
    // This first save also retains the precise CONFIG_FILE_IN_USE refusal before protected writes.
    await updateConfig({ adminConfigDto: defaultConfig }, options);
    const credentials = await getConfigCredentials(options);
    for (const credential of credentials) {
      if (credential.configured) {
        await deleteConfigCredential({ name: credential.name }, options);
      }
    }
    const defaults = defaultConfig.frameleafCloud?.remoteAccess;
    if (defaults) {
      const remote = await getRemoteAccess(options);
      if (remote.customHostname) {
        await removeRemoteHostname(options);
      }
      const next = {
        enabled: defaults.enabled,
        mode: defaults.mode,
        directPort: defaults.directPort,
        portMapping: defaults.portMapping,
        publicUrl: defaults.publicUrl,
      };
      if (
        remote.enabled !== next.enabled ||
        remote.mode !== next.mode ||
        remote.directPort !== next.directPort ||
        remote.portMapping !== next.portMapping ||
        remote.publicUrlChoice !== next.publicUrl
      ) {
        await updateRemoteAccess({ remoteAccessUpdateDto: next }, options);
      }
    }
  },

  isQueueEmpty: (accessToken: string, queue: keyof QueuesResponseLegacyDto, signal?: AbortSignal) =>
    ownedWait(
      `Reading queue ${queue}`,
      queueWaitTimeout(),
      async (context) => {
        const snapshot = await readQueue(accessToken, queue as QueueName, context);
        if (snapshot.statistics.failed > 0) {
          throw new Error(`Queue ${queue} has failed or blocked jobs; it did not complete successfully`);
        }
        return !snapshot.hasUnfinishedWork;
      },
      signal,
    ),

  /**
   * Completion includes delayed, paused and unadmitted durable work. A dependency refusal
   * is not success; its queued work remains visible until completed or explicitly cancelled.
   */
  waitForAllQueuesFinish: (accessToken: string, signal?: AbortSignal) =>
    ownedWait(
      'Waiting for all queues',
      queueWaitTimeout(),
      (context) =>
        waitUntil(
          context,
          async () => {
            let unfinished = false;
            for (const name of Object.values(QueueName)) {
              const queue = await readQueue(accessToken, name, context);
              if (queue.statistics.failed > 0) {
                throw new Error(`Queue ${name} has failed or blocked jobs; it did not complete successfully`);
              }
              unfinished ||= queue.hasUnfinishedWork;
            }
            return unfinished;
          },
          (unfinished) => !unfinished,
        ),
      signal,
    ),

  waitForQueueFinish: (accessToken: string, queue: keyof QueuesResponseLegacyDto, ms?: number, signal?: AbortSignal) =>
    ownedWait(
      `Waiting for queue ${queue}`,
      ms ?? queueWaitTimeout(),
      (context) => waitForQueue(accessToken, queue as QueueName, context),
      signal,
    ),

  /** Used only when a test intentionally parks pending work and asserts that it remains paused. */
  waitForQueueIdle: (accessToken: string, queue: keyof QueuesResponseLegacyDto, signal?: AbortSignal) =>
    ownedWait(
      `Waiting for queue ${queue} to stop executing`,
      queueWaitTimeout(),
      (context) =>
        waitUntil(
          context,
          (current) => readQueue(accessToken, queue as QueueName, current),
          ({ statistics }) => statistics.active === 0 && statistics.waiting === 0,
        ),
      signal,
    ),

  cliLogin: async (accessToken: string) => {
    const { secret } = await utils.createApiKey(accessToken, [Permission.All]);
    await immichCli(['login', app, secret]);
    return secret;
  },

  scan: (accessToken: string, id: string, signal?: AbortSignal) =>
    ownedWait(
      `Scanning library ${id}`,
      queueWaitTimeout(),
      async (context) => {
        await scanLibrary({ id }, { headers: asBearerAuth(accessToken), signal: context.signal });
        for (const queue of [
          QueueName.Library,
          QueueName.Sidecar,
          QueueName.MetadataExtraction,
          QueueName.StorageTemplateMigration,
          QueueName.ThumbnailGeneration,
          QueueName.VideoConversion,
        ]) {
          await waitForQueue(accessToken, queue, context);
        }
      },
      signal,
    ),

  waitForAssetReady: async (
    accessToken: string,
    id: string,
    options: {
      video?: boolean;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      timeout?: number;
    } = {},
  ) => {
    const started = performance.now();
    let phase = 'start';
    try {
      return await ownedWait(
        `Waiting for asset ${id}`,
        options.timeout ?? queueWaitTimeout(),
        async (context) => {
          for (const queue of [
            QueueName.MetadataExtraction,
            QueueName.StorageTemplateMigration,
            QueueName.ThumbnailGeneration,
            ...(options.video ? [QueueName.VideoConversion] : []),
          ]) {
            phase = `queue ${queue}`;
            await waitForQueue(accessToken, queue, context);
          }
          const headers = options.headers ?? asBearerAuth(accessToken);
          phase = 'asset info';
          const asset = await getAssetInfo({ id }, { headers, signal: context.signal });
          context.remaining();
          if (asset.id !== id) {
            throw new Error('Asset readiness returned another asset');
          }
          phase = 'preview';
          const preview = await viewAsset({ id, size: AssetMediaSize.Preview }, { headers, signal: context.signal });
          context.remaining();
          if (preview.size === 0 || !preview.type.startsWith('image/')) {
            throw new Error(`Asset ${id} did not publish a readable preview`);
          }
          return asset;
        },
        options.signal,
      );
    } catch (error: unknown) {
      throw new Error(`Asset readiness failed: phase=${phase}; elapsedMs=${Math.round(performance.now() - started)}`, {
        cause: error,
      });
    }
  },

  poll: (
    cb: () => request.Test,
    validate: (value: request.Response) => boolean,
    map?: (value: request.Response) => any,
    signal?: AbortSignal,
  ) =>
    ownedWait(
      'Polling test endpoint',
      5000,
      async (context) => {
        const value = await pollRequest<request.Response>(context, cb, (response) => {
          if (response.status >= 500) {
            throw new Error(`Polling test endpoint failed: HTTP ${response.status}`);
          }
          return validate(response);
        });
        return map ? map(value) : value;
      },
      signal,
    ),
};

// eslint-disable-next-line unicorn/no-top-level-side-effects
utils.initSdk();

if (!existsSync(`${testAssetDir}/albums`)) {
  throw new Error(
    `Test assets not found. Please checkout https://github.com/immich-app/test-assets into ${testAssetDir} before testing`,
  );
}
