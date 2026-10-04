import { Reflector } from '@nestjs/core';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ImportImmichCommand } from 'src/commands/import-immich.command.js';
import { commandsAndQuestions } from 'src/commands/index.js';

// nest-commander stores @QuestionSet options under this key (`QuestionSetMeta`, not exported).
const QUESTION_SET_METADATA = 'CommandBuilder:QuestionSet:Meta';

it('registers the one-way Immich importer in the admin CLI', () => {
  expect(commandsAndQuestions).toEqual(expect.arrayContaining([ImportImmichCommand]));
});

it('registers the question set of every question a command asks', () => {
  // `inquirer.ask(name)` fails at run time when no registered @QuestionSet carries that name.
  const folder = import.meta.dirname;
  const asked = new Set<string>();
  for (const file of readdirSync(folder)) {
    if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) {
      continue;
    }
    for (const match of readFileSync(join(folder, file), 'utf8').matchAll(/\.ask<[^>]*>\(\s*'([^']+)'/g)) {
      asked.add(match[1]!);
    }
  }
  const reflector = new Reflector();
  const registered = new Set(
    commandsAndQuestions.flatMap((provider) => {
      const questionSet = reflector.get<{ name?: unknown } | undefined>(QUESTION_SET_METADATA, provider);
      return typeof questionSet?.name === 'string' ? [questionSet.name] : [];
    }),
  );

  expect([...asked].filter((name) => !registered.has(name))).toEqual([]);
  expect(commandsAndQuestions.filter((provider) => provider === ImportImmichCommand)).toHaveLength(1);
});
