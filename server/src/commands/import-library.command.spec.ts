import { randomUUID } from 'node:crypto';
import { ImportLibraryCommand } from 'src/commands/import-library.command.js';
import { sourceKinds } from 'src/library-import/manifest.js';
import { type JobRepository } from 'src/repositories/job.repository.js';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  load: vi.fn(),
  open: vi.fn(),
  execute: vi.fn(),
  request: vi.fn(),
}));
vi.mock('src/immich-import/database.js', () => ({ connectImportDatabase: mocks.connect }));
vi.mock('src/library-import/command.js', () => ({ executeLibraryImportCommand: mocks.execute }));
vi.mock('src/library-import/command-input.js', async (original) => ({
  ...(await original<typeof import('src/library-import/command-input.js')>()),
  loadLibraryImportConfig: mocks.load,
}));
vi.mock('src/library-import/local-transfer-state.js', () => ({ LocalLibraryImportState: { open: mocks.open } }));
vi.mock('src/library-import/manager-authority.js', () => ({ requestImportSourceAuthority: mocks.request }));

const operationId = randomUUID(),
  destinationId = randomUUID();
const config = {
  format: 'frameleaf-library-import-command',
  version: 1,
  operationId,
  destinationId,
  bundleDirectory: '/private/bundle',
  stateDirectory: '/private/state',
};
const local = { close: vi.fn() },
  connection = { db: {}, close: vi.fn() };
let previousExit: typeof process.exitCode;
beforeEach(() => {
  previousExit = process.exitCode;
  process.exitCode = undefined;
  vi.resetAllMocks();
  vi.stubEnv('DB_URL', 'postgresql://example.invalid/unused');
  vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', 'a'.repeat(12));
  vi.stubEnv('FRAMELEAF_IMPORT_MANAGER_OPERATION_ID', operationId);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.connect.mockReturnValue(connection);
  mocks.load.mockResolvedValue(config);
  mocks.open.mockResolvedValue(local);
  mocks.execute.mockResolvedValue({ run: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = previousExit;
});

it.each(sourceKinds)('routes %s through the same locked common command and live Manager authority', async (source) => {
  const binding = {
    operationId,
    manifestSha256: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    source: {
      kind: source,
      version: 'synthetic',
      identity: 'fixture',
      revision: 'frozen',
      schemaSha256: 'c'.repeat(64),
    },
  };
  mocks.execute.mockImplementation(async (input) => {
    await input.authorize('run', { binding, destinationId });
    return { run: null };
  });
  const jobs = {} as JobRepository;
  await new ImportLibraryCommand(jobs).run(['run'], { source, config: '/private/import.json' });
  expect(mocks.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      source,
      action: 'run',
      config,
      jobs,
      state: local,
      manager: { installation: 'a'.repeat(12), operationId },
    }),
  );
  expect(mocks.request).toHaveBeenCalledWith('run', { installation: 'a'.repeat(12), binding, destinationId });
  expect(local.close).toHaveBeenCalledOnce();
  expect(connection.close).toHaveBeenCalledOnce();
  expect(process.exitCode).toBeUndefined();
});

it('refuses mismatched Manager operation authority before connecting or creating state', async () => {
  vi.stubEnv('FRAMELEAF_IMPORT_MANAGER_OPERATION_ID', randomUUID());
  await new ImportLibraryCommand({} as JobRepository).run(['run'], {
    source: 'photoprism',
    config: '/private/import.json',
  });
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('IMPORT_MANAGER_AUTHORITY_REQUIRED'));
});

it('keeps status inspection available without a live Manager, while leaving existing recovery state intact', async () => {
  vi.stubEnv('FRAMELEAF_IMPORT_MANAGER_OPERATION_ID', '');
  vi.stubEnv('FRAMELEAF_MANAGER_INSTALLATION', '');
  await new ImportLibraryCommand({} as JobRepository).run(['status'], {
    source: 'ente',
    config: '/private/import.json',
  });
  expect(mocks.open).toHaveBeenCalledWith(config.stateDirectory, { create: false, readOnly: true });
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ action: 'status' }));
  expect(process.exitCode).toBeUndefined();
});

it('never exposes unexpected execution errors and closes both durable stores', async () => {
  mocks.execute.mockRejectedValue(new Error('synthetic-private-source-evidence'));
  await new ImportLibraryCommand({} as JobRepository).run(['verify'], {
    source: 'photoprism',
    config: '/private/import.json',
    activate: true,
  });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('synthetic-private-source-evidence');
  expect(console.log).not.toHaveBeenCalled();
  expect(local.close).toHaveBeenCalledOnce();
  expect(connection.close).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(1);
});
