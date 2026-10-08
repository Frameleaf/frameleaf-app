import { ConflictException } from '@nestjs/common';
import AsyncLock from 'async-lock';
import { load as loadYaml } from 'js-yaml';
import { cloneDeep, get, isEmpty, isEqual, set } from 'lodash-es';
import { createHash } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { DB } from 'src/schema/index.js';
import type { DeepPartial } from 'src/types.js';
import { AdminConfigDto, SystemConfig, defaults, mapAdminConfig } from 'src/dtos/config.dto.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { lockEffectiveConfig } from 'src/utils/effective-config-lock.js';
import { getKeysDeep, unsetDeep } from 'src/utils/misc.js';
import { canonicalJson } from 'src/utils/object.js';

export type RepoDeps = {
  configRepo: ConfigRepository;
  metadataRepo: SystemMetadataRepository;
  logger: LoggingRepository;
};

const asyncLock = new AsyncLock();
type Epoch = import('src/types.js').SystemMetadata[SystemMetadataKey.EffectiveConfigEpoch];
const fileSnapshots = new WeakMap<ConfigRepository, { epoch: number; digest: string; config: SystemConfig }>();
let config: SystemConfig | null = null;
let lastUpdated: number | null = null;

export const clearConfigCache = () => {
  config = null;
  lastUpdated = null;
};

export const getConfig = async (repos: RepoDeps, { withCache }: { withCache: boolean }): Promise<SystemConfig> => {
  // A missed ConfigUpdate must not keep a previous activated file epoch authoritative.
  if (repos.configRepo.getEnv().configFile) return readConfig(repos);
  if (!withCache || !config) {
    const timestamp = lastUpdated;
    await asyncLock.acquire(DatabaseLock[DatabaseLock.GetSystemConfig], async () => {
      if (timestamp !== lastUpdated) {
        return;
      }

      config = await readConfig(repos);
      lastUpdated = Date.now();
    });
  }

  return config!;
};

/**
 * FL-66: the saved configuration read straight from storage, never from the cache. A cached read
 * can hand back a configuration built before another save committed, which must not be what a
 * revision check or a read-modify-write under the settings lock starts from.
 */
export const readConfig = async (repos: RepoDeps): Promise<SystemConfig> => {
  if (!repos.configRepo.getEnv().configFile) {
    const epoch = await repos.metadataRepo.getEffectiveConfigEpoch();
    if (epoch && epoch.sourceKind !== 'database') throw new ConflictException('effective_config_source_changed');
    return buildConfig(repos);
  }
  let epoch = await repos.metadataRepo.getEffectiveConfigEpoch();
  if (!epoch) {
    const candidate = await prepareFileConfig(repos);
    epoch = await repos.metadataRepo.withConfigTransaction(async (metadata) => {
      const current = await metadata.getEffectiveConfigEpoch();
      if (current) return current;
      const first = epochFor(candidate, 'file', 1);
      await metadata.set(SystemMetadataKey.EffectiveConfigEpoch, first);
      return first;
    });
    if (epoch.digest === configDigest(candidate) && epoch.sourceKind === 'file') {
      fileSnapshots.set(repos.configRepo, { epoch: epoch.epoch, digest: epoch.digest, config: candidate });
    }
  }
  assertEpoch(epoch);
  if (epoch.sourceKind !== 'file') throw new ConflictException('effective_config_source_changed');
  const cached = fileSnapshots.get(repos.configRepo);
  if (cached?.epoch === epoch.epoch && cached.digest === epoch.digest) return cloneDeep(cached.config);
  const candidate = await prepareFileConfig(repos);
  if (configDigest(candidate) !== epoch.digest) throw new ConflictException('effective_config_activation_required');
  fileSnapshots.set(repos.configRepo, { epoch: epoch.epoch, digest: epoch.digest, config: candidate });
  return cloneDeep(candidate);
};

const configDigest = (value: SystemConfig) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const epochFor = (value: SystemConfig, sourceKind: Epoch['sourceKind'], epoch: number): Epoch => ({
  format: 1,
  epoch,
  sourceKind,
  digest: configDigest(value),
  trashEnabled: value.trash.enabled,
});

