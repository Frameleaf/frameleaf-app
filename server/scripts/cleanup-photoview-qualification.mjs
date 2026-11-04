import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const qualificationImage = JSON.parse(
  readFileSync(new URL('../src/library-import/fixtures/photoview/2.4.0-sqlite.json', import.meta.url), 'utf8'),
).source.image;
export const hasQualificationImage = (command) => {
  const digest = qualificationImage.split('@')[1];
  return command(['image', 'ls', '--all', '--digests', '--format', '{{.Digest}}']).split(/\s+/u).includes(digest);
};
const docker = (args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error('Photoview qualification cleanup failed');
  return result.stdout.trim();
};
export function cleanupQualification(runId, directory = tmpdir(), command = docker) {
  if (!/^\d+-\d+$/u.test(runId ?? '') || basename(directory) !== `frameleaf-photoview-${runId}`)
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
    'label=app.frameleaf.qualification-family=photoview',
    '--filter',
    `label=app.frameleaf.qualification-run=${runId}`,
  ];
  attempt(() => {
    const containers = command(['ps', '-aq', ...filters])
      .split(/\s+/u)
      .filter(Boolean);
    if (containers.length) command(['rm', '-f', '-v', ...containers]);
  });
  attempt(() => {
    const marker = join(directory, 'image.json');
    if (
      existsSync(marker) &&
      JSON.parse(readFileSync(marker, 'utf8')).createdImage === true &&
      command(['ps', '-aq', '--filter', `ancestor=${qualificationImage}`]) === '' &&
      hasQualificationImage(command)
    )
      command(['image', 'rm', qualificationImage]);
  });
  attempt(() => rmSync(directory, { recursive: true, force: true }));
  if (failures.length) throw new AggregateError(failures, 'Photoview qualification cleanup failed');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cleanupQualification(process.env.FRAMELEAF_PHOTOVIEW_RUN_ID);
