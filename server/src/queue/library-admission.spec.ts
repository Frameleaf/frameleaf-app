import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import type { QueueIntent } from 'src/queue/types.js';
import { JobName } from 'src/enum.js';
import {
  appendLibraryChildSources,
  appendLibraryInitialSources,
  libraryManifestIntent,
  libraryRunId,
  librarySourceKey,
  withLibraryQueueFence,
} from 'src/queue/library-admission.js';
import { RUN_OUTCOMES, runReasons, runState } from 'src/queue/run-query.js';
import { JobRepository } from 'src/repositories/job.repository.js';

const intent = (extra: Partial<QueueIntent> = {}): QueueIntent => ({
  name: JobName.SidecarCheck,
  queue: 'sidecar',
  data: { id: 'asset', source: 'upload' },
  safeToRetry: false,
  sensitive: false,
  deadlineMs: 60_000,
  rootItemKey: 'asset',
  ...extra,
});

describe('library source contracts', () => {
  it('uses actual operation identity independently of a producer wake', () => {
    expect(libraryRunId('operation')).toBe('operation');
    expect(librarySourceKey(intent({ runId: 'wake-one', itemKey: 'producer', parentId: 'parent-one' }))).toBe(
      librarySourceKey(intent({ runId: 'wake-two', itemKey: 'different', parentId: 'parent-two' })),
    );
    expect(() => librarySourceKey(intent({ rootItemKey: null }))).toThrow('actual media identity');
  });

  it('deduplicates equal declared options independently of object key order, but preserves changed destination/options', () => {
    const selected = intent({
      data: { id: 'asset', destination: 'local', pins: { model: 'v1', consent: 'accepted' } },
      options: { delay: 20, deduplication: { id: 'same' } },
    });
    const reordered = intent({
      data: { pins: { consent: 'accepted', model: 'v1' }, destination: 'local', id: 'asset' },
      options: { deduplication: { id: 'same' }, delay: 20 },
    });
    expect(librarySourceKey(selected)).toBe(librarySourceKey(reordered));
    for (const changed of [
      intent({ data: { ...selected.data, destination: 'remote' } }),
      intent({ ...selected, options: { delay: 21 } }),
      intent({ ...selected, deadlineMs: 61_000 }),
      intent({ ...selected, sensitive: true }),
    ])
      expect(librarySourceKey(changed)).not.toBe(librarySourceKey(selected));
  });

  it('round trips the complete declared intent while using accepted membership and retained parent identity', () => {
    const declared = intent({
      options: { delay: 50, deduplication: { id: 'pinned', keepLastIfActive: true } },
      data: { id: 'asset', modelId: 'pinned', destination: 'local' },
    });
    expect(
      libraryManifestIntent({
        libraryIntent: declared,
        libraryParentId: 'accepted-parent',
        runId: 'operation',
        itemKey: 'library/1',
        rootItemKey: 'asset',
      }),
    ).toEqual({ ...declared, parentId: 'accepted-parent', runId: 'operation', itemKey: 'library/1' });
    expect(
      libraryManifestIntent({
        libraryIntent: null,
        libraryParentId: null,
        runId: 'ordinary',
        itemKey: '1',
        rootItemKey: null,
      }),
    ).toBeUndefined();
  });

  it('decodes a shared physical owner without inventing options or replacing its pinned payload', () => {
    const declared = intent({
      name: JobName.AssetGenerateThumbnails,
      data: { id: 'actual-root', destination: { model: 'pinned', consent: 'retained' } },
      options: { delay: 123 },
      safeToRetry: false,
      sensitive: true,
      deadlineMs: 65_432,
    });
    expect(
      libraryManifestIntent({
        libraryIntent: declared,
        libraryParentId: 'one-parent',
        runId: 'operation-B',
        itemKey: 'B-source-key',
        rootItemKey: 'B-accounting-root',
        libraryExecutionRunId: 'operation-A',
        libraryExecutionItemKey: 'A-source-key',
        executionRootItemKey: 'actual-root',
      }),
    ).toEqual({
      ...declared,
      parentId: 'one-parent',
      runId: 'operation-A',
      itemKey: 'A-source-key',
      rootItemKey: 'actual-root',
    });
    expect(declared.options).toEqual({ delay: 123 });
  });

  it('rejects excess source and examined pages before reserving SQL or accepting any assets', async () => {
    const db = { transaction: vi.fn() };
    const page = Array.from({ length: 251 }, () => intent());
    await expect(appendLibraryInitialSources(db as never, 'operation', page)).rejects.toThrow('250');
    await expect(
      appendLibraryChildSources(db as never, { operationId: 'operation', jobId: 'parent', rootItemKey: 'asset' }, page),
    ).rejects.toThrow('250');
    const jobs = new JobRepository(
      {} as never,
      {} as never,
      {} as never,
      { setContext: vi.fn() } as never,
      db as never,
    );
    const work = vi.fn();
    for (const size of [-1, 251, NaN, 0.5])
      await expect(
        jobs.commitLibraryScanBatch({ operationId: 'operation', libraryId: 'library' }, size, work),
      ).rejects.toThrow('250');
    expect(work).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('validates an empty initial page without reading its item ledger', async () => {
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (kysely) => new PostgresIntrospector(kysely),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    const execute = vi.spyOn(db.getExecutor(), 'executeQuery');
    try {
      execute
        .mockResolvedValue({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ queue: 'sidecar', appendSequence: '0' }] });
      await appendLibraryInitialSources(db as never, 'operation', []);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0].sql).toContain('for update');
      execute.mockClear();
      await expect(appendLibraryInitialSources(db as never, 'operation', [])).rejects.toThrow('not open');
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await db.destroy();
    }
  });

  it('rejects already cancelled queue work before taking catalogue locks', async () => {
    const db = { transaction: vi.fn() };
    const controller = new AbortController();
    controller.abort(new Error('cancelled before admission'));
    const work = vi.fn();
    await expect(withLibraryQueueFence(db as never, { signal: controller.signal } as never, work)).rejects.toThrow(
      'cancelled before admission',
    );
    expect(work).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('shows an empty partial failed source as needing attention without claiming enumeration completed', () => {
    const stageTotals = Object.fromEntries(['total', ...RUN_OUTCOMES].map((key) => [key, 0])) as never;
    const row = {
      stageTotals,
      enumerationDone: false,
      unfinishedStages: 0,
      readyStages: 0,
      workerAvailable: true,
      librarySourceAttention: true,
      dependencyWaiting: false,
      dependencyUnavailable: false,
      dependencyReasons: [],
      dependencyFailed: false,
      noDispatchBacklog: false,
    };
    expect(runState(row)).toBe('needs_attention');
    expect(runReasons(row)).toEqual(['enumerating', 'needs_attention']);
    expect(runState({ ...row, librarySourceAttention: false })).toBe('running');
  });
});