/** Bootstrap publishes an absent database epoch without changing any settings. */
export async function initializeEffectiveConfig(repos: RepoDeps): Promise<void> {
  if (repos.configRepo.getEnv().configFile) {
    await readConfig(repos);
    return;
  }
  await withEffectiveConfigWrite(repos, async (bound) => {
    const candidate = await buildConfig(bound, true);
    const current = await bound.metadataRepo.getEffectiveConfigEpoch();
    if (current) {
      assertEpoch(current);
      if (current.sourceKind !== 'database' || current.digest !== configDigest(candidate))
        throw new ConflictException('effective_config_source_changed');
      return;
    }
    await bound.metadataRepo.set(SystemMetadataKey.EffectiveConfigEpoch, epochFor(candidate, 'database', 1));
  });
}

function assertEpoch(epoch: Epoch) {
  if (
    epoch.format !== 1 ||
    !Number.isSafeInteger(epoch.epoch) ||
    epoch.epoch < 1 ||
    !['database', 'file'].includes(epoch.sourceKind) ||
    !/^[a-f0-9]{64}$/.test(epoch.digest) ||
    typeof epoch.trashEnabled !== 'boolean'
  )
    throw new ConflictException('effective_config_unavailable');
}

function freezeConfigSnapshot<T extends object>(value: T): Readonly<T> {
  for (const entry of Object.values(value)) if (entry && typeof entry === 'object') freezeConfigSnapshot(entry);
  return Object.freeze(value);
}

/** Caller must acquire this before item/resource locks and retain this TX through policy commit. */
export async function withEffectiveConfigRead<T>(
  repos: RepoDeps,
  tx: Transaction<DB>,
  callback: (snapshot: Readonly<SystemConfig>, epoch: Readonly<Epoch>) => Promise<T>,
): Promise<T> {
  await lockEffectiveConfig(tx, 'read');
  const bound = { ...repos, metadataRepo: new SystemMetadataRepository(tx) };
  const epoch = await bound.metadataRepo.getEffectiveConfigEpoch();
  if (!epoch) throw new ConflictException('effective_config_unavailable');
  assertEpoch(epoch);
  const snapshot = epoch.sourceKind === 'file' ? await readConfig(bound) : await buildConfig(bound, true);
  const sourceKind = repos.configRepo.getEnv().configFile ? 'file' : 'database';
  if (
    sourceKind !== epoch.sourceKind ||
    configDigest(snapshot) !== epoch.digest ||
    snapshot.trash.enabled !== epoch.trashEnabled
  )
    throw new ConflictException('effective_config_source_changed');
  return callback(freezeConfigSnapshot(cloneDeep(snapshot)), Object.freeze({ ...epoch }));
}

/** Strict candidate preparation never activates changed file input. Errors do not reveal file/parser details. */
export const prepareFileConfig = async (repos: RepoDeps): Promise<SystemConfig> => {
  if (!repos.configRepo.getEnv().configFile) throw new ConflictException('effective_config_file_required');
  try {
    const candidate = await buildConfig(repos, true);
    const result = AdminConfigDto.schema.safeParse(candidate);
    if (!result.success) throw new Error('invalid');
    return cloneDeep(result.data) as SystemConfig;
  } catch {
    throw new ConflictException('effective_config_candidate_invalid');
  }
};

/** Caller holds the legacy outer serialization; all durable reads/mutations use the supplied metadata. */
export async function withEffectiveConfigWrite<T>(
  repos: RepoDeps,
  callback: (repos: RepoDeps, tx: import('kysely').Transaction<import('src/schema/index.js').DB>) => Promise<T>,
): Promise<T> {
  const result = await repos.metadataRepo.withConfigTransaction((metadataRepo, tx) =>
    callback({ ...repos, metadataRepo }, tx),
  );
  clearConfigCache();
  return result;
}

/** Called inside withEffectiveConfigWrite; cache publication happens only after its transaction commits. */
export async function activateFileConfig(
  repos: RepoDeps,
  candidate: SystemConfig,
  expectedEpoch: number,
): Promise<Epoch> {
  const current = await repos.metadataRepo.getEffectiveConfigEpoch();
  if (!current || current.format !== 1 || current.sourceKind !== 'file' || current.epoch !== expectedEpoch)
    throw new ConflictException('effective_config_epoch_changed');
  const next = epochFor(candidate, 'file', current.epoch + 1);
  if (!Number.isSafeInteger(next.epoch)) throw new ConflictException('effective_config_epoch_exhausted');
  await repos.metadataRepo.set(SystemMetadataKey.EffectiveConfigEpoch, next);
  return next;
}

