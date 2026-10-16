import { readFile } from 'node:fs/promises';
import type { ImportConfig } from 'src/immich-import/types.js';
import { ImportImmichCommand } from 'src/commands/import-immich.command.js';
import { connectImportDatabase } from 'src/immich-import/database.js';
import { JobRepository } from 'src/repositories/job.repository.js';

const fixture = vi.hoisted(() => {
  const config: ImportConfig = {
    version: '3.2.4',
    sourceId: 'offline-source',
    writersStopped: true,
    mediaRoots: [{ source: '/source', target: '/target' }],
  };
  return {
    config,
    verify: vi.fn(async (dispatch: (config: ImportConfig) => Promise<unknown>) => dispatch(config)),
    status: vi.fn().mockResolvedValue({ status: 'activated', derivedRunId: 'retained-import-run' }),
    close: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(
    JSON.stringify({
      version: '3.2.4',
      sourceId: 'offline-source',
      writersStopped: true,
      mediaRoots: [{ source: '/source', target: '/target' }],
    }),
  ),
}));
vi.mock('src/immich-import/database.js', () => ({
  connectImportDatabase: vi.fn(() => ({ db: {}, close: fixture.close })),
}));
vi.mock('src/immich-import/importer.js', () => ({
  ImmichImportService: class {
    verify = fixture.verify;
    status = fixture.status;
  },
}));

it('finishes verification after one durable transfer and reports its run without waiting for workers', async () => {
  vi.stubEnv('DB_URL', 'postgres://fixture/destination');
  vi.stubEnv('FRAMELEAF_IMPORT_SOURCE_URL', 'postgres://fixture/source');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const dispatchImportedWork = vi.fn().mockResolvedValueOnce('retained-import-run').mockResolvedValue(undefined);
  try {
    const command = new ImportImmichCommand({ dispatchImportedWork } as unknown as JobRepository);
    await command.run(['verify'], { config: 'fixture.json' });
    expect(dispatchImportedWork).toHaveBeenCalledExactlyOnceWith(fixture.config);
    expect(fixture.verify).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(JSON.stringify({ status: 'activated', derivedRunId: 'retained-import-run' }));
    expect(fixture.close).toHaveBeenCalledTimes(2);
  } finally {
    output.mockRestore();
    vi.unstubAllEnvs();
  }
});

it('refuses Manager in-place verification without matching operation authority', async () => {
  vi.stubEnv('DB_URL', 'postgres://fixture/destination');
  vi.stubEnv('FRAMELEAF_IMPORT_SOURCE_URL', 'postgres://fixture/source');
  vi.stubEnv('FRAMELEAF_IMPORT_MANAGER_OPERATION_ID', 'different-operation');
  vi.mocked(readFile).mockResolvedValueOnce(
    JSON.stringify({
      version: '3.2.4',
      sourceId: 'offline-source',
      writersStopped: true,
      mediaRoots: [{ source: '/media', target: '/media' }],
      media: {
        mode: 'manager-in-place',
        authority: 'frameleaf-manager',
        operationId: 'operation-1',
        deploymentId: 'deployment-1',
      },
    }),
  );
  fixture.verify.mockClear();
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  const previousExitCode = process.exitCode;
  try {
    const command = new ImportImmichCommand({ dispatchImportedWork: vi.fn() } as unknown as JobRepository);
    await command.run(['verify'], { config: 'fixture.json' });
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith('Immich import refused: MANAGER_OPERATION_AUTHORITY_REQUIRED');
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previousExitCode;
    output.mockRestore();
    vi.unstubAllEnvs();
  }
});

describe('connection cleanup', () => {
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    exitCode = process.exitCode;
    process.exitCode = 0;
    vi.stubEnv('DB_URL', 'postgres://fixture/destination');
    vi.stubEnv('FRAMELEAF_IMPORT_SOURCE_URL', 'postgres://fixture/source');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(['source', 'target', 'both', 'synchronous source'])(
    'attempts both closes after %s failure without printing private errors',
    async (failure) => {
      const privateError = new Error('private driver URL, password and row values');
      const sourceClose = vi.fn(() => {
        if (failure === 'synchronous source') throw privateError;
        return failure === 'source' || failure === 'both' ? Promise.reject(privateError) : Promise.resolve();
      });
      const targetClose = vi.fn(() =>
        failure === 'target' || failure === 'both' ? Promise.reject(privateError) : Promise.resolve(),
      );
      vi.mocked(connectImportDatabase)
        .mockReturnValueOnce({ db: {} as never, close: targetClose })
        .mockReturnValueOnce({ db: {} as never, close: sourceClose });

      await new ImportImmichCommand({ dispatchImportedWork: vi.fn() } as never).run(['verify'], {
        config: 'fixture.json',
      });

      expect(sourceClose).toHaveBeenCalledOnce();
      expect(targetClose).toHaveBeenCalledOnce();
      expect(console.error).toHaveBeenCalledExactlyOnceWith('Immich import connection cleanup failed.');
      expect(process.exitCode).toBe(1);
    },
  );

  it('waits for the other close to finish after the source rejects', async () => {
    const started = Promise.withResolvers<void>();
    const releaseTarget = Promise.withResolvers<void>();
    const sourceClose = vi.fn(() => {
      started.resolve();
      return Promise.reject(new Error('private failure'));
    });
    const targetClose = vi.fn(() => releaseTarget.promise);
    vi.mocked(connectImportDatabase)
      .mockReturnValueOnce({ db: {} as never, close: targetClose })
      .mockReturnValueOnce({ db: {} as never, close: sourceClose });
    let settled = false;
    const running = new ImportImmichCommand({ dispatchImportedWork: vi.fn() } as never)
      .run(['verify'], { config: 'fixture.json' })
      .finally(() => {
        settled = true;
      });
    try {
      await started.promise;
      expect(targetClose).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
    } finally {
      releaseTarget.resolve();
      await running;
    }
    expect(settled).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('also closes both after the import fails, retaining sanitized failure output', async () => {
    fixture.verify.mockRejectedValueOnce(new Error('private import data'));
    const targetClose = vi.fn().mockResolvedValue(undefined);
    const sourceClose = vi.fn().mockRejectedValue(new Error('private source URL'));
    vi.mocked(connectImportDatabase)
      .mockReturnValueOnce({ db: {} as never, close: targetClose })
      .mockReturnValueOnce({ db: {} as never, close: sourceClose });
    await new ImportImmichCommand({ dispatchImportedWork: vi.fn() } as never).run(['verify'], {
      config: 'fixture.json',
    });
    expect(sourceClose).toHaveBeenCalledOnce();
    expect(targetClose).toHaveBeenCalledOnce();
    expect(vi.mocked(console.error).mock.calls).toEqual([
      ['Immich import failed; destination remains inactive. Check configuration and database access.'],
      ['Immich import connection cleanup failed.'],
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('closes only the opened destination when source admission is refused', async () => {
    vi.stubEnv('FRAMELEAF_IMPORT_SOURCE_URL', '');
    const targetClose = vi.fn().mockResolvedValue(undefined);
    vi.mocked(connectImportDatabase)
      .mockClear()
      .mockReturnValueOnce({ db: {} as never, close: targetClose });
    await new ImportImmichCommand({ dispatchImportedWork: vi.fn() } as never).run(['verify'], {
      config: 'fixture.json',
    });
    expect(targetClose).toHaveBeenCalledOnce();
    expect(connectImportDatabase).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalledWith('Immich import connection cleanup failed.');
    expect(process.exitCode).toBe(1);
  });
});
