// Lifecycle failure contracts with stubs; not inference evidence.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withEphemeralPipeline } from './ephemeral-pipeline.mjs';

test('pipeline disposal and owned cache cleanup survive creation, inference and disposal failures', async (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'whisper-lifecycle-contract-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const sentinel = path.join(parent, 'unrelated'); writeFileSync(sentinel, 'keep');
  for (const failure of ['none', 'create', 'infer', 'dispose']) {
    let cache; let disposed = 0;
    const operation = withEphemeralPipeline(async (directory) => {
      cache = directory; writeFileSync(path.join(cache, 'partial-model'), 'stub');
      if (failure === 'create') throw new Error('create failure');
      return { dispose: async () => { disposed++; if (failure === 'dispose') throw new Error('dispose failure'); } };
    }, async () => { if (failure === 'infer') throw new Error('infer failure'); return 'result'; }, parent);
    if (failure === 'none') assert.equal(await operation, 'result'); else await assert.rejects(operation, new RegExp(`${failure} failure`));
    assert.equal(disposed, failure === 'create' ? 0 : 1);
    assert.equal(existsSync(cache), false); assert.equal(existsSync(sentinel), true);
  }
});
