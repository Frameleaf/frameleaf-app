import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applicationQualificationImage, cleanupQualification, qualificationImage } from '../scripts/cleanup-photoprism-qualification.mjs';

const fixture = (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'photoprism-cleanup-check-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'frameleaf-photoprism-123-1');
  const other = join(parent, 'frameleaf-photoprism-123-2');
  for (const directory of [root, other]) {
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, 'client.cnf'), 'synthetic-only', { mode: 0o600 });
  }
  writeFileSync(join(root, 'image.json'), JSON.stringify({ createdImage: true }));
  return { root, other, parent };
};
test('removes only the cancelled run credentials and labelled Docker resources', (t) => {
  const { root, other } = fixture(t);
  const calls = [];
  const docker = (args) => {
    calls.push(args);
    if (args[0] === 'ps' && args.some((value) => value === 'label=app.frameleaf.qualification-run=123-1'))
      return 'a'.repeat(64);
    if (args[0] === 'image' && args[1] === 'ls') return 'image-id';
    if (args[0] === 'volume' && args[1] === 'ls') return 'frameleaf-photoprism-test-aaaaaaaa-data';
    return '';
  };
  cleanupQualification('123-1', root, docker);
  assert.equal(existsSync(root), false);
  assert.equal(readFileSync(join(other, 'client.cnf'), 'utf8'), 'synthetic-only');
  const lists = calls.filter(
    (args) =>
      (args[0] === 'ps' && !args.includes(`ancestor=${qualificationImage}`)) ||
      (args[0] === 'volume' && args[1] === 'ls'),
  );
  assert.equal(lists.length, 2);
  assert.ok(lists.every((args) => args.includes('label=app.frameleaf.qualification-run=123-1')));
  assert.ok(calls.some((args) => args[0] === 'rm' && args.includes('a'.repeat(64))));
  assert.ok(calls.some((args) => args[0] === 'image' && args[1] === 'rm'));
});
test('retains an image while another container still uses it', (t) => {
  const { root, other } = fixture(t);
  const calls = [];
  cleanupQualification('123-1', root, (args) => {
    calls.push(args);
    return args.includes(`ancestor=${qualificationImage}`) ? 'b'.repeat(64) : '';
  });
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(other), true);
  assert.ok(!calls.some((args) => args[0] === 'image' && args[1] === 'rm'));
});
test('removes private credentials even when Docker cleanup is unavailable', (t) => {
  const { root, other } = fixture(t);
  assert.throws(
    () =>
      cleanupQualification('123-1', root, () => {
        throw new Error('Docker unavailable');
      }),
    AggregateError,
  );
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(other), true);
});
test('refuses an unscoped or mismatched temporary root without touching it', (t) => {
  const { root, parent } = fixture(t);
  for (const directory of [parent, root]) {
    assert.throws(
      () => cleanupQualification('123-2', directory, () => assert.fail('Docker must not run')),
      /Invalid qualification cleanup scope/,
    );
    assert.equal(existsSync(directory), true);
  }
});
test('retains a pre-existing image and supports repeated cleanup', (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'image.json'), JSON.stringify({ createdImage: false }));
  const docker = (args) => {
    assert.notEqual(args[0], 'image');
    return '';
  };
  cleanupQualification('123-1', root, docker);
  cleanupQualification('123-1', root, docker);
  assert.equal(existsSync(root), false);
});

test('removes only the application image pulled by this run and scopes application containers to the same family', (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'image.json'), JSON.stringify({ createdImage: false }));
  writeFileSync(join(root, 'application-image.json'), JSON.stringify({ createdImage: true }));
  const calls = [];
  cleanupQualification('123-1', root, (args) => {
    calls.push(args);
    return args[0] === 'image' && args[1] === 'ls' ? 'application-image' : '';
  });
  assert.ok(calls.some((args) => args[0] === 'image' && args[1] === 'rm' && args[2] === applicationQualificationImage));
  assert.ok(!calls.some((args) => args[0] === 'image' && args[1] === 'rm' && args[2] === qualificationImage));
  assert.ok(calls.some((args) => args.includes('label=app.frameleaf.qualification-family=photoprism')));
});
