import { ImportImmichCommand } from 'src/commands/import-immich.command.js';
import { JobRepository } from 'src/repositories/job.repository.js';

const fixture = vi.hoisted(() => ({
  verify: vi.fn(async (dispatch: () => Promise<unknown>) => dispatch()),
  status: vi.fn().mockResolvedValue({ status: 'activated', derivedRunId: 'retained-import-run' }),
  close: vi.fn().mockResolvedValue(undefined),
}));
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
    expect(dispatchImportedWork).toHaveBeenCalledOnce();
    expect(fixture.verify).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(JSON.stringify({ status: 'activated', derivedRunId: 'retained-import-run' }));
    expect(fixture.close).toHaveBeenCalledTimes(2);
  } finally {
    output.mockRestore();
    vi.unstubAllEnvs();
  }
});
