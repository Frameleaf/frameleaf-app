import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastGlob from 'fast-glob';

const options = process.argv.slice(2);
// Reporting and validation overrides belong in native ESLint, whose output is not split across batches.
if (options.length > 1 || (options.length === 1 && options[0] !== '--fix')) {
  throw new Error(
    'Server lint accepts only default invocation or --fix. Use native ESLint for custom reporting/options.',
  );
}

// FL-1264: CI splits lint across parallel jobs (SERVER_LINT_SHARD=1/3) and reuses main's results on PRs
// (SERVER_LINT_CACHE=<file>). Both are opt-in; a plain `pnpm run lint` still lints every file.
const shard = process.env.SERVER_LINT_SHARD;
const cache = process.env.SERVER_LINT_CACHE;
const [shardIndex, shardCount] = shard ? shard.split('/').map(Number) : [1, 1];
if (
  !Number.isSafeInteger(shardIndex) ||
  !Number.isSafeInteger(shardCount) ||
  shardIndex < 1 ||
  shardIndex > shardCount
) {
  throw new Error(`Invalid SERVER_LINT_SHARD: ${shard}`);
}
// Hashing the path keeps a file in the same shard when other files are added, so its cache entry stays usable.
const isInShard = (file) =>
  shardCount === 1 || (createHash('sha1').update(file).digest().readUInt32BE(0) % shardCount) + 1 === shardIndex;

const eslint = fileURLToPath(new URL('bin/eslint.js', import.meta.resolve('eslint/package.json')));
// Match ESLint's default directory ignores before passing explicit file paths.
const matches = await fastGlob(['src/**/*.ts', 'test/**/*.ts'], {
  dot: true,
  followSymbolicLinks: false,
  ignore: ['**/node_modules/**', '.git/**'],
});
const files = matches.filter((file) => isInShard(file)).toSorted((left, right) => left.localeCompare(right));
if (files.length === 0) {
  throw new Error('No server TypeScript files found for linting.');
}

const cacheOptions = cache ? ['--cache', '--cache-strategy', 'content', '--cache-location', cache] : [];
// Release TypeScript and import export-map caches between batches without weakening any rules.
// ponytail: a warm cache means only changed files are parsed, so one batch builds the type program once;
// a cold or absent cache keeps the memory-bounded batches.
const batchSize = cache && existsSync(cache) ? files.length : 256;
for (let offset = 0; offset < files.length; offset += batchSize) {
  const result = spawnSync(
    process.execPath,
    [eslint, ...files.slice(offset, offset + batchSize), '--max-warnings', '0', ...cacheOptions, ...options],
    { stdio: 'inherit' },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status === null || result.status > 1) {
    process.exitCode = result.status ?? 2;
    break;
  }
  process.exitCode ||= result.status;
}
