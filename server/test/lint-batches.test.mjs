import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../', import.meta.url));
const runner = path.join(server, 'scripts/lint.mjs');

function fixture(t) {
  const prefix = path.join(tmpdir(), 'frameleaf-lint-');
  const cwd = realpathSync(mkdtempSync(prefix));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  copyFileSync(path.join(server, '.prettierrc'), path.join(cwd, '.prettierrc'));
  mkdirSync(path.join(cwd, 'src'));
  mkdirSync(path.join(cwd, 'test'));
  symlinkSync(path.join(server, 'node_modules'), path.join(cwd, 'node_modules'), 'dir');
  writeFileSync(
    path.join(cwd, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, target: 'es2024', module: 'nodenext', skipLibCheck: true },
      include: ['src', 'test'],
    }),
  );
  writeFileSync(
    path.join(cwd, 'eslint.config.mjs'),
    `
import config from ${JSON.stringify(path.join(server, 'eslint.config.mjs'))};
export default [...config, { files: ['**/*.ts'], languageOptions: { parserOptions: {
  project: 'tsconfig.json', tsconfigRootDir: ${JSON.stringify(cwd)}
} } }];
`,
  );
  return cwd;
}

function run(cwd, ...arguments_) {
  return spawnSync(process.execPath, [runner, ...arguments_], { cwd, encoding: 'utf8' });
}

test('lint covers every TS file once across batches even after an earlier warning', (t) => {
  const cwd = fixture(t);
  const files = Array.from({ length: 257 }, (_, index) => path.join(index % 2 ? 'src' : 'test', `fixture-${index}.ts`));
  for (const file of files) writeFileSync(path.join(cwd, file), 'const unused = 1;\nexport {};\n');
  writeFileSync(
    path.join(cwd, files[1]),
    `import type { Generated } from '@frameleaf/sql-tools';
import type { SelectType } from 'kysely';

export function allowed(ids: SelectType<Generated<string>>[]) {
  return ids.sort();
}
const unused = 1;
`,
  );
  writeFileSync(path.join(cwd, 'src', 'outside.js'), 'deliberately invalid javascript');
  writeFileSync(path.join(cwd, 'src', 'outside.tsx'), 'deliberately invalid typescript');
  for (const options of [[], ['--fix']]) {
    const result = run(cwd, ...options);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stderr, /maximum: 0/);
    const reported = result.stdout.split('\n').filter((line) => line.startsWith(cwd + path.sep));
    assert.deepEqual(
      reported.toSorted((left, right) => left.localeCompare(right)),
      files.map((file) => path.resolve(cwd, file)).toSorted((left, right) => left.localeCompare(right)),
    );
    const summaries = result.stdout.matchAll(/\((\d+) errors, (\d+) warnings?\)/g).toArray();
    assert.deepEqual(
      summaries.map((summary) => [Number(summary[1]), Number(summary[2])]),
      [
        [0, 256],
        [0, 1],
      ],
    );
  }
});

test('lint keeps typed async/sort/exhaustiveness guards and import validation', (t) => {
  const cwd = fixture(t);
  writeFileSync(
    path.join(cwd, 'src', 'rejected.ts'),
    `import { missing } from 'src/absent';

export { missing };
export const sorted = [1, 2].sort();
export async function rejected() {
  Promise.resolve();
  [1].forEach(async () => 1);
  await 1;
}
export function exhaustive(value: 'yes' | 'no') {
  switch (value) {
    case 'yes': {
      return 'yes';
    }
  }
}
`,
  );
  const result = run(cwd);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const rules = new Set(result.stdout.split('\n').map((line) => line.trim().split(/\s+/).at(-1)));
  for (const rule of [
    'no-floating-promises',
    'no-misused-promises',
    'await-thenable',
    'require-await',
    'require-array-sort-compare',
    'switch-exhaustiveness-check',
  ]) {
    assert.ok(rules.has(`@typescript-eslint/${rule}`), `missing guard: ${rule}; actual diagnostics: ${result.stdout}`);
  }
  assert.ok(rules.has('import-x/no-unresolved'));
});

