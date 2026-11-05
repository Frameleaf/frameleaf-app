import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const qualificationImage = JSON.parse(
  readFileSync(new URL('../src/library-import/fixtures/pigallery2/3.5.2-sqlite.json', import.meta.url), 'utf8'),
).runtime.image;
export const hasQualificationImage = (command) => {
  const digest = qualificationImage.split('@', 2)[1];
  return command(['image', 'ls', '--all', '--digests', '--format', '{{.Digest}}']).split(/\s+/u).includes(digest);
};
const docker = (parameters) => {
  const result = spawnSync('docker', parameters, { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error('PiGallery2 qualification cleanup failed');
  return result.stdout.trim();
};

// Remove only this run's labelled application, its anonymous volumes, a pulled image and the run directory.
export function cleanupQualification(runId, directory = tmpdir(), command = docker) {
  if (!/^\d+-\d+$/u.test(runId ?? '') || path.basename(directory) !== `frameleaf-pigallery2-${runId}`)
    throw new Error('Invalid qualification cleanup scope');
  const failures = [];
  const attempt = (action) => {
    try {
      action();
    } catch (error) {
      failures.push(error);
    }
  };
  const filters = [
    '--filter',
    'label=app.frameleaf.qualification-family=pigallery2',
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
      hasQualificationImage(command)
    )
      command(['image', 'rm', qualificationImage]);
  });
  attempt(() => rmSync(directory, { recursive: true, force: true }));
  if (failures.length > 0) throw new AggregateError(failures, 'PiGallery2 qualification cleanup failed');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cleanupQualification(process.env.FRAMELEAF_NATIVE_IMPORT_RUN_ID);
