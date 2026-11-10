import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrivateLogStore } from 'src/utils/private-log-store.js';

describe(PrivateLogStore.name, () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frameleaf-private-log-'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('follows records appended after connection even if another worker already emitted a newer timestamp', async () => {
    const store = new PrivateLogStore(root);
    const at = '2026-11-09T12:00:00.000Z';
    const now = new Date('2026-11-09T12:00:05.000Z');
    await store.append('api', [{ level: 'log', context: 'Test', message: 'existing', at }], now);
    const tail = await store.follow({});
    await store.append('api', [{ level: 'log', context: 'Test', message: 'newer' }], now);
    const messages = async () => (await Array.fromAsync(tail())).flat().map((entry) => entry.message);
    expect(await messages()).toEqual(['newer']);
    await store.append('machine-learning', [{ level: 'log', context: 'Test', message: 'late', at }], now);
    expect(await messages()).toEqual(['late']);
    expect(await messages()).toEqual([]);
  });

  it('caps worker files, prunes expired days, and pages newest first with private content removed', async () => {
    const store = new PrivateLogStore(root, 7, 1024, 256);
    const now = new Date('2026-11-09T12:00:00Z');
    const row = (message: string) => ({ level: 'warn', context: 'Test', message }) as const;
    await store.append('api', [row('old retained log')], new Date('2026-11-01T12:00:00Z'));
    for (let i = 0; i < 12; i++) {
      await store.append('api', [row(`job-${i} password=private`)], new Date(now.getTime() + i));
    }
    const files = await readdir(root);
    expect(files.every((name) => !name.includes('20261101'))).toBe(true);
    const sizes = await Promise.all(files.map(async (name) => (await stat(join(root, name))).size));
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(1024);

    const result = await store.list({ limit: 2, worker: 'api', level: 'warn', q: 'job-' }, now);
    expect(result.entries.map((entry) => entry.message)).toEqual([
      'job-11 password=[redacted]',
      'job-10 password=[redacted]',
    ]);
    expect(result.nextCursor).toBeTruthy();
    const second = await store.list({ limit: 2, before: result.nextCursor! }, now);
    expect(second.entries[0]?.message).toBe('job-9 password=[redacted]');
  });
});
