import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const options = process.argv.slice(2);
// Reporting and validation overrides belong in native ESLint, whose output is not split across batches.
if (options.length > 1 || (options.length === 1 && options[0] !== '--fix')) {
  throw new Error(
    'Server lint accepts only default invocation or --fix. Use native ESLint for custom reporting/options.',
  );
}

const eslint = fileURLToPath(new URL('bin/eslint.js', import.meta.resolve('eslint/package.json')));
const files = [...globSync(['src/**/*.ts', 'test/**/*.ts'])].toSorted((left, right) => left.localeCompare(right));
if (files.length === 0) {
  throw new Error('No server TypeScript files found for linting.');
}

// Release TypeScript and import export-map caches between batches without weakening any rules.
const batchSize = 256;
for (let offset = 0; offset < files.length; offset += batchSize) {
  const result = spawnSync(
    process.execPath,
    [eslint, ...files.slice(offset, offset + batchSize), '--max-warnings', '0', ...options],
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
