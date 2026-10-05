import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { type Pool } from 'pg';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { closeSharedServicePool, createSharedServicePool, trackPoolClients } from 'src/utils/shared-service-pool.js';

export type RateLimitHit = {
  /** Requests counted in the current window, including this one. */
  count: number;
  /** Seconds until the window ends. */
  resetSeconds: number;
};

@Injectable()
export class RateLimitRepository implements OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  private clients?: ReturnType<typeof trackPoolClients>;
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
    const { rows } = await this.getClient().query<{ count: number; resetSeconds: number }>(
      `INSERT INTO public.frameleaf_rate_limit AS counter (key, count, expires_at)
       VALUES ($1, 1, statement_timestamp() + make_interval(secs => $2))
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN counter.expires_at <= statement_timestamp() THEN 1 ELSE counter.count + 1 END,
         expires_at = CASE WHEN counter.expires_at <= statement_timestamp()
           THEN statement_timestamp() + make_interval(secs => $2) ELSE counter.expires_at END
       RETURNING count, GREATEST(1, CEIL(EXTRACT(EPOCH FROM expires_at - clock_timestamp())))::integer AS "resetSeconds"`,
      [key, windowSeconds],
    );
    this.cleanExpired();
    return rows[0];
  }

  /** Row-locked decrement never recreates an expired counter; zero starts a fresh window on the next hit. */
  async release(key: string): Promise<void> {
    await this.getClient().query(
      `UPDATE public.frameleaf_rate_limit SET count = GREATEST(0, count - 1),
       expires_at = CASE WHEN count <= 1 THEN statement_timestamp() ELSE expires_at END
       WHERE key = $1 AND expires_at > statement_timestamp()`,
      [key],
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
    if (pool) {
      await closeSharedServicePool(pool, this.clients);
    }
  }
}
