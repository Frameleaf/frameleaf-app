import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reclaimQualificationDirectory } from './qualification-directory.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('../src/library-import/fixtures/piwigo/16.4.0-mariadb.json', import.meta.url), 'utf8'),
);
export const baseImage = fixture.runtime.phpBaseImage;
export const databaseImage = fixture.runtime.databaseImage;
/** The disposable PHP image this run builds from the pinned base; it is always removed with the run. */
export const builtImage = (runId) => `frameleaf-piwigo-qualification:${runId}`;
export const hasImage = (command, image) => {
  try {
    return command(['image', 'inspect', '--format', '{{.Id}}', image]) !== '';
  } catch {
    return false;
  }
};
const docker = (args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`Piwigo qualification cleanup failed: ${args[0]}`);
  return result.stdout.trim();
};
export const cleanupQualification = (runId, directory = tmpdir(), command = docker) => {
  if (!/^\d+-\d+$/u.test(runId ?? '') || basename(directory) !== `frameleaf-piwigo-${runId}`)
    throw new Error('Invalid qualification cleanup scope');
  const failures = [];
  const attempt = (operation) => {
    try {
      operation();
    } catch (error) {
      failures.push(error);
    }
  };
  const filters = [
    '--filter',
    'label=app.frameleaf.qualification-family=piwigo',
    '--filter',
    `label=app.frameleaf.qualification-run=${runId}`,
  ];
  attempt(() => {
    const containers = command(['ps', '-aq', ...filters])
      .split(/\s+/u)
      .filter(Boolean);
    if (containers.length > 0) command(['rm', '-f', '-v', ...containers]);
  });
  // Containers are gone; their images remain, so app-owned files can still be handed back to the runner.
  attempt(() => reclaimQualificationDirectory(directory, [builtImage(runId), baseImage, databaseImage]));
  attempt(() => {
    const volumes = command(['volume', 'ls', '-q', ...filters])
      .split(/\s+/u)
      .filter(Boolean);
    if (volumes.length > 0) command(['volume', 'rm', ...volumes]);
  });
  attempt(() => {
    const networks = command(['network', 'ls', '-q', ...filters])
      .split(/\s+/u)
      .filter(Boolean);
    if (networks.length > 0) command(['network', 'rm', ...networks]);
  });
  // The run-scoped build is always ours; pinned base and database images only when this run pulled them.
  attempt(() => {
    const image = builtImage(runId);
    if (hasImage(command, image) && command(['ps', '-aq', '--filter', `ancestor=${image}`]) === '')
      command(['image', 'rm', image]);
  });
  for (const [name, image] of [
    ['base-image.json', baseImage],
    ['database-image.json', databaseImage],
  ]) {
    attempt(() => {
      const marker = join(directory, name);
      if (
        existsSync(marker) &&
        JSON.parse(readFileSync(marker, 'utf8')).createdImage === true &&
        command(['ps', '-aq', '--filter', `ancestor=${image}`]) === '' &&
        hasImage(command, image)
      )
        command(['image', 'rm', image]);
    });
  }
  attempt(() => rmSync(directory, { recursive: true, force: true }));
  if (failures.length > 0) throw new AggregateError(failures, 'Piwigo qualification cleanup failed');
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cleanupQualification(process.env.FRAMELEAF_NATIVE_IMPORT_RUN_ID);
