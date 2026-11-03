import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const image = 'mariadb@sha256:49117dcc565cf51aa57ac5fca59ab31213402ff0eae6ffc13c46a37b938f7e4b';
const id = randomBytes(4).toString('hex');
const container = `frameleaf-photoprism-test-${id}`;
const volume = `${container}-data`;
const database = `frameleaf_photoprism_test_${id}`;
const directory = mkdtempSync(join(tmpdir(), 'frameleaf-photoprism-'));
const password = randomBytes(32).toString('hex');
const failures = [];
const command = (args, options = {}) => spawnSync('docker', args, { cwd: root, encoding: 'utf8', ...options });
const run = (args) => {
  const result = command(args);
  if (result.status !== 0) throw new Error(`Fixture Docker operation failed: ${args[0]}`);
  return result.stdout.trim();
};
const hadImage = command(['image', 'inspect', image], { stdio: 'ignore' }).status === 0;
try {
  writeFileSync(join(directory, 'database.env'), `MARIADB_ROOT_PASSWORD=${password}\nMARIADB_DATABASE=${database}\n`, {
    mode: 0o600,
  });
  writeFileSync(join(directory, 'client.cnf'), `[client]\nuser=root\npassword=${password}\n`, { mode: 0o600 });
  run(['volume', 'create', '--label', 'app.frameleaf.test=photoprism-mariadb', volume]);
  run([
    'run',
    '-d',
    '--name',
    container,
    '--label',
    'app.frameleaf.test=photoprism-mariadb',
    '--env-file',
    join(directory, 'database.env'),
    '-p',
    '127.0.0.1::3306',
    '--mount',
    `type=volume,source=${volume},target=/var/lib/mysql`,
    '--mount',
    `type=bind,source=${join(directory, 'client.cnf')},target=/run/secrets/client.cnf,readonly`,
    image,
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    if (
      command(
        [
          'exec',
          container,
          'mariadb',
          '--defaults-extra-file=/run/secrets/client.cnf',
          '--protocol=tcp',
          '-h127.0.0.1',
          '-N',
          '-e',
          'SELECT 1',
        ],
        {
          stdio: 'ignore',
        },
      ).status === 0
    ) {
      ready = true;
      break;
    }
    if (run(['inspect', '--format', '{{.State.Running}}', container]) !== 'true')
      throw new Error('Fixture database stopped during initialization');
    await setTimeout(1000);
  }
  if (!ready) throw new Error('Fixture database initialization timed out');
  const port = Number(run(['port', container, '3306']).match(/^127\.0\.0\.1:(\d+)$/u)?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid fixture loopback port');
  const config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port, user: 'root', password, database }), { mode: 0o600 });
  const tests = spawnSync(
    'pnpm',
    [
      '--dir',
      'server',
      'exec',
      'vitest',
      'run',
      '--config',
      'test/vitest.config.mjs',
      'src/library-import/photoprism-mariadb-source.spec.ts',
      '--maxWorkers=1',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, FRAMELEAF_PHOTOPRISM_TEST_CONFIG: config },
    },
  );
  if (tests.status !== 0) throw new Error('Native PhotoPrism MariaDB qualification failed');
} catch (error) {
  failures.push(error);
} finally {
  for (const args of [
    ['rm', '-f', container],
    ['volume', 'rm', volume],
  ]) {
    let exists;
    try {
      const names =
        args[0] === 'rm'
          ? run(['ps', '-aq', '--filter', `name=^/${container}$`])
          : run(['volume', 'ls', '-q', '--filter', `name=^${volume}$`]);
      exists = names !== '';
    } catch (error) {
      failures.push(error);
      continue;
    }
    if (exists) {
      try {
        run(args);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (!hadImage && command(['image', 'inspect', image], { stdio: 'ignore' }).status === 0) {
    try {
      if (run(['ps', '-a', '--filter', `ancestor=${image}`, '--format', '{{.ID}}']) === '') run(['image', 'rm', image]);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
}
if (failures.length > 0) throw new AggregateError(failures, 'Native qualification or fixture cleanup failed');
console.log('Native PhotoPrism MariaDB qualification passed; disposable fixture removed.');
