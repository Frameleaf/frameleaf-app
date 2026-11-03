#!/usr/bin/env node
// Runs every `*.test.mjs` under studio/tools that no dedicated workflow step already runs, so a new
// test file is executed by default instead of silently never running.
//
// The dedicated set is read from the workflow files themselves (every `studio/tools/**.test.mjs`
// path they name), so there is no second list to keep in sync: a test named by a workflow step
// (because it needs a browser, a report path or a special environment) is left to that step.
//
//   node studio/tools/run-tests.mjs            run the remaining tests with `node --test`
//   node studio/tools/run-tests.mjs --list     print what would run, one path per line
//   --all                                      ignore the workflows and run every test file
//   --except <path>                            leave out one more file (repeatable)
//   --workflow <file>                          read the dedicated set from this workflow (repeatable;
//                                              default: every .github/workflows/*.yml)
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tools = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(tools, '..', '..');
const relative = (file) => path.relative(repository, file).split(path.sep).join('/');

/** Every *.test.mjs under studio/tools, as repository-relative paths, sorted. */
export function discoverTests(root = tools) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) found.push(relative(file));
    }
  };
  walk(root);
  return found.sort();
}

/** The studio/tools test files a workflow names in its own steps (run there, not here). */
export function dedicatedTests(workflowText) {
  return new Set(workflowText.match(/studio\/tools\/[\w./-]+\.test\.mjs/g) ?? []);
}

function workflowFiles() {
  const directory = path.join(repository, '.github', 'workflows');
  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => path.join(directory, name));
}

export function selectTests({ all = false, except = [], workflows = workflowFiles() } = {}) {
  const tests = discoverTests();
  const skipped = new Set(except.map((file) => relative(path.resolve(repository, file))));
  if (!all) {
    for (const workflow of workflows) {
      for (const file of dedicatedTests(readFileSync(workflow, 'utf8'))) {
        if (!tests.includes(file)) throw new Error(`${relative(workflow)} names a missing test file: ${file}`);
        skipped.add(file);
      }
    }
  }
  return tests.filter((file) => !skipped.has(file));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = { all: false, except: [], workflows: undefined };
  let list = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--list') list = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--except' && args[index + 1]) options.except.push(args[++index]);
    else if (arg === '--workflow' && args[index + 1]) (options.workflows ??= []).push(path.resolve(args[++index]));
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (options.workflows === undefined) delete options.workflows;
  const selected = selectTests(options);
  if (list) {
    for (const file of selected) console.log(file);
    process.exit(0);
  }
  if (selected.length === 0) {
    console.log('run-tests: nothing left to run');
    process.exit(0);
  }
  for (const file of selected) statSync(path.join(repository, file));
  console.log(`run-tests: ${selected.length} test file(s)\n${selected.map((file) => `  ${file}`).join('\n')}`);
  // process.execArgv keeps flags a wrapper passed to this node (CI's --js-float16array wrapper).
  const result = spawnSync(process.execPath, [...process.execArgv, '--test', ...selected], {
    cwd: repository,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
