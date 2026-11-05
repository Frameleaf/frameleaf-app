import { type Kysely, sql } from 'kysely';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

const execute = promisify(execFile);
const server = fileURLToPath(new URL('../../../../', import.meta.url));
// A parent qualification script names one disposable native application whose stopped capture is imported.
const nativeSource = process.env.FRAMELEAF_NATIVE_IMPORT_SOURCE;
if (nativeSource !== undefined && !/^[a-z0-9]+$/u.test(nativeSource)) throw new Error('Invalid native import source');

describe.skipIf(process.platform !== 'linux')('common import lifecycle on native files and databases', () => {
  let build: string;
  const cleanupFailures: unknown[] = [];
  beforeAll(async () => {
    build = await realpath(await mkdtemp(join(tmpdir(), 'frameleaf-import-lifecycle-build-')));
    await execute(process.execPath, [join(server, 'scripts/prepare-import-transfer-runtime.mjs')], { cwd: server });
    await execute(
      process.execPath,
      [
        join(server, 'node_modules/@typescript/native/bin/tsc'),
        '--outDir',
        build,
        '--declaration',
        'false',
        '--sourceMap',
        'false',
        '--incremental',
        'false',
        '--noCheck',
        'true',
      ],
      { cwd: server, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
    );
    await cp(join(server, 'resources/library-import'), join(build, 'resources/library-import'), { recursive: true });
    await cp(join(server, 'src/schema/catalog'), join(build, 'src/schema/catalog'), { recursive: true });
    await cp(join(server, 'src/schema/migrations/ORDER'), join(build, 'src/schema/migrations/ORDER'));
    await cp(join(server, 'test/medium/fixtures/library-import-lifecycle.mjs'), join(build, 'runner.mjs'));
    await cp(join(server, 'test/medium/fixtures/library-import-photoprism.mjs'), join(build, 'native-runner.mjs'));
    await cp(join(server, 'test/medium/fixtures/library-import-native-common.mjs'), join(build, 'native-common.mjs'));
    if (nativeSource)
      await cp(
        join(server, `test/medium/fixtures/library-import-native-${nativeSource}.mjs`),
        join(build, `native-${nativeSource}.mjs`),
      );
    const { version } = JSON.parse(await readFile(join(server, 'package.json'), 'utf8'));
    await writeFile(
      join(build, 'package.json'),
      JSON.stringify({
        name: 'src',
        version,
        type: 'module',
        exports: { './*': './src/*' },
        imports: { '#library-import-transfer/*': './resources/library-import/*.js' },
      }),
    );
    await symlink(join(server, 'node_modules'), join(build, 'node_modules'), 'dir');
    // Map only the native helper's production installation path into this isolated test package.
    const workerPath = join(build, 'resources/library-import/import-relocation.js');
    const worker = await readFile(workerPath, 'utf8');
    const fixed = '/usr/local/bin/frameleaf-import-rename';
    if (worker.split(fixed).length !== 2) throw new Error('Unexpected test helper installation bridge');
    await writeFile(
      workerPath,
      worker.replace(/(['"])\/usr\/local\/bin\/frameleaf-import-rename\1/, () =>
        JSON.stringify(join(build, 'resources/library-import/frameleaf-import-rename')),
      ),
    );
  }, 90_000);
  afterAll(async () => {
    if (build) await rm(build, { recursive: true, force: true });
    expect(cleanupFailures).toEqual([]);
  });

  const modes = [
    'activate',
    'rollback',
    'prepare-empty',
    'prepare-page',
    'prepare-abandon',
    ...(process.env.FRAMELEAF_PHOTOPRISM_APPLICATION_CONFIG ? ['native-source'] : []),
    ...(nativeSource ? [`native-${nativeSource}`] : []),
  ];
  it.each(modes)(
    'executes %s with journalled files and retained metadata',
    async (mode) => {
      let db: Kysely<DB> | undefined;
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'frameleaf-import-lifecycle-')));
      let child: ReturnType<typeof spawn> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let lock: Awaited<ReturnType<typeof open>> | undefined;
      try {
        db = await getKyselyDB();
        const {
          rows: [row],
        } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
        if (!/^frameleaf_[a-f0-9]{32}$/.test(row.name)) throw new Error('A fresh synthetic database is required');
        const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
        url.pathname = `/${row.name}`;
        const state = join(directory, 'state');
        await mkdir(state, { mode: 0o700 });
        lock = await open(join(state, 'execution.lock'), 'wx', 0o600);
        child = spawn(
          join(build, 'resources/library-import/frameleaf-import-rename'),
          [
            '--exec-locked',
            process.execPath,
            join(
              build,
              mode === 'native-source'
                ? 'native-runner.mjs'
                : mode.startsWith('native-')
                  ? `${mode}.mjs`
                  : 'runner.mjs',
            ),
          ],
          {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe', lock.fd],
            env: {
              ...process.env,
              DB_URL: url.href,
              FRAMELEAF_IMPORT_TEST_DIRECTORY: directory,
              FRAMELEAF_IMPORT_EXECUTION_LOCK_FD: '3',
              FRAMELEAF_INTEGRATION_MODE: mode,
            },
          },
        );
        let output = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        const completed = Promise.withResolvers<number | null>();
        child.once('error', completed.reject);
        child.once('close', completed.resolve);
        let timedOut = false;
        deadline = setTimeout(() => {
          timedOut = true;
          if (child?.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupFailures.push(error);
            }
          }
        }, 60_000);
        const [exitCode] = await Promise.all([completed.promise, lock.close()]);
        lock = undefined;
        expect(timedOut, output).toBe(false);
        expect(exitCode, output).toBe(0);
        const result = JSON.parse(
          output
            .trim()
            .split('\n')
            .findLast((line) => line.startsWith('{'))!,
        );
        expect(result).toMatchObject({
          synthetic: true,
          sourceQualified: false,
          productionCoordinator: true,
          commonCommand: true,
          sidecars: mode.startsWith('native-') ? 0 : 1,
          phase: mode === 'rollback' || mode === 'prepare-abandon' ? 'abandoned' : 'activated',
        });
        if (mode.startsWith('prepare-')) expect(result.interruptedPreparationRecovered).toBe(true);
        if (mode.startsWith('native-') && mode !== 'native-source')
          expect(result).toMatchObject({
            nativeSource: true,
            managerRun: true,
            writerBoundary: true,
            sourceRetained: true,
            metadataAndAlbumsVerified: true,
          });
        else if (mode === 'native-source')
          expect(result).toMatchObject({
            nativeSource: true,
            nativeScope: 'single-local-admin-copy',
            originalFiles: 2,
            managerRun: true,
            writerBoundary: true,
            sourceRetained: true,
            metadataAndAlbumsVerified: true,
          });
        else if (mode === 'prepare-abandon') expect(result.noMediaTransferred).toBe(true);
        else {
          expect(result.interruptedForwardCheckpointRecovered).toBe(true);
          if (mode === 'rollback')
            expect(result).toMatchObject({ originalFilesRestored: 3, interruptedReverseMoveRecovered: true });
          else
            expect(result).toMatchObject({
              originalFiles: 3,
              archiveRows: 1001,
              managerRun: true,
              writerBoundary: true,
              retainedReplayPreservesAccountEdits: true,
            });
        }
      } finally {
        clearTimeout(deadline);
        if (child?.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupFailures.push(error);
          }
        }
        const cleanup = await Promise.allSettled([
          lock?.close(),
          db?.destroy(),
          rm(directory, { recursive: true, force: true }),
        ]);
        for (const result of cleanup) if (result.status === 'rejected') cleanupFailures.push(result.reason);
      }
    },
    90_000,
  );
});
