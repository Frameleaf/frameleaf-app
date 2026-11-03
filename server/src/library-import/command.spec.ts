import { randomUUID } from 'node:crypto';
import { executeLibraryImportCommand } from 'src/library-import/command.js';

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
});
