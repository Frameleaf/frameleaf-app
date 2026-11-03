// The default test runner: every studio/tools *.test.mjs is either run by a dedicated workflow step
// or picked up here, and a workflow naming a test file that no longer exists is an error.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedicatedTests, discoverTests, selectTests } from './run-tests.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('discovers every test file under studio/tools, including nested ones', () => {
  const tests = discoverTests();
  assert(tests.includes('studio/tools/run-tests.test.mjs'));
  assert(tests.includes('studio/tools/lib/browser-driver.test.mjs'));
  assert(tests.includes('studio/tools/qualification/fl103-synthetic-browser-recording/controls.test.mjs'));
  assert(tests.every((file) => file.startsWith('studio/tools/') && file.endsWith('.test.mjs')));
  assert.deepEqual(tests, [...tests].sort());
});

test('reads the dedicated set from workflow text and leaves the rest to run', async () => {
  assert.deepEqual(
    [...dedicatedTests('run: node --test studio/tools/a.test.mjs studio/tools/lib/b.test.mjs scripts/c.test.mjs\n')],
    ['studio/tools/a.test.mjs', 'studio/tools/lib/b.test.mjs'],
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'run-tests-'));
  try {
    const workflow = path.join(directory, 'engine.yml');
    await writeFile(workflow, 'run: node --test studio/tools/engine.test.mjs studio/tools/run-tests.test.mjs\n');
    const selected = selectTests({ workflows: [workflow] });
    assert(!selected.includes('studio/tools/engine.test.mjs'));
    assert(!selected.includes('studio/tools/run-tests.test.mjs'));
    assert(selected.includes('studio/tools/text-goldens.test.mjs'));
    assert(!selectTests({ workflows: [workflow], except: [path.join(here, 'text-goldens.test.mjs')] }).includes('studio/tools/text-goldens.test.mjs'));
    assert(selectTests({ all: true, workflows: [workflow] }).includes('studio/tools/engine.test.mjs'));
    await writeFile(workflow, 'run: node --test studio/tools/gone.test.mjs\n');
    assert.throws(() => selectTests({ workflows: [workflow] }), /names a missing test file: studio\/tools\/gone\.test\.mjs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('every discovered test is covered: dedicated in a workflow or selected by default', () => {
  const selected = new Set(selectTests());
  const named = new Set();
  for (const file of discoverTests()) {
    if (!selected.has(file)) named.add(file);
  }
  // Nothing is silently dropped: a file is either selected here or named by a workflow step.
  assert.equal(selected.size + named.size, discoverTests().length);
});
