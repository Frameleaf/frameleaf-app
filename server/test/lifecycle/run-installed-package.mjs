import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { extractVerifiedContractsArchive } from './verified-contracts-archive.mjs';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const receipt = JSON.parse(readFileSync(new URL('./contracts-package-receipt.json', import.meta.url), 'utf8'));
let staging;
try {
  const archivePath = process.env.FRAMELEAF_CLOUD_LIFECYCLE_TGZ;
  if (!archivePath) throw new Error('FRAMELEAF_CLOUD_LIFECYCLE_TGZ is required; supply the immutable registry archive');
  staging = mkdtempSync(join(tmpdir(), 'library-lifecycle-installed-'));
  extractVerifiedContractsArchive(archivePath, receipt, staging);
  const packageRoot = join(staging, 'package');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== receipt.name || manifest.version !== receipt.version)
    throw new Error('Cloud package identity mismatch');
  const dependencies = resolve(process.env.FRAMELEAF_CLOUD_LIFECYCLE_NODE_MODULES ?? join(serverRoot, 'node_modules'));
  const zod = JSON.parse(readFileSync(join(dependencies, 'zod/package.json'), 'utf8'));
  if (!semver.satisfies(zod.version, manifest.dependencies.zod)) {
    throw new Error(
      'Supply FRAMELEAF_CLOUD_LIFECYCLE_NODE_MODULES with Zod satisfying the immutable package dependency',
    );
  }
  symlinkSync(dependencies, join(packageRoot, 'node_modules'), 'dir');
  const result = spawnSync(
    process.execPath,
    [join(serverRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'test/vitest.config.lifecycle.mjs'],
    {
      cwd: serverRoot,
      stdio: 'inherit',
      env: { ...process.env, FRAMELEAF_CLOUD_LIFECYCLE_TEST_MODULE: join(packageRoot, receipt.testingExport) },
    },
  );
  process.exitCode = result.status ?? 1;
} catch (error) {
  const allowed = [
    'FRAMELEAF_CLOUD_LIFECYCLE_TGZ is required; supply the immutable registry archive',
    'Cloud contracts archive does not match the pinned receipt',
    'Verified Cloud contracts archive could not be extracted',
    'Cloud package identity mismatch',
    'Supply FRAMELEAF_CLOUD_LIFECYCLE_NODE_MODULES with Zod satisfying the immutable package dependency',
  ];
  console.error(
    error instanceof Error && allowed.includes(error.message)
      ? error.message
      : 'Required local package artifact or dependencies are unavailable',
  );
  process.exitCode = 1;
} finally {
  if (staging) rmSync(staging, { recursive: true, force: true });
}
