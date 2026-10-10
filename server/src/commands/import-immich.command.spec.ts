import { readFile } from 'node:fs/promises';
import type { ImportConfig } from 'src/immich-import/types.js';
import { ImportImmichCommand } from 'src/commands/import-immich.command.js';
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
