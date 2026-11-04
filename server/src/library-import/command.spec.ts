import { randomUUID } from 'node:crypto';
import { executeLibraryImportCommand } from 'src/library-import/command.js';
import * as executionLock from 'src/library-import/execution-lock.js';

afterEach(() => vi.restoreAllMocks());

const setup = () => ({
  config: {
    format: 'frameleaf-library-import-command' as const,
    version: 1 as const,
    operationId: randomUUID(),
    destinationId: randomUUID(),
    bundleDirectory: '/private/export',
    stateDirectory: '/private/recovery',
  },
  source: 'photoprism' as const,
  db: { query: vi.fn(), transaction: vi.fn() },
  jobs: {} as never,
  state: { inspect: vi.fn(), bind: vi.fn() } as never,
  authorize: vi.fn(),
});

describe('common library command trust boundary', () => {
  it.each(['preflight', 'run', 'status', 'resume', 'verify', 'rollback', 'abandon'] as const)(
    '%s requires a trusted source authority and the actual process lock before accessing a database',
    async (action) => {
      const input = setup();
      await expect(executeLibraryImportCommand({ ...input, action, authorize: undefined as never })).rejects.toThrow(
        'IMPORT_SOURCE_AUTHORITY_REQUIRED',
      );
      await expect(executeLibraryImportCommand({ ...input, action })).rejects.toThrow(
        'import_execution_lock_unavailable',
      );
      expect(input.db.query).not.toHaveBeenCalled();
      expect(input.authorize).not.toHaveBeenCalled();
    },
  );
  it('refuses activation on any action other than explicit verification', async () => {
    const input = setup();
    await expect(executeLibraryImportCommand({ ...input, action: 'run', activate: true })).rejects.toThrow(
      'IMPORT_ACTIVATION_REQUIRES_VERIFY',
    );
    expect(input.db.query).not.toHaveBeenCalled();
  });

  it.each([
    ['rollback', 'prepared'],
    ['abandon', 'prepared'],
    ['rollback', 'abandoned'],
    ['abandon', 'abandoned'],
  ] as const)('requires live authority for %s of an untouched %s import', async (action, phase) => {
    const input = setup();
    const lock = { device: '1', inode: '2' };
    vi.spyOn(executionLock, 'assertImportExecutionLock').mockResolvedValue(lock);
    const binding = {
      operationId: input.config.operationId,
      manifestSha256: 'a'.repeat(64),
      planSha256: 'b'.repeat(64),
      source: {
        kind: input.source,
        version: 'synthetic',
        identity: 'synthetic-source',
        revision: 'frozen',
        schemaSha256: 'c'.repeat(64),
      },
    };
    const local = {
      identity: { lock },
      db: {
        prepare: vi.fn().mockReturnValue({
          get: () => ({
            id: input.config.operationId,
            value: JSON.stringify({ input: { binding, destinationId: input.config.destinationId } }),
          }),
        }),
      },
      inspect: vi
        .fn()
        .mockReturnValue({ phase, abandoned: phase === 'abandoned', writersMayHaveStarted: false, files: [] }),
      bind: vi.fn(),
      mark: vi.fn(),
    };
    input.db.query
      .mockResolvedValueOnce([{ binding, status: phase === 'prepared' ? 'copying' : 'abandoned' }])
      .mockResolvedValueOnce([]);
    input.authorize.mockRejectedValue(new Error('synthetic source authority refused'));
    await expect(executeLibraryImportCommand({ ...input, action, state: local as never })).rejects.toThrow(
      'synthetic source authority refused',
    );
    expect(input.authorize).toHaveBeenCalledWith(action, { binding, destinationId: input.config.destinationId });
    expect(input.db.transaction).not.toHaveBeenCalled();
    expect(local.bind).not.toHaveBeenCalled();
    expect(local.mark).not.toHaveBeenCalled();
  });
});
