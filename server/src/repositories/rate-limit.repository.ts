import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ConfigRepository } from 'src/repositories/config.repository.js';

export type RateLimitHit = {
  /** Requests counted in the current window, including this one. */
  count: number;
  /** Seconds until the window ends. */
  resetSeconds: number;
};

/**
 * FL-161: fixed-window request counters in Redis, shared by every API process of this server.
 *
 * Each hit is an `INCR`; the key gets its window with `EXPIRE` when it has none yet (a new key, or
 * one left without an expiry by a process that stopped between the two commands), so a counter can
 * never outlive its window. Commands fail fast instead of queueing while Redis is away, so a caller
 * decides what an unavailable counter means.
 */
@Injectable()
export class RateLimitRepository implements OnModuleDestroy {
  private client?: Redis;

  constructor(private configRepository: ConfigRepository) {}

  private getClient(): Redis {
    if (!this.client) {
      const { redis } = this.configRepository.getEnv();
      this.client = new Redis({
        ...redis,
        lazyConnect: true,
        enableOfflineQueue: true,
        maxRetriesPerRequest: 1,
        commandTimeout: 2000,
      });
    }
    return this.client;
  }

  async hit(key: string, windowSeconds: number): Promise<RateLimitHit> {
    const client = this.getClient();
    const results = await client.multi().incr(key).ttl(key).exec();
    if (!results) {
      throw new Error('Rate limit counter transaction was discarded');
    }
    const [[incrError, count], [ttlError, ttl]] = results as [[Error | null, number], [Error | null, number]];
    if (incrError || ttlError) {
      throw incrError ?? ttlError;
    }
    if (ttl < 0) {
      await client.expire(key, windowSeconds);
      return { count, resetSeconds: windowSeconds };
    }
    return { count, resetSeconds: Math.max(1, ttl) };
  }

  async onModuleDestroy() {
    const client = this.client;
    this.client = undefined;
    if (client && client.status !== 'end') {
      await client.quit().catch(() => client.disconnect());
    }
  }
}
