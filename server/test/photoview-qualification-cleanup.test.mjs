import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  cleanupQualification,
  hasQualificationImage,
  qualificationImage,
} from '../scripts/cleanup-photoview-qualification.mjs';

const fixture = (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'photoview-cleanup-check-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'frameleaf-photoview-123-1'),
    other = join(parent, 'frameleaf-photoview-123-2');
  for (const path of [root, other]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(root, 'image.json'), JSON.stringify({ createdImage: true }));
  return { root, other, parent };
};
test('removes only the labelled run and its unused newly pulled image', (t) => {
  const { root, other } = fixture(t);
  const calls = [];
  cleanupQualification('123-1', root, (args) => {
    calls.push(args);
    if (args.includes('label=app.frameleaf.qualification-run=123-1')) return 'a'.repeat(64);
    if (args[0] === 'image' && args[1] === 'ls') return qualificationImage.split('@')[1];
    return '';
  });
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(other), true);
  assert.ok(
    calls.some((args) => args[0] === 'ps' && args.includes('label=app.frameleaf.qualification-family=photoview')),
  );
  assert.ok(calls.some((args) => args[0] === 'rm' && args.includes('-v') && args.includes('a'.repeat(64))));
  assert.ok(calls.some((args) => args[0] === 'image' && args[1] === 'rm' && args[2] === qualificationImage));
});
for (const reason of ['preexisting', 'in-use', 'unrecorded'])
  test(`retains an ${reason} image`, (t) => {
    const { root } = fixture(t);
    if (reason === 'preexisting') writeFileSync(join(root, 'image.json'), JSON.stringify({ createdImage: false }));
    if (reason === 'unrecorded') rmSync(join(root, 'image.json'));
    const calls = [];
    cleanupQualification('123-1', root, (args) => {
      calls.push(args);
      return args.includes(`ancestor=${qualificationImage}`) ? 'b'.repeat(64) : '';
    });
    assert.ok(!calls.some((args) => args[0] === 'image' && args[1] === 'rm'));
  });
test('refuses a mismatched root and cleans private state even when Docker fails', (t) => {
  const { root, other, parent } = fixture(t);
  assert.throws(
    () => cleanupQualification('123-2', parent, () => assert.fail('No Docker access')),
    /Invalid qualification cleanup scope/,
  );
  assert.equal(existsSync(root), true);
  assert.throws(
    () =>
      cleanupQualification('123-1', root, () => {
        throw new Error('Unavailable');
      }),
    AggregateError,
  );
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(other), true);
});

test('failed image lookup never records ownership or starts a fixture', (t) => {
  const { root, parent } = fixture(t);
  rmSync(join(root, 'image.json'));
  const bin = join(parent, 'bin'),
    calls = join(parent, 'calls.jsonl');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(process.env.PHOTOVIEW_FIXTURE_CALLS, JSON.stringify({args, marker: existsSync(join(process.env.TMPDIR, 'image.json'))}) + '\\n');
process.exit(args[0] === 'image' ? 1 : 0);
`,
    { mode: 0o700 },
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../scripts/qualify-photoview-application.mjs', import.meta.url))],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        TMPDIR: root,
        FRAMELEAF_PHOTOVIEW_RUN_ID: '123-1',
        PHOTOVIEW_FIXTURE_CALLS: calls,
        PATH: bin + delimiter + process.env.PATH,
      },
    },
  );
  assert.equal(result.status, 1);
  const recorded = readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(recorded[0].args, ['image', 'ls', '--all', '--digests', '--format', '{{.Digest}}']);
  assert.ok(recorded.every(({ marker }) => !marker));
  assert.ok(recorded.every(({ args }) => args[0] !== 'run' && !(args[0] === 'image' && args[1] === 'rm')));
  assert.equal(existsSync(root), false);
});

test('requires the pinned digest in the local image inventory', () => {
  assert.equal(
    hasQualificationImage(() => '<none>\nsha256:' + '0'.repeat(64)),
    false,
  );
  assert.equal(
    hasQualificationImage(() => '<none>\n' + qualificationImage.split('@')[1]),
    true,
  );
});