test('lint forwards fix and preserves configuration failures', (t) => {
  const cwd = fixture(t);
  const file = path.join(cwd, 'src', 'fixed.ts');
  writeFileSync(file, 'export const value = "fixed";\n');
  const fixed = run(cwd, '--fix');
  assert.equal(fixed.status, 0, fixed.stderr + fixed.stdout);
  assert.equal(readFileSync(file, 'utf8'), "export const value = 'fixed';\n");
  writeFileSync(path.join(cwd, 'eslint.config.mjs'), 'throw new Error("fixture configuration rejected");');
  const rejected = run(cwd);
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /fixture configuration rejected/);
});

test('lint rejects reporting and validation overrides before running ESLint', (t) => {
  const cwd = fixture(t);
  const source = path.join(cwd, 'src', 'unchanged.ts');
  const original = 'export const unchanged = "value";\n';
  writeFileSync(source, original);
  const report = path.join(cwd, 'report.json');
  writeFileSync(report, 'existing report');
  for (const options of [
    ['--output-file', 'report.json'],
    ['--output-file=report.json'],
    ['-o', 'report.json'],
    ['-oreport.json'],
    ['-o=report.json'],
    ['--format', 'json'],
    ['--format=json'],
    ['-f', 'json'],
    ['-fjson'],
    ['-f=json'],
    ['--max-warnings', '999'],
    ['--max-warnings=999'],
    ['--no-config-lookup'],
    ['--rule', '@typescript-eslint/no-floating-promises: off'],
    ['--cache'],
    ['src/unchanged.ts'],
    ['--fix', '--output-file=report.json'],
    ['--fix', '--fix'],
  ]) {
    const rejected = spawnSync(process.execPath, [runner, ...options], { cwd, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0, `accepted unsupported options: ${options}`);
    assert.match(rejected.stderr, /accepts only default invocation or --fix/);
    assert.match(rejected.stderr, /native ESLint/);
    assert.equal(readFileSync(report, 'utf8'), 'existing report');
    assert.equal(readFileSync(source, 'utf8'), original);
  }
});

test('lint matches native ESLint glob coverage with nested dependency directories', (t) => {
  const cwd = fixture(t);
  const owned = ['src/owned.ts', 'test/owned.d.ts', 'src/.git/objects/owned.ts', 'test/node_modules_backup/owned.ts'];
  for (const file of owned) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), 'const unused = 1;\nexport {};\n');
  }
  for (const file of [
    'test/lifecycle/dependencies/node_modules/zod/index.ts',
    'test/lifecycle/dependencies/node_modules/zod/index.d.ts',
    'src/node_modules/ignored.ts',
    '.git/objects/ignored.ts',
  ]) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), 'vendor source should never be linted');
  }
  const eslint = fileURLToPath(new URL('bin/eslint.js', import.meta.resolve('eslint/package.json')));
  const native = spawnSync(
    process.execPath,
    [eslint, 'src/**/*.ts', 'test/**/*.ts', '--format=json', '--max-warnings', '0'],
    { cwd, encoding: 'utf8' },
  );
  const nativeResults = JSON.parse(native.stdout);
  const expected = nativeResults.map((entry) => entry.filePath).toSorted((left, right) => left.localeCompare(right));
  assert.deepEqual(
    expected,
    owned.map((file) => path.join(cwd, file)).toSorted((left, right) => left.localeCompare(right)),
  );
  for (const options of [[], ['--fix']]) {
    const batched = run(cwd, ...options);
    const actual = batched.stdout
      .split('\n')
      .filter((line) => line.startsWith(cwd + path.sep))
      .toSorted((left, right) => left.localeCompare(right));
    assert.deepEqual(actual, expected, batched.stderr + batched.stdout);
    assert.equal(batched.status, native.status);
    assert.doesNotMatch(batched.stdout, /File ignored by default|File ignored because/);
  }
});
