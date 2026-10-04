import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { artifactDigest } from '../src/schema/catalog-artifacts.js';
import { validateFrameleafCatalog, verifyCatalogSources } from '../src/schema/catalog-authority.js';
import { normalizeBaselineDump } from '../src/schema/postgres-statements.js';
import { verifyRawCatalog } from '../src/schema/raw-catalog.js';

const [capture, output] = process.argv.slice(2, 4).map((path) => resolve(path));
if (!capture || !output)
  throw new Error('Usage: freeze-frameleaf-schema.ts <capture-directory> <new-output-directory>');
const desiredOnly = process.argv[4] === '--desired-only';
if (process.argv[4] && !desiredOnly) throw new Error('Unknown freeze mode');
const read = (name: string) => readFile(resolve(capture, name), 'utf8');
const source = JSON.parse(await read('frameleaf-capture-source.json'));
const current = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (source.sourceCommit !== current || source.serverVersion < 190000 || source.serverVersion >= 200000) {
  throw new Error('Freeze requires a capture from this exact committed source on PostgreSQL 19');
}
const catalogText = await read('frameleaf-schema-catalog.json');
const catalog = validateFrameleafCatalog(JSON.parse(catalogText));
if (catalog.tables.some(({ name }) => ['frameleaf_migrations', 'frameleaf_migrations_lock'].includes(name))) {
  throw new Error('Capture must exclude the migration-provider ledger');
}
const dump = await read('frameleaf-baseline.sql');
const raw = await read('frameleaf-raw-metadata.json');
verifyRawCatalog(catalog, JSON.parse(raw));
const baseline = desiredOnly ? await readFile(resolve(output, 'baseline.sql'), 'utf8') : normalizeBaselineDump(dump);
if (desiredOnly) {
  const pinned = JSON.parse(await readFile(resolve(output, 'baseline.sql.manifest.json'), 'utf8'));
  if (pinned.sha256 !== artifactDigest(baseline)) throw new Error('Existing immutable baseline digest mismatch');
}
const provenance = {
  ...source,
  baselineSha256: artifactDigest(baseline),
  dumpSha256: artifactDigest(dump),
  rawMetadataSha256: artifactDigest(raw),
};
await verifyCatalogSources(resolve(import.meta.dirname, '..'), provenance);
// New directory only: the initial migration must never be silently overwritten by a later capture.
if (!desiredOnly) await mkdir(output);
for (const [name, contents] of [
  ['baseline.sql', baseline],
  ['baseline.catalog.json', catalogText],
  ['desired-schema.catalog.json', catalogText],
] as const) {
  if (desiredOnly && name.startsWith('baseline')) continue;
  await writeFile(resolve(output, name), contents, { flag: desiredOnly ? 'w' : 'wx' });
  await writeFile(
    resolve(output, `${name}.manifest.json`),
    JSON.stringify({ sourceCommit: source.sourceCommit, sha256: artifactDigest(contents) }, null, 2) + '\n',
    { flag: desiredOnly ? 'w' : 'wx' },
  );
}
await writeFile(resolve(output, 'desired-schema.provenance.json'), JSON.stringify(provenance, null, 2) + '\n', {
  flag: desiredOnly ? 'w' : 'wx',
});
