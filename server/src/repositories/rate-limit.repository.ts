import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
 * never outlive its window. The connection opens when the API starts; commands fail at once instead
 * of queueing while Redis is away (`enableOfflineQueue: false`), so a caller decides what an
 * unavailable counter means.
 */
@Injectable()
export class RateLimitRepository implements OnModuleInit, OnModuleDestroy {
  private client?: Redis;

  constructor(private configRepository: ConfigRepository) {}

  private getClient(): Redis {
    if (!this.client) {
      const { redis } = this.configRepository.getEnv();
      this.client = new Redis({
        ...redis,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: 2000,
      });
      // connection errors surface on the commands; the client reconnects on its own
      this.client.on('error', () => {
        // reported by the command that failed
      });
    }
    return this.client;
  }

  onModuleInit() {
    this.getClient();
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

  /**
   * Give one counted attempt back (`DECR`): an attempt counted up front that turned out not to be a
   * failure. A counter never goes below zero, and one given back to zero is removed.
   */
  async release(key: string): Promise<void> {
    const client = this.getClient();
    const count = await client.decr(key);
    if (count <= 0) {
      await client.del(key);
    }
  }

  async onModuleDestroy() {
    const client = this.client;
    this.client = undefined;
    if (client && client.status !== 'end') {
      await client.quit().catch(() => client.disconnect());
    }
  }
}
