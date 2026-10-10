import { Kysely, sql } from 'kysely';
import { CommandFactory } from 'nest-commander';
import { ChildProcess, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { PostgresError } from 'postgres';
import { DatabaseLock, ExitCode, ImmichWorker, LogLevel, SystemMetadataKey } from 'src/enum.js';
import { superviseQueueWorker } from 'src/queue/supervisor.js';
import { WorkerStopProofRecorder } from 'src/queue/worker-stop-proof.js';
import { ConfigRepository, warnDeprecatedEnv } from 'src/repositories/config.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { type DB } from 'src/schema/index.js';
import { buddyMaintenanceState } from 'src/utils/buddy-backup-maintenance.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { SupervisorStop, WORKER_STOP_MESSAGE } from 'src/utils/shutdown.js';

/**
 * FL-161: an `FRAMELEAF_EDGE_SECRET` set in the environment, kept for installs that set one on purpose.
 * Read once, before the supervisor writes its own.
 */
const configuredEdgeSecret = process.env.FRAMELEAF_EDGE_SECRET;

/** FL-165: how long a restart waits for the edge worker's 5 s teardown before killing it. */
const EDGE_STOP_MS = 10_000;

/**
 * FL-161 (instance contract "Via-header contract"): the secret the edge worker sends as
 * `X-Frameleaf-Via-Auth`, handed to every worker through the environment. Unless the administrator set
 * one, it is generated again on every boot (and restart), so it never exists anywhere but in memory.
 */
const setEdgeSecret = () => {
  process.env.FRAMELEAF_EDGE_SECRET = configuredEdgeSecret || randomBytes(32).toString('base64url');
};

/**
 * Manages worker lifecycle
 */
class Workers {
  /**
   * Currently running workers
   */
  workers: Partial<Record<ImmichWorker, { kill: (signal: NodeJS.Signals) => Promise<void> | void; stop: () => void }>> =
    {};

  /** FL-291: a SIGTERM or SIGINT asked the server to stop; nothing starts again from here on. */
  private databaseRestarts = new Set<ImmichWorker>();
  private workerStopProofs = new WorkerStopProofRecorder(new ConfigRepository());

  private stopper = new SupervisorStop({
    exit: (code) => process.exit(code),
    deadlineMs: new ConfigRepository().getEnv().shutdown.deadlineMs,
  });

  /**
   * Fail-safe in case anything dies during restart
   */
  restarting = false;

  /** FL-165: the edge worker was asked to stop for a restart. */
  stoppingEdge = false;

  /** FL-165: when the edge worker last started, and how often in a row it failed. */
  edgeStartedAt = 0;
  edgeFailures = 0;
  /** FL-165: set when this supervisor stops the edge worker itself; any other exit is a failure. */
  edgeStopRequested = false;
  edgeRestartTimer?: NodeJS.Timeout;
  /**
   * A restart waits for every worker to end, so an edge worker that never finishes its teardown would
   * leave the server down (no API, no maintenance worker). It promises 5 s; past this it is killed.
   */
  edgeKillTimer?: NodeJS.Timeout;

  /**
   * Boot all enabled workers
   */
  async bootstrap() {
    setEdgeSecret();
    const isMaintenanceMode = await this.isMaintenanceMode();
    const { workers } = new ConfigRepository().getEnv();

    if (this.stopper.stopping) {
      return;
    }

    if (isMaintenanceMode) {
      this.startWorker(ImmichWorker.Maintenance);
    } else {
      await this.waitForFreeLock();
      // A restore replaces system_metadata. Republish only the actual preceding worker/child
      // stop proof, after restore has released its lock and before admitting replacement work.
      await this.workerStopProofs.republish();
      if (this.stopper.stopping) {
        return;
      }

      for (const worker of workers) {
        this.startWorker(worker);
      }
    }
  }

  /**
   * FL-291: stop the server gracefully. Each worker is asked to stop (SIGTERM for the forked API and
   * edge processes, a message for the worker threads): it stops taking work, lets running jobs and
   * requests finish within the grace period, hands back what is left and closes its connections. The
   * supervisor exits once they all have, killing any still running at its deadline.
   */
  stop(signal: NodeJS.Signals) {
    if (this.stopper.stopping) {
      return;
    }
    console.log(`Received ${signal}; stopping every worker`);
    clearTimeout(this.edgeRestartTimer);
    clearTimeout(this.edgeKillTimer);
    this.edgeStopRequested = true;
    this.stopper.begin(() =>
      Object.values(this.workers).map((worker) => ({
        stop: () => worker.stop(),
        kill: () => void worker.kill('SIGKILL'),
      })),
    );
  }

  private async isMaintenanceMode(): Promise<boolean> {
    if (await buddyMaintenanceState(new ConfigRepository())) return true;
    const { database } = new ConfigRepository().getEnv();
    const { log: _, ...kyselyConfig } = getKyselyConfig(database.config);
    const kysely = new Kysely<DB>(kyselyConfig);
    const systemMetadataRepository = new SystemMetadataRepository(kysely);

    try {
      const value = await systemMetadataRepository.get(SystemMetadataKey.MaintenanceMode);
      return value?.isMaintenanceMode || false;
    } catch (error: any) {
      // Table doesn't exist (migrations haven't run yet)
      if ((error as PostgresError).code === '42P01') {
        return false;
      }

      throw error;
    } finally {
      await kysely.destroy();
    }
  }

  private async waitForFreeLock() {
    const { database } = new ConfigRepository().getEnv();
    const kysely = new Kysely<DB>(getKyselyConfig(database.config));

    let isLocked = false;
    while (!isLocked) {
      isLocked = await kysely.connection().execute(async (conn) => {
        const { rows } = await sql<{
          pg_try_advisory_lock: boolean;
        }>`SELECT pg_try_advisory_lock(${DatabaseLock.MaintenanceOperation})`.execute(conn);

        const isLocked = rows[0].pg_try_advisory_lock;

        if (isLocked) {
          await sql`SELECT pg_advisory_unlock(${DatabaseLock.MaintenanceOperation})`.execute(conn);
        }

        return isLocked;
      });

      if (!isLocked) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    await kysely.destroy();
  }

  /**
   * Start an individual worker
   * @param name Worker
   */
  private startWorker(name: ImmichWorker) {
    console.log(`Starting ${name} worker`);

    const basePath = dirname(import.meta.filename);
    const workerFile = join(basePath, 'workers', `${name}.js`);

    let anyWorker: Worker | ChildProcess;
    let kill: (signal?: NodeJS.Signals) => Promise<void> | void;
    let stop: () => void;
    let stopped: Promise<void> | undefined;

    // FL-165: the edge worker is a process of its own like the API: it holds the remote access
    // certificate keys and every remote socket, apart from the workers that run jobs
    if (name === ImmichWorker.Api || name === ImmichWorker.Edge) {
      const inspectPort = name === ImmichWorker.Api ? 9231 : 9232;
      const worker = fork(workerFile, [], {
        execArgv: process.execArgv.map((arg) =>
          arg.startsWith('--inspect') ? `--inspect=0.0.0.0:${inspectPort}` : arg,
        ),
      });

      kill = (signal) => void worker.kill(signal);
      stop = () => void worker.kill('SIGTERM');
      // eslint-disable-next-line unicorn/prefer-hoisting-branch-code
      anyWorker = worker;
    } else {
      const worker = new Worker(workerFile);
      if (name === ImmichWorker.Microservices) {
        stopped = superviseQueueWorker(worker, undefined, undefined, {
          recordStopped: (proof) => this.workerStopProofs.record(proof),
          diagnostic: (message) => console.error(message),
        }).stopped;
      }

      kill = async () => void (await worker.terminate());
      stop = () => worker.postMessage(WORKER_STOP_MESSAGE);
      anyWorker = worker;
    }

    anyWorker.on('message', (message: { type?: string }) => {
      if (message?.type !== 'database-unusable') return;
      this.databaseRestarts.add(name);
      void kill('SIGKILL');
    });
    anyWorker.on('error', (error) => this.onError(name, error));
    anyWorker.on('exit', (exitCode) => {
      // Keep this worker in the shutdown count until stop confirmation and the first bounded write finish.
      if (stopped) void stopped.then(() => this.onExit(name, exitCode));
      else this.onExit(name, exitCode);
    });

    this.workers[name] = { kill, stop };
    if (name === ImmichWorker.Edge) {
      this.edgeStartedAt = Date.now();
      this.edgeStopRequested = false;
    }
  }

  onError(name: ImmichWorker, error: Error) {
    console.error(`${name} worker error: ${error}, stack: ${error.stack}`);
  }

  onExit(name: ImmichWorker, exitCode: number | null) {
    // FL-291: a stop in progress: no restart, no killing the others; exit once the last one has gone
    if (this.stopper.stopping) {
      console.info(`${name} worker stopped`);
      delete this.workers[name];
      this.stopper.workerExited(Object.keys(this.workers).length);
      return;
    }

    // restart immich server
    if (exitCode === ExitCode.AppRestart || this.restarting) {
      this.restarting = true;
      // a pending edge restart would race the bootstrap that starts it again
      clearTimeout(this.edgeRestartTimer);

      console.info(`${name} worker shutdown for restart`);
      delete this.workers[name];

      // FL-165: the edge worker does not listen for restart events; it is stopped here (it closes
      // its connections within 5 seconds) and starts again with the others
      const edge = this.workers[ImmichWorker.Edge];
      if (edge && name !== ImmichWorker.Edge && !this.stoppingEdge) {
        this.stoppingEdge = true;
        this.edgeStopRequested = true;
        void edge.kill('SIGTERM');
        this.edgeKillTimer = setTimeout(() => {
          const stuck = this.workers[ImmichWorker.Edge];
          if (stuck) {
            console.error(`edge worker did not stop within ${EDGE_STOP_MS / 1000} s; killing it`);
            void stuck.kill('SIGKILL');
          }
        }, EDGE_STOP_MS);
      }
      if (name === ImmichWorker.Edge) {
        clearTimeout(this.edgeKillTimer);
      }

      // once all workers shut down, bootstrap again
      if (Object.keys(this.workers).length === 0) {
        void this.bootstrap();
        this.restarting = false;
        this.stoppingEdge = false;
      }

      return;
    }

    // FL-165: the edge worker ending takes nothing else down. Stopped by this supervisor it stays
    // stopped; ending any other way (an error, a crash, a kill from outside) it starts again on its
    // own, waiting 1 s, then 2 s, 4 s … up to a minute while it keeps failing (a minute of running
    // resets that)
    if (name === ImmichWorker.Edge) {
      delete this.workers[name];
      if (this.edgeStopRequested) {
        return;
      }
      const ranMs = Date.now() - this.edgeStartedAt;
      this.edgeFailures = ranMs > 60_000 ? 1 : this.edgeFailures + 1;
      const delay = Math.min(60_000, 1000 * 2 ** (this.edgeFailures - 1));
      console.error(`edge worker exited with code ${exitCode}; starting it again in ${delay / 1000} s`);
      clearTimeout(this.edgeRestartTimer);
      this.edgeRestartTimer = setTimeout(() => {
        if (!this.restarting && !this.workers[ImmichWorker.Edge]) {
          this.startWorker(ImmichWorker.Edge);
        }
      }, delay);
      return;
    }

    // Database cleanup failure poisons only its originating pool. Restart that worker; keep the
    // other API/edge/executor pools available. Safe queue publications remain token fenced.
    if (this.databaseRestarts.delete(name) || name === ImmichWorker.Microservices) {
      delete this.workers[name];
      setTimeout(() => {
        if (!this.stopper.stopping && !this.restarting && !this.workers[name]) {
          this.startWorker(name);
        }
      }, 1000);
      return;
    }

    // shutdown the entire process
    delete this.workers[name];

    if (exitCode !== 0) {
      console.error(`${name} worker exited with code ${exitCode}`);

      if (Object.hasOwn(this.workers, ImmichWorker.Api) && name !== ImmichWorker.Api) {
        console.error('Killing api process');
        void this.workers[ImmichWorker.Api]!.kill('SIGTERM');
      }
    }
    // FL-165: the edge worker is a process of its own; it must not outlive the server and keep the port
    // (an ending edge worker returned above, so the worker ending here is never the edge)
    if (Object.hasOwn(this.workers, ImmichWorker.Edge)) {
      this.edgeStopRequested = true;
      void this.workers[ImmichWorker.Edge]!.kill('SIGTERM');
    }

    process.exit(exitCode);
  }
}

async function main() {
  const immichApp = process.argv[2];
  if (immichApp) {
    process.argv.splice(2, 1);
  }

  // FL-294: `frameleaf-admin`; `immich-admin` is its deprecated alias
  if (immichApp === 'frameleaf-admin' || immichApp === 'immich-admin') {
    if (process.argv[2] === 'buddy-backup') {
      const { buddyBackupCommand } = await import('./utils/buddy-backup-offline.js');
      return buddyBackupCommand(process.argv.slice(3));
    }
    process.title = 'frameleaf_admin_cli';
    process.env.FRAMELEAF_LOG_LEVEL = LogLevel.Warn;
    // the old name would otherwise conflict with the level set here
    delete process.env.IMMICH_LOG_LEVEL;

    // imported lazily, so that the supervisor process does not build the whole application
    // graph on every start.
    const { ImmichAdminModule } = await import('./app.module.js');

    return CommandFactory.run(ImmichAdminModule, {
      serviceErrorHandler: (error) => {
        console.error(error);
        process.exitCode = 1;
      },
    });
  }

  if (immichApp === 'immich' || immichApp === 'microservices') {
    console.error(
      `Using "start.sh ${immichApp}" has been deprecated. Start the container without a command; the server runs every worker by default.`,
    );
    process.exit(1);
  }

  if (immichApp) {
    console.error(`Unknown command: "${immichApp}"`);
    process.exit(1);
  }

  process.title = 'frameleaf';
  // FL-294: one warning per start for deprecated IMMICH_ variables (the workers stay quiet)
  warnDeprecatedEnv();
  const workers = new Workers();
  // FL-291: Docker (through tini) sends SIGTERM here only; the workers are stopped from here
  process.on('SIGTERM', () => workers.stop('SIGTERM'));
  process.on('SIGINT', () => workers.stop('SIGINT'));
  void workers.bootstrap();
}

void main();