/** Maintenance recovery only: caller holds its verified recovery lease and this write TX.
 * Its already-published validated recovery files and restored DB settings establish a new epoch.
 */
export async function recoverEffectiveConfig(repos: RepoDeps): Promise<{ config: SystemConfig; epoch: Epoch }> {
  const candidate = repos.configRepo.getEnv().configFile
    ? await prepareFileConfig(repos)
    : await buildConfig(repos, true);
  const current = await repos.metadataRepo.getEffectiveConfigEpoch();
  const sourceKind = repos.configRepo.getEnv().configFile ? 'file' : 'database';
  const same = current?.sourceKind === sourceKind && current.digest === configDigest(candidate);
  const epoch = epochFor(candidate, sourceKind, same ? current.epoch : (current?.epoch ?? 0) + 1);
  assertEpoch(epoch);
  await repos.metadataRepo.set(SystemMetadataKey.EffectiveConfigEpoch, epoch);
  return { config: candidate, epoch };
}

/** Publish the already committed private candidate; never reread mutable file bytes as activation. */
export function publishFileConfig(repos: RepoDeps, candidate: SystemConfig, epoch: Epoch) {
  fileSnapshots.set(repos.configRepo, { epoch: epoch.epoch, digest: epoch.digest, config: cloneDeep(candidate) });
  clearConfigCache();
}

/**
 * FL-66: values the server writes on its own (bookkeeping for the image description re-queue
 * reminder). Every update keeps the stored values whatever a client sends, so they are left out
 * of the revision: deferring a re-queue must not make another administrator's draft stale.
 */
export const SERVER_MANAGED_CONFIG_PATHS = [
  'machineLearning.imageDescription.pendingRequeueAt',
  'machineLearning.imageDescription.lastConfigChangeAt',
] as const;

export const SYSTEM_CONFIG_CHANGED_MESSAGE =
  'The system settings changed after they were loaded. Load the latest settings and try again.';

/**
 * FL-66: a digest of the effective system configuration (stored values merged over the
 * defaults, including the fork's configuration sidecar), reported to the settings editor as
 * `revision`. It changes whenever a saved value changes, so a save made against settings that
 * another administrator (or a server action) changed since they
 * were loaded can be refused instead of silently overwriting them. The revision is never
 * stored, so no schema change is needed.
 *
 * It digests exactly what an administrator can read (`mapAdminConfig`): write-only credentials
 * (FL-67: the SMTP password and the OAuth client secret)
 * only count through their "configured" flags, so the revision can never be used to test guesses
 * of a secret the API does not show. A credential replaced by another value therefore leaves the
 * revision unchanged; saves resolve "keep the stored credential" again under the settings lock
 * (SystemConfigService.saveAdminConfig) so such a replacement is never overwritten.
 */
export const getConfigRevision = (config: SystemConfig): string => {
  const comparable = cloneDeep(mapAdminConfig(config)) as unknown as Record<string, unknown>;
  for (const path of SERVER_MANAGED_CONFIG_PATHS) {
    set(comparable, path, undefined);
  }

  return createHash('sha256').update(canonicalJson(comparable)).digest('hex').slice(0, 32);
};

