import { GrantAdminCommand, RevokeAdminCommand } from 'src/commands/grant-admin.js';
import { ResetAdminPasswordCommand } from 'src/commands/reset-admin-password.command.js';

describe.each([
  ['grant-admin', GrantAdminCommand, 'grantAdminAccess'],
  ['revoke-admin', RevokeAdminCommand, 'revokeAdminAccess'],
  ['reset-admin-password', ResetAdminPasswordCommand, 'resetAdminPassword'],
] as const)('%s exit status', (_name, Command, method) => {
  const previousExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  it('reports a failed operation to the calling shell', async () => {
    const failure = new Error('operation failed');
    const action = vi.fn().mockRejectedValue(failure);
    const ask = vi.fn().mockResolvedValue({ email: 'admin@example.com' });
    const command = new Command({ [method]: action } as never, { ask } as never);

    await command.run();

    expect(action).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(failure);
    expect(process.exitCode).toBe(1);
  });

  it('preserves success and does not overwrite an existing failure', async () => {
    const action = vi.fn().mockResolvedValue({ provided: true });
    const ask = vi.fn().mockResolvedValue({ email: 'admin@example.com' });
    const command = new Command({ [method]: action } as never, { ask } as never);

    await command.run();
    expect(process.exitCode).toBe(0);
    process.exitCode = 2;
    await command.run();
    expect(process.exitCode).toBe(2);
    expect(console.error).not.toHaveBeenCalled();
  });
});
