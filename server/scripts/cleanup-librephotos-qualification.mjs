import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = JSON.parse(
  readFileSync(new URL('../src/library-import/fixtures/librephotos/1.5.1-postgres18.json', import.meta.url), 'utf8'),
);
// The official PostgreSQL deployment: the unified application image and its pinned database engine.
export const appImage = fixture.source.image;
export const databaseImage = fixture.source.database.image;
export const qualificationImages = { application: appImage, database: databaseImage };
export const hasImage = (command, image) => {
  try {
    command(['image', 'inspect', '--format', '{{.Id}}', image]);
    return true;
  } catch {
    return false;
  }
};
const docker = (arguments_) => {
  const result = spawnSync('docker', arguments_, { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`LibrePhotos qualification cleanup failed: ${arguments_[0]}`);
  return result.stdout.trim();
};
export function cleanupQualification(runId, directory = tmpdir(), command = docker) {
  if (!/^\d+-\d+$/u.test(runId ?? '') || path.basename(directory) !== `frameleaf-librephotos-${runId}`)
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
    'label=app.frameleaf.qualification-family=librephotos',
    '--filter',
    `label=app.frameleaf.qualification-run=${runId}`,
  ];
  const list = (arguments_) => command(arguments_).split(/\s+/u).filter(Boolean);
  attempt(() => {
    const containers = list(['ps', '-aq', ...filters]);
    if (containers.length > 0) command(['rm', '-f', '-v', ...containers]);
  });
  attempt(() => {
    const volumes = list(['volume', 'ls', '-q', ...filters]);
    if (volumes.length > 0) command(['volume', 'rm', ...volumes]);
  });
  attempt(() => {
    const networks = list(['network', 'ls', '-q', ...filters]);
    if (networks.length > 0) command(['network', 'rm', ...networks]);
  });
  attempt(() => {
    const marker = path.join(directory, 'application-image.json');
    if (!existsSync(marker)) return;
    const created = JSON.parse(readFileSync(marker, 'utf8'));
    for (const [role, image] of Object.entries(qualificationImages))
      attempt(() => {
        if (
          created[role] === true &&
          command(['ps', '-aq', '--filter', `ancestor=${image}`]) === '' &&
          hasImage(command, image)
        )
          command(['image', 'rm', image]);
      });
  });
  attempt(() => rmSync(directory, { recursive: true, force: true }));
  if (failures.length > 0) throw new AggregateError(failures, 'LibrePhotos qualification cleanup failed');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cleanupQualification(process.env.FRAMELEAF_NATIVE_IMPORT_RUN_ID);
