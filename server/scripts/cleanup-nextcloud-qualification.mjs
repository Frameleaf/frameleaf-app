import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const qualificationFixture = JSON.parse(
  readFileSync(new URL('../src/library-import/fixtures/nextcloud/35-8-10.2-sqlite.json', import.meta.url), 'utf8'),
);
export const qualificationImage = qualificationFixture.runtime.image;
const docker = (arguments_) => {
  const result = spawnSync('docker', arguments_, { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`Qualification cleanup failed: ${arguments_[0]}`);
  return result.stdout.trim();
};
export const cleanupQualification = (runId, directory = tmpdir(), command = docker) => {
  if (!/^\d+-\d+$/u.test(runId ?? '') || path.basename(directory) !== `frameleaf-nextcloud-${runId}`)
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
    'label=app.frameleaf.qualification-family=nextcloud',
    '--filter',
    `label=app.frameleaf.qualification-run=${runId}`,
  ];
  attempt(() => {
    const containers = command(['ps', '-aq', ...filters])
      .split(/\s+/u)
      .filter(Boolean);
    if (containers.length > 0) command(['rm', '-f', '-v', ...containers]);
  });
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
  attempt(() => {
    const marker = path.join(directory, 'image.json');
    if (
      existsSync(marker) &&
      JSON.parse(readFileSync(marker, 'utf8')).createdImage === true &&
      command(['ps', '-aq', '--filter', `ancestor=${qualificationImage}`]) === '' &&
      command(['image', 'ls', '-q', qualificationImage]) !== ''
    )
      command(['image', 'rm', qualificationImage]);
  });
  attempt(() => rmSync(directory, { recursive: true, force: true }));
  if (failures.length > 0) throw new AggregateError(failures, 'Qualification cleanup failed');
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cleanupQualification(process.env.FRAMELEAF_NATIVE_IMPORT_RUN_ID);
