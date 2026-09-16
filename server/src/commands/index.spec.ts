import { ForkHandoffCommand } from 'src/commands/fork-handoff.command.js';
import { ForkSchemaCutoverCommand } from 'src/commands/fork-schema-cutover.command.js';
import { ForkSchemaCommand } from 'src/commands/fork-schema.command.js';
import { commandsAndQuestions } from 'src/commands/index.js';

it('registers the schema conversion and both official handoff directions in the admin CLI', () => {
  expect(commandsAndQuestions).toEqual(
    expect.arrayContaining([ForkSchemaCommand, ForkSchemaCutoverCommand, ForkHandoffCommand]),
  );
});
