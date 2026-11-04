import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const qualificationImage = 'mariadb@sha256:49117dcc565cf51aa57ac5fca59ab31213402ff0eae6ffc13c46a37b938f7e4b';
export const applicationQualificationImage = JSON.parse(
  readFileSync(new URL('../src/library-import/fixtures/photoprism/261029-sqlite.json', import.meta.url), 'utf8'),
).source.runtimeImage;
const docker = (args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`Qualification cleanup failed: ${args[0]}`);
  return result.stdout.trim();
};
export const cleanupQualification = (runId, directory = tmpdir(), command = docker) => {
  if (!/^\d+-\d+$/u.test(runId ?? '') || basename(directory) !== `frameleaf-photoprism-${runId}`)
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
    'label=app.frameleaf.qualification-family=photoprism',
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
    const volumes = command(['volume', 'ls', '-q', ...filters])
      .split(/\s+/u)
      .filter(Boolean);
    if (volumes.length) command(['volume', 'rm', ...volumes]);
  });
  for (const [name, image] of [
    ['image.json', qualificationImage],
    ['application-image.json', applicationQualificationImage],
  ]) {
    attempt(() => {
      const marker = join(directory, name);
      if (
        existsSync(marker) &&
        JSON.parse(readFileSync(marker, 'utf8')).createdImage === true &&
        command(['ps', '-aq', '--filter', `ancestor=${image}`]) === '' &&
        command(['image', 'ls', '-q', image]) !== ''
      )
        command(['image', 'rm', image]);
    });
  }
  attempt(() => rmSync(directory, { recursive: true, force: true }));
  if (failures.length) throw new AggregateError(failures, 'Qualification cleanup failed');
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cleanupQualification(process.env.FRAMELEAF_PHOTOPRISM_RUN_ID);
