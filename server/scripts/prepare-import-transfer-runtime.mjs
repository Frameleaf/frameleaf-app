import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const server = fileURLToPath(new URL('../', import.meta.url));
const repository = resolve(server, '..');
const destination = resolve(server, 'resources/library-import');
const modules = [
  'contracts',
  'import-plan',
  'import-sqlite',
  'import-transfer-journal',
  'import-copy',
  'import-file-review',
  'import-adoption',
  'import-relocation',
];
const sources = [
  ...modules.map((name) => `manager/src/${name}.ts`),
  'manager/import-rename.c',
  'server/scripts/prepare-import-transfer-runtime.mjs',
  'server/package.json',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = async () =>
  Promise.all(sources.map(async (name) => ({ name, sha256: hash(await readFile(resolve(repository, name))) })));
const supportedPlatforms = ['linux', 'darwin', 'win32'];
const names = (platform) =>
  [
    ...modules.flatMap((name) => [`${name}.js`, `${name}.d.ts`]),
    'package.json',
    ...(platform === 'linux' ? ['frameleaf-import-rename'] : []),
  ].sort();

/** Verify the pruned package against its independently prepared build artifact, never execute media work. */
export async function verifyImportTransferRuntime(directory, canonical = directory) {
  assert((await lstat(directory)).isDirectory(), 'import runtime directory link');
  assert((await lstat(join(directory, 'runtime.json'))).isFile(), 'import runtime manifest link');
  const manifest = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
  assert.equal(manifest.format, 'frameleaf-import-transfer-runtime');
  assert.equal(manifest.version, 1);
  assert(supportedPlatforms.includes(manifest.platform), 'unsupported import runtime platform');
  assert.deepEqual(
    manifest.files.map(({ name }) => name),
    names(manifest.platform),
    'unexpected import runtime files',
  );
  assert.deepEqual(
    (await readdir(directory)).sort(),
    [...names(manifest.platform), 'runtime.json'].sort(),
    'unexpected import runtime contents',
  );
  assert.deepEqual(manifest.sources, await sourceHashes(), 'import runtime sources changed');
  for (const file of manifest.files) {
    const path = join(directory, file.name);
    const metadata = await lstat(path);
    assert(metadata.isFile(), 'import runtime artifact link or special file');
    if (file.name === 'frameleaf-import-rename')
      assert(metadata.mode & 0o111, 'import runtime helper is not executable');
    assert.equal(hash(await readFile(path)), file.sha256, 'import runtime artifact changed');
  }
  if (resolve(directory) !== resolve(canonical)) {
    assert.deepEqual(
      manifest,
      JSON.parse(await readFile(join(canonical, 'runtime.json'), 'utf8')),
      'import runtime differs from prepared build',
    );
    for (const file of manifest.files)
      assert.equal(
        hash(await readFile(join(canonical, file.name))),
        file.sha256,
        'prepared import runtime artifact changed',
      );
  }
  return manifest;
}

async function copyRuntime(source, target) {
  await mkdir(target, { recursive: true });
  assert((await lstat(target)).isDirectory(), 'refusing linked runtime output directory');
  const incoming = await readdir(source);
  for (const name of await readdir(target)) {
    assert([...names('linux'), 'runtime.json'].includes(name), 'refusing non-runtime output directory');
    assert((await lstat(join(target, name))).isFile(), 'refusing linked runtime output artifact');
    if (!incoming.includes(name)) await rm(join(target, name));
  }
  await cp(source, target, { recursive: true });
}

/** Restore the fixed runtime after pnpm's production pruning, then compare it with the prepared bytes. */
export async function packageImportTransferRuntime(packageDirectory, canonical = destination) {
  await verifyImportTransferRuntime(canonical);
  const output = resolve(packageDirectory, 'resources/library-import');
  await copyRuntime(canonical, output);
  return verifyImportTransferRuntime(output, canonical);
}

/** Compile only the existing transfer workers, using Server's installed compiler and dependencies. */
export async function prepareImportTransferRuntime(directory = destination) {
  assert(supportedPlatforms.includes(process.platform), 'unsupported import runtime build platform');
  directory = resolve(directory);
  await mkdir(dirname(directory), { recursive: true });
  const staging = await mkdtemp(join(dirname(directory), '.import-runtime-'));
  try {
    const before = await sourceHashes();
    const config = join(staging, 'tsconfig.json');
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
          declaration: true,
          rootDir: resolve(repository, 'manager/src'),
          outDir: staging,
          types: ['node'],
          typeRoots: [resolve(server, 'node_modules/@types')],
          paths: { zod: [resolve(server, 'node_modules/zod/index.d.ts')] },
        },
        files: modules.map((name) => resolve(repository, `manager/src/${name}.ts`)),
      }),
    );
    execFileSync(process.execPath, [resolve(server, 'node_modules/@typescript/native/bin/tsc'), '-p', config], {
      cwd: server,
      stdio: 'inherit',
      timeout: 120_000,
    });
    await rm(config);
    await writeFile(join(staging, 'package.json'), '{"type":"module"}\n');
    if (process.platform === 'linux') {
      const helper = join(staging, 'frameleaf-import-rename');
      execFileSync(
        'cc',
        [
          '-std=c11',
          '-O2',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-D_FORTIFY_SOURCE=3',
          '-fPIE',
          '-pie',
          '-Wl,-z,relro,-z,now',
          '-o',
          helper,
          resolve(repository, 'manager/import-rename.c'),
        ],
        { stdio: 'pipe', timeout: 120_000 },
      );
      try {
        execFileSync(helper, [], { stdio: 'pipe', timeout: 5000 });
        throw new Error('import helper accepted an invocation without descriptors');
      } catch (error) {
        assert.equal(error.status, 2, 'import helper is not executable for the build platform');
      }
    }
    assert.deepEqual(await sourceHashes(), before, 'import runtime sources changed during compilation');
    const files = await Promise.all(
      names(process.platform).map(async (name) => ({ name, sha256: hash(await readFile(join(staging, name))) })),
    );
    await writeFile(
      join(staging, 'runtime.json'),
      JSON.stringify(
        {
          format: 'frameleaf-import-transfer-runtime',
          version: 1,
          platform: process.platform,
          architecture: process.arch,
          sources: before,
          files,
        },
        null,
        2,
      ) + '\n',
    );
    await verifyImportTransferRuntime(staging);
    await copyRuntime(staging, directory);
    return verifyImportTransferRuntime(directory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--package' && process.argv.length === 4)
    await packageImportTransferRuntime(resolve(process.argv[3]));
  else if (process.argv[2] === '--verify' && process.argv.length === 4)
    await verifyImportTransferRuntime(resolve(process.argv[3]), destination);
  else {
    assert.equal(process.argv.length, 2, 'unknown import runtime build arguments');
    await prepareImportTransferRuntime();
  }
}
