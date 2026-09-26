import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForkHandoffCommand } from 'src/commands/fork-handoff.command.js';
import { ForkSchemaCutoverCommand } from 'src/commands/fork-schema-cutover.command.js';
import { ConfirmForkSchemaAdoptQuestion, ForkSchemaCommand } from 'src/commands/fork-schema.command.js';
import { commandsAndQuestions } from 'src/commands/index.js';

it('registers the schema conversion and both official handoff directions in the admin CLI', () => {
  expect(commandsAndQuestions).toEqual(
    expect.arrayContaining([ForkSchemaCommand, ForkSchemaCutoverCommand, ForkHandoffCommand]),
  );
});

it('registers the question set of every question a command asks', () => {
  // `inquirer.ask(name)` fails at run time when no registered @QuestionSet carries that name.
  const folder = import.meta.dirname;
  const asked = new Set<string>();
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))) {
    for (const match of readFileSync(join(folder, file), 'utf8').matchAll(/\.ask<[^>]*>\(\s*'([^']+)'/g)) {
      asked.add(match[1]!);
    }
  }
  const registered = new Set(
    commandsAndQuestions.flatMap((provider) =>
      Reflect.getMetadataKeys(provider)
        .map((key) => Reflect.getMetadata(key, provider) as { name?: unknown } | undefined)
        .flatMap((metadata) => (typeof metadata?.name === 'string' ? [metadata.name] : [])),
    ),
  );

  expect(asked).toContain('confirm-fork-schema-adopt');
  expect(asked).toContain('confirm-fork-schema-start');
  expect([...asked].filter((name) => !registered.has(name))).toEqual([]);
  expect(commandsAndQuestions.filter((provider) => provider === ConfirmForkSchemaAdoptQuestion)).toHaveLength(1);
});
