import { execFileSync } from 'node:child_process';
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
  for (const path of [
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
