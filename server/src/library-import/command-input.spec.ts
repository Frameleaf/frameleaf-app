import { parseLibraryImportArguments } from 'src/library-import/command-input.js';
import { sourceKinds } from 'src/library-import/manifest.js';

it.each(sourceKinds)('uses the same lifecycle arguments for %s', (source) => {
  for (const action of ['preflight', 'run', 'status', 'resume', 'verify', 'rollback', 'abandon'])
    expect(parseLibraryImportArguments([action, '--source', source, '--config', '/private/import.json'])).toEqual({
      action,
      source,
      configPath: '/private/import.json',
    });
});

it('requires an explicit verify activation option at the writer boundary', () => {
  expect(
    parseLibraryImportArguments(['verify', '--source', 'photoprism', '--config', '/private/import.json', '--activate']),
  ).toMatchObject({ action: 'verify', activate: true });
  expect(() =>
    parseLibraryImportArguments(['run', '--source', 'photoprism', '--config', '/private/import.json', '--activate']),
  ).toThrow('import_command_arguments_invalid');
});

it.each(
  [
    [],
    ['run'],
    ['run', '--source', 'unknown', '--config', '/private/import.json'],
    ['run', '--source', 'photoprism', '--config', '../import.json'],
    ['run', '--source', 'photoprism', '--config', '/private/../import.json'],
    ['run', '--source', 'photoprism', '--config', '/private/import.json', '--password', 'secret-fixture'],
    ['run', 'status', '--source', 'photoprism', '--config', '/private/import.json'],
    ['activate', '--source', 'photoprism', '--config', '/private/import.json'],
    ['run', '--source', 'photoprism', '--source', 'ente', '--config', '/private/import.json'],
    ['run', '--source', 'photoprism', '--config', '/private/import.json', '--config', '/other/import.json'],
  ].map((args) => ({ args })),
)('refuses incomplete, ambiguous or credential-bearing command arguments', ({ args }) => {
  expect(() => parseLibraryImportArguments(args)).toThrow('import_command_arguments_invalid');
});
