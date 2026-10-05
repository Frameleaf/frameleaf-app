import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { ConfigRepository } from 'src/repositories/config.repository.js';

export type WorkerStoppedProof = { workerId: string; stoppedAt: number };
export const WORKER_PROOF_TIMEOUT_MS = 500;
export const WORKER_PROOF_RETRY_MS = 30_000;

/** Supervisor-only metadata transport. It never borrows an executor pool or retries media work. */
export class WorkerStopProofRecorder {
  private pool: Pool;
  private pending = new Map<string, { proof: WorkerStoppedProof; attempted: boolean; republishing?: boolean }>();
  // One microservices worker runs at a time. Carry only its latest confirmed stop across the
  // maintenance cycle, until normal bootstrap republishes it into the restored database.
  private retained?: WorkerStoppedProof;
  private flushing?: Promise<void>;
  private retry?: NodeJS.Timeout;
  private closed = false;

  constructor(
    config: ConfigRepository,
    private options: {
      retryMs?: number;
      timeoutMs?: number;
      diagnostic?: (message: string) => void;
    } = {},
  ) {
    const connection = config.getEnv().database.config;
    const params: PoolConfig =
      connection.connectionType === 'url'
        ? { connectionString: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            user: connection.username,
            password: connection.password,
            database: connection.database,
            ssl:
              !connection.ssl || connection.ssl === 'disable'
                ? false
                : { rejectUnauthorized: connection.ssl === 'verify-full' },
          };
    const timeoutMs = options.timeoutMs ?? WORKER_PROOF_TIMEOUT_MS;
    this.pool = new Pool({
      ...params,
      max: 1,
      application_name: 'frameleaf:worker-stop-proof',
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs,
      lock_timeout: timeoutMs,
      idleTimeoutMillis: 1000,
      allowExitOnIdle: true,
    });
    this.pool.on('error', () => this.diagnostic());
  }

  async record(proof: WorkerStoppedProof): Promise<void> {
    if (this.closed) return;
    const entry = this.pending.get(proof.workerId) ?? { proof: { ...proof }, attempted: false };
    this.retained = entry.proof;
    this.pending.set(proof.workerId, entry);
    await this.flush();
    // A proof arriving during another write must get its own first bounded attempt before exit.
    if (!entry.attempted) await this.flush();
  }

  /** Called after maintenance ends, before starting a replacement executor. No new stop is inferred. */
  async republish(): Promise<void> {
    if (this.closed || !this.retained) return;
    const entry = { proof: this.retained, attempted: false, republishing: true };
    this.pending.set(entry.proof.workerId, entry);
    await this.flush();
    if (!entry.attempted) await this.flush();
  }

  private diagnostic() {
    (this.options.diagnostic ?? ((message: string) => console.error(message)))(
      'Queue worker stop proof database unavailable; pending metadata will retry. Retained work remains fenced.',
    );
  }

  private flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.flushing = this.write().finally(() => {
      this.flushing = undefined;
      if (this.pending.size > 0 && !this.closed) {
        this.retry = setTimeout(() => {
          void this.flush();
        }, this.options.retryMs ?? WORKER_PROOF_RETRY_MS);
        this.retry.unref();
      }
    });
    return this.flushing;
  }

  private async write() {
    const entries = this.pending.values().toArray();
    const proofs = entries.map((entry) => {
      entry.attempted = true;
      return entry.proof;
    });
    let client: PoolClient | undefined;
    let failed = false;
    try {
      client = await this.pool.connect();
      await client.query(
        `INSERT INTO public.system_metadata (key, value)
        SELECT 'frameleaf-worker-stopped:' || (proof->>'workerId'), proof
        FROM jsonb_array_elements($1::jsonb) AS proof
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(proofs)],
      );
      for (const entry of entries) {
        if (this.pending.get(entry.proof.workerId) !== entry) continue;
        this.pending.delete(entry.proof.workerId);
        if (entry.republishing && this.retained === entry.proof) this.retained = undefined;
      }
    } catch {
      failed = true;
      this.diagnostic();
    } finally {
      // Destroy timed-out connections instead of handing an outstanding query to another attempt.
      client?.release(failed);
    }
  }

  async close() {
    this.closed = true;
    clearTimeout(this.retry);
    await this.flushing;
    await this.pool.end();
  }
}
