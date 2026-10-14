import assert from 'node:assert/strict';
import childProcess, { execFile } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ImmichAdminModule } from '../../dist/app.module.js';
import { DatabaseBackupService } from '../../dist/services/database-backup.service.js';

const { CommandFactory } = createRequire(import.meta.url)('nest-commander');

test('admin CLI database restore checks replacement API health and rejects failed startup', async (t) => {
  const app = await CommandFactory.createWithoutRunning(ImmichAdminModule, {
    logger: ['error', 'warn'],
    abortOnError: false,
  });
  try {
    const health = app.get(DatabaseBackupService).maintenanceHealthRepository;
    let isHealthy = true;
    // Only the child API process is simulated; the CLI graph and injected health gate are real.
    t.mock.method(childProcess, 'fork', () => {
      const worker = new childProcess.ChildProcess();
      worker.stdout = new PassThrough();
      worker.kill = () => {
        worker.exitCode = 0;
        worker.emit('exit', 0);
      };
      queueMicrotask(() => {
        if (isHealthy) {
          worker.stdout.write('Frameleaf Server is listening on http://127.0.0.1:33001');
        } else {
          worker.exitCode = 1;
          worker.emit('exit', 1);
        }
      });
      return worker;
    });
    syncBuiltinESMExports();
    t.mock.timers.enable({ apis: ['setTimeout'] });

    await health.checkApiHealth();
    isHealthy = false;
    await assert.rejects(health.checkApiHealth(), /Server health check failed, server exited with 1/);
  } finally {
    t.mock.reset();
    syncBuiltinESMExports();
    await app.close();
  }
});

// Opt-in destructive recovery integration: the kit, database and media must be disposable fixtures.
test(
  'quiet admin entrypoint restores an offline database through the real API health child',
  { skip: !process.env.FRAMELEAF_TEST_OFFLINE_KIT, timeout: 240_000 },
  async () => {
    const kit = process.env.FRAMELEAF_TEST_OFFLINE_KIT;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL('../../dist/main.js', import.meta.url)),
        'frameleaf-admin',
        'cloud-backup',
        'restore',
        '--offline-directory',
        kit,
        '--key-file',
        `${kit}/key-file.json`,
        '--scope',
        'library',
        '--restore-database',
      ],
      { timeout: 230_000 },
    );

    assert.match(stdout, /The database was restored\. Start the server/);
  },
);
