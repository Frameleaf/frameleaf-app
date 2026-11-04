import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  getFrameleafBaselineSchema,
  getFrameleafSchema,
  verifyFrameleafSchemaSources,
} from '../src/schema/frameleaf-schema.js';
import { readPinnedArtifact } from '../src/schema/catalog-artifacts.js';

getFrameleafBaselineSchema();
getFrameleafSchema();
readPinnedArtifact('baseline.sql');
await verifyFrameleafSchemaSources();
const baselineRef = process.argv[2];
if (baselineRef) {
  if (!/^[a-f\d]{40}$/u.test(baselineRef)) throw new Error('Baseline comparison requires an exact commit SHA');
  const repository = resolve(import.meta.dirname, '../..');
  const order = (ref?: string) =>
    (ref
      ? execFileSync('git', ['show', `${ref}:server/src/schema/migrations/ORDER`], {
          cwd: repository,
          encoding: 'utf8',
        })
      : readFileSync(resolve(repository, 'server/src/schema/migrations/ORDER'), 'utf8')
    )
      .trim()
      .split(/\r?\n/u);
  // A migration reset squashes the whole chain into a new baseline, leaving ORDER with the baseline alone.
  // Any other baseline edit is still rejected.
  const reset = order().length === 1 && order(baselineRef).length > 1;
  for (const path of reset
    ? []
    : [
        'server/src/schema/migrations/0000000000000-FrameleafBaseline.ts',
        'server/src/schema/catalog/baseline.sql',
        'server/src/schema/catalog/baseline.sql.manifest.json',
        'server/src/schema/catalog/baseline.catalog.json',
        'server/src/schema/catalog/baseline.catalog.json.manifest.json',
      ]) {
    // Pre-freeze branches legitimately have no pinned SQL yet. Once frozen, all baseline files are append-only history.
    const frozen = execFileSync(
      'git',
      ['ls-tree', '--name-only', baselineRef, '--', 'server/src/schema/catalog/baseline.sql'],
      { cwd: repository, encoding: 'utf8' },
    ).trim();
    if (!frozen) break;
    // The complete frozen catalog exceeds Node's default 1 MiB pipe buffer.
    // Retain the full byte comparison; an oversized/erroring read must still fail closed.
    const previous = execFileSync('git', ['show', `${baselineRef}:${path}`], {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (previous !== (await readFile(resolve(repository, path), 'utf8')))
      throw new Error(`Immutable Frameleaf baseline changed: ${path}`);
  }
}
