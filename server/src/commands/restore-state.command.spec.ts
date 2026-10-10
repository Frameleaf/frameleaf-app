import { commandsAndQuestions } from 'src/commands/index.js';
import { RestoreStateCommand } from 'src/commands/restore-state.command.js';

it('registers stopped-worker restore reconstruction in the real admin command registry', () => {
  expect(commandsAndQuestions.filter((command) => command === RestoreStateCommand)).toHaveLength(1);
});

it('reconstructs execution state offline after canonical initialization and sanitizes failures', async () => {
  const previous = { ...process.env };
  const events: string[] = [];
  const database = {
    initialize: vi.fn().mockImplementation(() => {
      events.push('initialize');
      return Promise.resolve();
    }),
  };
  const repository = {
    resetTransientExecutionState: vi.fn().mockImplementation(() => {
      events.push('reset');
      return Promise.resolve();
    }),
  };
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exitCode = process.exitCode;
  try {
    process.env.FRAMELEAF_MANAGER_INSTALLATION = 'aaaabbbbcccc';
    process.env.FRAMELEAF_MANAGER_ORIGIN = 'restored_library';
    delete process.env.FRAMELEAF_MANAGER_RESTORE_OPERATION_ID;
    const command = new RestoreStateCommand(database as never, repository as never);
    await command.run();
    expect(events).toEqual([]);
    expect(process.exitCode).toBe(1);
    process.exitCode = exitCode;
    process.env.FRAMELEAF_MANAGER_RESTORE_OPERATION_ID = '11111111-2222-3333-4444-555555555555';
    await command.run();
    expect(events).toEqual(['initialize', 'reset']);
    expect(database.initialize).toHaveBeenCalledWith();
    expect(output).toHaveBeenLastCalledWith('{"reconstructed":true}');
    repository.resetTransientExecutionState.mockRejectedValueOnce(new Error('private database URL and password'));
    await command.run();
    expect(error.mock.calls.flat().join(' ')).not.toContain('private database');
    expect(process.exitCode).toBe(1);
  } finally {
    process.env = previous;
    process.exitCode = exitCode;
    output.mockRestore();
    error.mockRestore();
  }
});