export const updateConfig = async (repos: RepoDeps, newConfig: SystemConfig): Promise<SystemConfig> => {
  const { metadataRepo } = repos;
  if (repos.configRepo.getEnv().configFile) throw new ConflictException('effective_config_file_managed');
  // get the difference between the new config and the default config
  const partialConfig: DeepPartial<SystemConfig> = {};
  for (const property of getKeysDeep(defaults)) {
    const newValue = get(newConfig, property);
    const isEmpty = [undefined, null, ''].includes(newValue);
    const defaultValue = get(defaults, property);
    const equal = newValue === defaultValue || isEqual(newValue, defaultValue);

    if (isEmpty || equal) {
      continue;
    }

    set(partialConfig, property, newValue);
  }

  await metadataRepo.set(SystemMetadataKey.SystemConfig, partialConfig);

  const saved = await buildConfig(repos, true);
  const parsed = AdminConfigDto.schema.safeParse(saved);
  if (!parsed.success) throw new ConflictException('effective_config_candidate_invalid');
  const current = await metadataRepo.getEffectiveConfigEpoch();
  if (current && current.sourceKind !== 'database') throw new ConflictException('effective_config_source_changed');
  const next = epochFor(
    saved,
    'database',
    current?.sourceKind === 'database' && current.digest === configDigest(saved)
      ? current.epoch
      : (current?.epoch ?? 0) + 1,
  );
  if (!Number.isSafeInteger(next.epoch)) throw new ConflictException('effective_config_epoch_exhausted');
  await metadataRepo.set(SystemMetadataKey.EffectiveConfigEpoch, next);
  return saved;
};

const loadFromFile = async ({ metadataRepo, logger }: RepoDeps, filepath: string, privateErrors = false) => {
  try {
    const file = await metadataRepo.readFile(filepath);
    return loadYaml(file) as unknown;
  } catch (error: Error | any) {
    // Parser causes may contain private file contents and paths; do not expose them.
    // eslint-disable-next-line preserve-caught-error
    if (privateErrors) throw new Error('effective_config_candidate_invalid');
    logger.error(`Unable to load configuration file: ${filepath}`);
    logger.error(error);
    throw error;
  }
};

/**
 * Settings Frameleaf no longer has. They are dropped quietly from saved settings and config files, which
 * keep loading: master-user physical deduplication (`physicalDeduplication.enabled`/`masterUserId`) is
 * replaced by universal storage, which is always on.
 */
const RETIRED_CONFIG_KEYS = ['physicalDeduplication'];

const buildConfig = async (repos: RepoDeps, privateErrors = false) => {
  const { configRepo, metadataRepo, logger } = repos;
  const { configFile } = configRepo.getEnv();

  // load partial
  const partial = configFile
    ? await loadFromFile(repos, configFile, privateErrors)
    : await metadataRepo.get(SystemMetadataKey.SystemConfig);

  if (partial && typeof partial === 'object') {
    for (const key of RETIRED_CONFIG_KEYS) {
      delete (partial as Record<string, unknown>)[key];
    }
  }

  // merge with defaults
  const rawConfig = cloneDeep(defaults);
  for (const property of getKeysDeep(partial)) {
    set(rawConfig, property, get(partial, property));
  }

  // check for extra properties
  const unknownKeys = cloneDeep(rawConfig);
  for (const property of getKeysDeep(defaults)) {
    unsetDeep(unknownKeys, property);
  }

  if (!isEmpty(unknownKeys)) {
    logger.warn(
      privateErrors
        ? 'Unknown configuration keys ignored'
        : `Unknown keys found: ${JSON.stringify(unknownKeys, null, 2)}`,
    );
  }

  // validate with Zod schema
  const result = AdminConfigDto.schema.safeParse(rawConfig);
  if (!result.success) {
    const messages = ['Invalid system config: '];
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      messages.push(`  - [${path}] ${issue.message}`);
    }
    if (privateErrors) throw new Error('effective_config_candidate_invalid');
    if (configFile) {
      throw new Error(messages.join('\n'));
    }
    logger.error('Validation error', messages);
  }

  const config = (result.success ? result.data : rawConfig) as SystemConfig;

  if (config.server.externalDomain.length > 0) {
    const domain = new URL(config.server.externalDomain);

    const externalDomain =
      domain.password && domain.username
        ? `${domain.protocol}//${domain.username}:${domain.password}@${domain.host}`
        : domain.origin;

    config.server.externalDomain = externalDomain;
  }

  if (!config.ffmpeg.acceptedVideoCodecs.includes(config.ffmpeg.targetVideoCodec)) {
    config.ffmpeg.acceptedVideoCodecs.push(config.ffmpeg.targetVideoCodec);
  }

  if (!config.ffmpeg.acceptedAudioCodecs.includes(config.ffmpeg.targetAudioCodec)) {
    config.ffmpeg.acceptedAudioCodecs.push(config.ffmpeg.targetAudioCodec);
  }

  return config;
};
