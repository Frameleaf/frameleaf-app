import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanupQualification, qualificationImage } from '../scripts/cleanup-photoview-qualification.mjs';

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
    if (args[0] === 'image' && args[1] === 'ls') return 'image-id';
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
for (const reason of ['preexisting', 'in-use'])
  test(`retains an ${reason} image`, (t) => {
    const { root } = fixture(t);
    if (reason === 'preexisting') writeFileSync(join(root, 'image.json'), JSON.stringify({ createdImage: false }));
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
