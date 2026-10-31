#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from './engine.mjs';

/** FL-405: Frameleaf delivery status, recorded beside the fixed upstream preservation axes. */
export const FRAMELEAF_STATUSES = ['shipped', 'descoped-v1', 'not-started'];

export function checkFrameleafStatus(manifest, patchNames) {
  for (const { id, frameleaf } of manifest.features) {
    assert.ok(FRAMELEAF_STATUSES.includes(frameleaf?.status), `${id}: frameleaf.status must be one of ${FRAMELEAF_STATUSES.join(', ')}`);
    assert.ok(Array.isArray(frameleaf.evidence), `${id}: frameleaf.evidence must be an array`);
    if (frameleaf.status === 'shipped') assert.ok(frameleaf.evidence.length > 0, `${id}: a shipped row needs evidence`);
    for (const entry of frameleaf.evidence) {
      if (entry.endsWith('.patch')) assert.ok(patchNames.has(entry), `${id}: ${entry} is not in engine-build.json`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.deepEqual(process.argv.slice(2), ['--check'], 'Usage: node studio/tools/feature-manifest.mjs --check');
  const studio = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('freecut-feature-manifest.json', studio), 'utf8'));
  const build = JSON.parse(await readFile(new URL('engine-build.json', studio), 'utf8'));
  checkFrameleafStatus(manifest, new Set(build.patches.map(({ path }) => path.replace('patches/', ''))));
  await main(['verify']);
}
