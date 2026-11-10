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

  it('includes the full since second when the query omits milliseconds', async () => {
    const store = new PrivateLogStore(root);
    const since = '2026-11-09T12:00:00Z';
    const now = new Date('2026-11-09T12:00:01Z');
    const tail = await store.follow({ since });
    await store.append(
      'api',
      [
        { level: 'log', context: 'Test', message: 'before', at: '2026-11-09T11:59:59.999Z' },
        { level: 'log', context: 'Test', message: 'match', at: '2026-11-09T12:00:00.000Z' },
      ],
      now,
    );
    const { entries } = await store.list({ limit: 2, since }, now);
    expect(entries.map((entry) => entry.message)).toEqual(['match']);
    expect((await Array.fromAsync(tail())).flat().map((entry) => entry.message)).toEqual(['match']);
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
  it('finds a line by the photo, request or job it names', async () => {
    const store = new PrivateLogStore(root);
    const now = new Date('2026-11-09T12:00:05.000Z');
    const assetId = '7b1f2c9e-4d3a-4f7e-9c1d-2a3b4c5d6e7f';
    const jobId = '0f0e0d0c-0b0a-4908-8706-050403020100';
    await store.append(
      'microservices',
      [
        {
          level: 'error',
          context: 'Thumbnails',
          message: 'Could not read the file',
          assetId,
          at: '2026-11-09T12:00:00.000Z',
        },
        { level: 'log', context: 'Thumbnails', message: 'Made previews', jobId, at: '2026-11-09T12:00:01.000Z' },
        { level: 'log', context: 'Thumbnails', message: 'Unrelated', at: '2026-11-09T12:00:02.000Z' },
      ],
      now,
    );
    const messages = async (q: string) =>
      (await store.list({ limit: 10, q }, now)).entries.map((entry) => entry.message);
    expect(await messages(assetId.toUpperCase())).toEqual(['Could not read the file']);
    expect(await messages(jobId)).toEqual(['Made previews']);
  });
});
