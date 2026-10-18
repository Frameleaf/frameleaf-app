import { commandsAndQuestions } from 'src/commands/index.js';
import { ValidateRestoreCommand } from 'src/commands/validate-restore.command.js';

it('registers the read-only restore validation command once', () => {
  expect(commandsAndQuestions.filter((command) => command === ValidateRestoreCommand)).toHaveLength(1);
});

it('validates canonical migrations without initializing or migrating the restored database', async () => {
  const environment = { ...process.env };
  const exitCode = process.exitCode;
  const repository = {
    assertFrameleafDatabase: vi.fn().mockResolvedValue(undefined),
    assertImportActivated: vi.fn().mockResolvedValue(undefined),
  };
  const service = {
    schemaReport: vi
      .fn()
      .mockResolvedValue({ migrations: [{ name: 'initial', status: 'applied' }], drift: { items: [] } }),
  };
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    process.env.FRAMELEAF_MANAGER_ORIGIN = 'restored_library';
    process.env.FRAMELEAF_MANAGER_INSTALLATION = 'aaaabbbbcccc';
    process.env.FRAMELEAF_MANAGER_RESTORE_OPERATION_ID = '11111111-1111-4111-8111-111111111111';
    const command = new ValidateRestoreCommand(service as never, repository as never);
    await command.run();
    expect(repository.assertFrameleafDatabase).toHaveBeenCalledOnce();
    expect(repository.assertImportActivated).toHaveBeenCalledOnce();
    expect(service.schemaReport).toHaveBeenCalledOnce();
    expect(output).toHaveBeenLastCalledWith(
      JSON.stringify({
        protocolVersion: 1,
        state: 'restore-schema-valid',
        installationId: 'aaaabbbbcccc',
        operationId: process.env.FRAMELEAF_MANAGER_RESTORE_OPERATION_ID,
      }),
    );
    for (const report of [
      { migrations: [], drift: { items: [] } },
      { migrations: [{ status: 'missing' }], drift: { items: [] } },
      { migrations: [{ status: 'deleted' }], drift: { items: [] } },
      { migrations: [{ status: 'applied' }], drift: { items: [{ secret: 'private SQL and path' }] } },
    ]) {
      output.mockClear();
      service.schemaReport.mockResolvedValueOnce(report as never);
      await command.run();
      expect(process.exitCode).toBe(1);
      expect(output).not.toHaveBeenCalled();
    }
    repository.assertImportActivated.mockRejectedValueOnce(new Error('private database URL and password'));
    output.mockClear();
    await command.run();
    expect(output).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(' ')).not.toMatch(/private|password|SQL/);
    repository.assertFrameleafDatabase.mockClear();
    const validOperation = process.env.FRAMELEAF_MANAGER_RESTORE_OPERATION_ID;
    for (const [origin, installation, operation] of [
      ['new_library', 'aaaabbbbcccc', validOperation],
      ['restored_library', '../outside', validOperation],
      ['restored_library', 'aaaabbbbcccc', undefined],
      ['restored_library', 'aaaabbbbcccc', '00000000-0000-0000-0000-000000000000'],
      ['restored_library', 'aaaabbbbcccc', 'not-an-operation'],
    ]) {
      process.env.FRAMELEAF_MANAGER_ORIGIN = origin;
      process.env.FRAMELEAF_MANAGER_INSTALLATION = installation;
      if (operation === undefined) delete process.env.FRAMELEAF_MANAGER_RESTORE_OPERATION_ID;
      else process.env.FRAMELEAF_MANAGER_RESTORE_OPERATION_ID = operation;
      await command.run();
      expect(repository.assertFrameleafDatabase).not.toHaveBeenCalled();
    }
  } finally {
    process.env = environment;
    process.exitCode = exitCode;
    output.mockRestore();
    error.mockRestore();
  }
});
