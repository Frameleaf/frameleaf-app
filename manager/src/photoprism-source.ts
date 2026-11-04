import { join, resolve } from 'node:path';
import { containerId, digest, Refusal, type SourceFence } from './contracts.js';
import { sourceFingerprint } from './discovery.js';
import { type Fencing } from './fencing.js';
import { captureFencedSqliteSource } from './source-capture.js';
import { environment, type Container } from './docker.js';

const qualifiedImage = 'photoprism/photoprism@sha256:9409cf8e5a6ebcbe3170d14537556cbc20997aaa307096d6eeedbfc5eeef6719';
const qualifiedVersion = '261029-963b58c50';
const qualifiedSchema = '507395a491d2db109d8f661764cf8f6ecd2e6222bd5e7f633cbeafc96817ca34';
const storageTarget = '/photoprism/storage';
const originalsTarget = '/photoprism/originals';

/** Identify the pinned SQLite deployment. The stopped snapshot still requires schema and privacy qualification. */
export function identifyPhotoprismSqliteSource(container: Container, platform: SourceFence['platform']) {
  if (container.Config.Image !== qualifiedImage) return null;
  const env = environment(container);
  if (
    !containerId.safeParse(container.Id).success ||
    env.PHOTOPRISM_DATABASE_DRIVER !== 'sqlite' ||
    env.PHOTOPRISM_DATABASE_DSN !== `${storageTarget}/index.db` ||
    (env.PHOTOPRISM_STORAGE_PATH ?? storageTarget) !== storageTarget ||
    (env.PHOTOPRISM_ORIGINALS_PATH ?? originalsTarget) !== originalsTarget
  )
    throw new Refusal('photoprism_source_configuration_unqualified');
  const mounts = [storageTarget, originalsTarget].map((target) => {
    const matches = container.Mounts.filter((mount) => mount.Destination === target);
    const mount = matches[0];
    if (
      matches.length !== 1 ||
      mount.Type !== 'bind' ||
      mount.Source === '/' ||
      resolve(mount.Source) !== mount.Source ||
      /[\x00-\x1f,]/u.test(mount.Source) ||
      container.Mounts.some((other) => other.Destination.startsWith(target + '/'))
    )
      throw new Refusal('photoprism_source_mount_unqualified');
    return { type: 'bind' as const, source: mount.Source, target, readOnly: !mount.RW };
  });
  const [storage, originals] = mounts;
  if (
    storage.source === originals.source ||
    storage.source.startsWith(originals.source + '/') ||
    originals.source.startsWith(storage.source + '/')
  )
    throw new Refusal('photoprism_source_mount_unqualified');
  const fence: SourceFence = {
    id: digest(['photoprism', container.Id]),
    containers: [container.Id],
    workers: [container.Id],
    mounts,
    platform,
    restart: { [container.Id]: container.HostConfig.RestartPolicy },
    fingerprint: sourceFingerprint([container]),
  };
  return { fence, databasePath: join(storage.source, 'index.db'), originalsPath: originals.source };
}

/** The caller owns the operation lock and the recovery intent before capture can stop the source. */
export async function capturePhotoprismSqliteSource(
  fencing: Fencing,
  container: Container,
  platform: SourceFence['platform'],
  stagingRoot: string,
) {
  const discovered = identifyPhotoprismSqliteSource(container, platform);
  if (!discovered) throw new Refusal('photoprism_source_configuration_unqualified');
  const snapshot = await captureFencedSqliteSource(fencing, discovered.fence, {
    databasePath: discovered.databasePath,
    stagingRoot,
    expectedSchemaSha256: qualifiedSchema,
  });
  return {
    fence: discovered.fence,
    originalsPath: discovered.originalsPath,
    snapshotPath: snapshot.path,
    source: {
      kind: 'photoprism' as const,
      version: qualifiedVersion,
      identity: container.Id,
      revision: snapshot.sha256,
      schemaSha256: snapshot.schemaSha256,
    },
  };
}
