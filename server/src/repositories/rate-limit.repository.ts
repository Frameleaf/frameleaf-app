import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { type Pool, type PoolClient } from 'pg';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { closeSharedServicePool, createSharedServicePool, trackPoolClients } from 'src/utils/shared-service-pool.js';

export type RateLimitHit = {
  /** Requests counted in the current window, including this one. */
  count: number;
  /** Seconds until the window ends. */
  resetSeconds: number;
  /** Exact database window identity; a request without it cannot refund a counter. */
  windowExpiresAt?: string;
};

export type SignInAttempt = {
  getWait: () => Promise<number>;
  recordFailure: () => Promise<void>;
  clearFailures: () => Promise<void>;
  release: () => Promise<void>;
};

@Injectable()
export class RateLimitRepository implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  private clients?: ReturnType<typeof trackPoolClients>;
  private signInPool?: { pool: Pool; clients: ReturnType<typeof trackPoolClients> };
  private cleanupAt = 0;
  private cleaning?: Promise<void>;

  constructor(private configRepository: ConfigRepository) {}

  private getClient(): Pool {
    if (!this.pool) {
      this.pool = createSharedServicePool(this.configRepository, 'admission');
      this.clients = trackPoolClients(this.pool);
    }
    return this.pool;
  }

  private getSignInClient(): Pool {
    if (!this.signInPool) {
      // Credential checks can wait for bcrypt. Keep those connections separate from route admission.
      const pool = createSharedServicePool(this.configRepository, 'sign-in-backoff', 8);
      this.signInPool = { pool, clients: trackPoolClients(pool) };
    }
    return this.signInPool.pool;
  }

  onModuleInit() {
    this.getClient();
  }

  /** Bounded opportunistic cleanup, at most once a minute per process, outside admission results. */
  private cleanExpired() {
    if (this.cleaning || Date.now() < this.cleanupAt) {
      return;
    }
    this.cleanupAt = Date.now() + 60_000;
    this.cleaning = (async () => {
      for (const table of ['frameleaf_rate_limit', 'frameleaf_upload_lease']) {
        await this.getClient().query(`DELETE FROM public.${table} WHERE key IN (
          SELECT key FROM public.${table} WHERE expires_at <= statement_timestamp()
          ORDER BY expires_at LIMIT 256 FOR UPDATE SKIP LOCKED
        ) AND expires_at <= statement_timestamp()`);
      }
    })()
      .catch(() => {
        // Cleanup never changes the result of a successful admission.
      })
      .finally(() => (this.cleaning = undefined));
  }

  async hit(key: string, windowSeconds: number): Promise<RateLimitHit> {
    if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
      throw new Error('Rate limit window must be a positive integer');
    }
    // A newer statement can create the window while this one waits; report time remaining after that wait.
    const { rows } = await this.getClient().query<RateLimitHit>(
      `INSERT INTO public.frameleaf_rate_limit AS counter (key, count, expires_at)
       VALUES ($1, 1, statement_timestamp() + make_interval(secs => $2))
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN counter.expires_at <= statement_timestamp() THEN 1 ELSE counter.count + 1 END,
         expires_at = CASE WHEN counter.expires_at <= statement_timestamp()
           THEN statement_timestamp() + make_interval(secs => $2) ELSE counter.expires_at END
       RETURNING count, GREATEST(1, CEIL(EXTRACT(EPOCH FROM expires_at - clock_timestamp())))::integer AS "resetSeconds",
         expires_at::text AS "windowExpiresAt"`,
      [key, windowSeconds],
    );
    this.cleanExpired();
    return rows[0];
  }

  /** Keep one credential check per key in flight across API processes without queuing on a held lock. */
  async acquireSignInAttempt(key: string): Promise<SignInAttempt | undefined> {
    const client = await this.getSignInClient().connect();
    const lockKey = 'hashtextextended($1, 850)';
    try {
      const { rows } = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(${lockKey}) AS acquired`,
        [key],
      );
      if (!rows[0].acquired) {
        client.release();
        return;
      }
    } catch (error) {
      // A timed-out acquisition may still have acquired the lock.
      client.release(true);
      throw error;
    }
    return {
      getWait: () => this.getSignInWait(key, client),
      recordFailure: () => this.recordSignInFailure(key, client),
      clearFailures: () => this.clearSignInFailures(key, client),
      release: async () => {
        const unlocked = await client
          .query<{ unlocked: boolean }>(`SELECT pg_advisory_unlock(${lockKey}) AS unlocked`, [key])
          .then(({ rows }) => rows[0].unlocked)
          .catch(() => false);
        client.release(!unlocked);
      },
    };
  }

  async getSignInWait(key: string, client: Pool | PoolClient = this.getClient()): Promise<number> {
    const { rows } = await client.query<{ wait: number }>(
      `select greatest(0, ceil(extract(epoch from expires_at - statement_timestamp() - interval '1 hour')
        + least(1800, 30 * (1 << least(6, count - 5)))))::int as wait
       from public.frameleaf_rate_limit where key = $1 and count >= 5 and expires_at > statement_timestamp()`,
      [key],
    );
    return rows[0]?.wait ?? 0;
  }

  async recordSignInFailure(key: string, client: Pool | PoolClient = this.getClient()): Promise<void> {
    await client.query(
      `insert into public.frameleaf_rate_limit as counter (key, count, expires_at)
       values ($1, 1, clock_timestamp() + interval '1 hour')
       on conflict (key) do update set
         count = case when counter.expires_at <= clock_timestamp() then 1 else least(counter.count + 1, 11) end,
         expires_at = clock_timestamp() + interval '1 hour'`,
      [key],
    );
    this.cleanExpired();
  }

  async clearSignInFailures(key: string, client: Pool | PoolClient = this.getClient()): Promise<void> {
    await client.query('delete from public.frameleaf_rate_limit where key = $1', [key]);
  }

  /** Keep the latest 20 actual failures across addresses. This counter is never consulted by admission. */
  async recordSignInBurst(key: string): Promise<boolean> {
    const { rows } = await this.getClient().query<{ notice: boolean }>(
      `insert into public.frameleaf_rate_limit as counter (key, count, expires_at, failure_times)
       values ($1, 0, clock_timestamp() + interval '1 hour', array[clock_timestamp()])
       on conflict (key) do update set
         failure_times = array_prepend(clock_timestamp(), array(
           select t from unnest(counter.failure_times) as t
           where t > clock_timestamp() - interval '1 hour' order by t desc limit 19
         )),
         expires_at = clock_timestamp() + interval '1 hour'
       returning cardinality(failure_times) = 20 as notice`,
      [key],
    );
    this.cleanExpired();
    return rows[0].notice;
  }

  /** Row-locked decrement never recreates an expired counter; zero starts a fresh window on the next hit. */
  async release(key: string, windowExpiresAt: string): Promise<void> {
    await this.getClient().query(
      `UPDATE public.frameleaf_rate_limit SET count = GREATEST(0, count - 1),
       expires_at = CASE WHEN count <= 1 THEN statement_timestamp() ELSE expires_at END
       WHERE key = $1 AND expires_at = $2::timestamptz AND expires_at > statement_timestamp()`,
      [key, windowExpiresAt],
    );
  }

  /** Native upload admission only; fifteen minutes exceeds the request-body timeout. */
  async claimUploadStream(resourceId: string, token: string): Promise<boolean> {
    const { rowCount } = await this.getClient().query(
      `INSERT INTO public.frameleaf_upload_lease AS lease (key, token, expires_at)
       VALUES ($1, $2, clock_timestamp() + interval '900 seconds')
       ON CONFLICT (key) DO UPDATE SET token = EXCLUDED.token, expires_at = clock_timestamp() + interval '900 seconds'
       WHERE lease.expires_at <= clock_timestamp() RETURNING key`,
      [resourceId, token],
    );
    this.cleanExpired();
    return rowCount === 1;
  }

  /**
   * FL-1268: claims the lease of one part (`<resourceId>:<offset>`) only while fewer than `max` parts of that
   * upload hold one. The count and the claim share a per-upload advisory lock, so parallel requests cannot overshoot.
   */
  async claimUploadPartStream(resourceId: string, offset: number, token: string, max: number) {
    const client = await this.getClient().connect();
    // A client whose ROLLBACK failed may still hold the transaction and its lock: destroy it instead of reusing it.
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(-226, hashtext($1)::int)`, [resourceId]);
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM public.frameleaf_upload_lease WHERE starts_with(key, $1) AND expires_at > clock_timestamp()`,
        [`${resourceId}:`],
      );
      if (Number(rows[0]?.count ?? 0) >= max) {
        await client.query('ROLLBACK');
        return 'full' as const;
      }
      const { rowCount } = await client.query(
        `INSERT INTO public.frameleaf_upload_lease AS lease (key, token, expires_at)
         VALUES ($1, $2, clock_timestamp() + interval '900 seconds')
         ON CONFLICT (key) DO UPDATE SET token = EXCLUDED.token, expires_at = clock_timestamp() + interval '900 seconds'
         WHERE lease.expires_at <= clock_timestamp() RETURNING key`,
        [`${resourceId}:${offset}`, token],
      );
      await client.query('COMMIT');
      this.cleanExpired();
      return rowCount === 1 ? ('claimed' as const) : ('busy' as const);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        discard = true;
      });
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async isUploadStreamCurrent(resourceId: string, token: string): Promise<boolean> {
    const { rowCount } = await this.getClient().query(
      `SELECT 1 FROM public.frameleaf_upload_lease WHERE key = $1 AND token = $2 AND expires_at > clock_timestamp()`,
      [resourceId, token],
    );
    return rowCount === 1;
  }

  async releaseUploadStream(resourceId: string, token: string): Promise<void> {
    await this.getClient().query(`DELETE FROM public.frameleaf_upload_lease WHERE key = $1 AND token = $2`, [
      resourceId,
      token,
    ]);
  }

  async onModuleDestroy() {
    await this.cleaning;
    const pool = this.pool;
    this.pool = undefined;
    const signIn = this.signInPool;
    this.signInPool = undefined;
    await Promise.all([
      pool && closeSharedServicePool(pool, this.clients),
      signIn && closeSharedServicePool(signIn.pool, signIn.clients),
    ]);
  }

  /** A shared five-minute lease also bounds abandoned peers after an API process exits. */
  async claimDirectUploadPeer(id: string, ownerId: string): Promise<boolean> {
    const client = await this.getClient().connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      // Separate statements acquire a fresh snapshot after a competing admission commits.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('frameleaf-direct-upload-peers'))");
      const { rowCount } = await client.query(
        `INSERT INTO public.frameleaf_upload_lease (key, token, expires_at)
         SELECT $1, $2, clock_timestamp() + interval '300 seconds'
         WHERE (SELECT count(*) FROM public.frameleaf_upload_lease
           WHERE key LIKE 'direct-upload-peer:%' AND expires_at > clock_timestamp()) < 16
         AND (SELECT count(*) FROM public.frameleaf_upload_lease
           WHERE key LIKE 'direct-upload-peer:%' AND token = $2 AND expires_at > clock_timestamp()) < 2`,
        [`direct-upload-peer:${id}`, ownerId],
      );
      await client.query('COMMIT');
      return rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        discard = true;
      });
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async releaseDirectUploadPeer(id: string, ownerId: string): Promise<void> {
    await this.getClient().query('DELETE FROM public.frameleaf_upload_lease WHERE key = $1 AND token = $2', [
      `direct-upload-peer:${id}`,
      ownerId,
    ]);
  }
}
