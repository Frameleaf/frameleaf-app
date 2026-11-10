import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PrivateMlLogsService } from 'src/services/private-ml-logs.service.js';
import { privateLogStore } from 'src/utils/private-log-runtime.js';

describe(PrivateMlLogsService.name, () => {
  it('continues after restart without appending previously collected ML logs again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameleaf-ml-logs-'));
    const config = { getEnv: () => ({ logRetentionDays: 7, storage: { mediaLocation: root } }) };
    const store = privateLogStore(7, root);
    const at = new Date(Date.now() - 10_000).toISOString();
    const row = { id: randomUUID(), at, level: 'warn', message: 'prior entry' };
    const newer = { ...row, id: randomUUID(), message: 'new entry' };
    const readBundledWorkerLogs = vi
      .fn()
      .mockResolvedValue([row, newer].map((item) => JSON.stringify(item)).join('\n'));
    const service = new PrivateMlLogsService(config as never, { readBundledWorkerLogs } as never);
    try {
      await store.append('machine-learning', [
        { at, sourceId: row.id, level: 'warn', message: row.message, context: 'MachineLearning' },
      ]);
      service.start();
      await service['poll']();
      expect(readBundledWorkerLogs).toHaveBeenCalledWith(new Date(Date.parse(at) - 60_000).toISOString());
      const { entries } = await store.list({ worker: 'machine-learning', limit: 10 });
      expect(entries.map(({ id }) => id).toSorted()).toEqual([row.id, newer.id].toSorted());
    } finally {
      service.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
