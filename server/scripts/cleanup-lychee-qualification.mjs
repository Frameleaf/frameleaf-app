import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const qualificationImage = JSON.parse(
  readFileSync(new URL('../src/library-import/fixtures/lychee/7.12.0-sqlite.json', import.meta.url), 'utf8'),
).runtime.image;
export const hasQualificationImage = (command) => {
  const digest = qualificationImage.split('@', 2)[1];
  return command(['image', 'ls', '--all', '--digests', '--format', '{{.Digest}}']).split(/\s+/u).includes(digest);
};
const docker = (arguments_) => {
  const result = spawnSync('docker', arguments_, { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`Lychee qualification cleanup failed: ${arguments_[0]}`);
  return result.stdout.trim();
};
// Remove only this run's labelled Docker objects, the image when this run pulled it, and the run directory.
export function cleanupQualification(runId, directory = tmpdir(), command = docker) {
  if (!/^\d+-\d+$/u.test(runId ?? '') || path.basename(directory) !== `frameleaf-lychee-${runId}`)
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
    'label=app.frameleaf.qualification-family=lychee',
    '--filter',
    `label=app.frameleaf.qualification-run=${runId}`,
  ];
  attempt(() => {
    const containers = command(['ps', '-aq', ...filters])
      .split(/\s+/u)
      .filter(Boolean);
    if (containers.length > 0) command(['rm', '-f', '-v', ...containers]);
  });
  for (const kind of ['volume', 'network'])
    attempt(() => {
      const owned = command([kind, 'ls', '-q', ...filters])
        .split(/\s+/u)
        .filter(Boolean);
      if (owned.length > 0) command([kind, 'rm', ...owned]);
    });
  attempt(() => {
    const marker = path.join(directory, 'application-image.json');
    if (
      existsSync(marker) &&
      JSON.parse(readFileSync(marker, 'utf8')).createdImage === true &&
      command(['ps', '-aq', '--filter', `ancestor=${qualificationImage}`]) === '' &&
      hasQualificationImage(command)
    )
      command(['image', 'rm', qualificationImage]);
  });
  attempt(() => rmSync(directory, { recursive: true, force: true }));
  if (failures.length > 0) throw new AggregateError(failures, 'Lychee qualification cleanup failed');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cleanupQualification(process.env.FRAMELEAF_NATIVE_IMPORT_RUN_ID);
