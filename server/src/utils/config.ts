import AsyncLock from 'async-lock';
import { load as loadYaml } from 'js-yaml';
import { cloneDeep, get, isEmpty, isEqual, set } from 'lodash-es';
import { createHash } from 'node:crypto';
import type { DeepPartial } from 'src/types.js';
import { AdminConfigDto, SystemConfig, defaults, mapAdminConfig } from 'src/dtos/config.dto.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { getKeysDeep, unsetDeep } from 'src/utils/misc.js';
import { canonicalJson } from 'src/utils/object.js';

type RepoDeps = {
  configRepo: ConfigRepository;
  metadataRepo: SystemMetadataRepository;
  logger: LoggingRepository;
  forkSchemaRepo?: ForkSchemaRepository;
};

const asyncLock = new AsyncLock();
let config: SystemConfig | null = null;
let lastUpdated: number | null = null;

export const clearConfigCache = () => {
  config = null;
  lastUpdated = null;
};

export const getConfig = async (repos: RepoDeps, { withCache }: { withCache: boolean }): Promise<SystemConfig> => {
  if (!withCache || !config) {
    const timestamp = lastUpdated;
    await asyncLock.acquire(DatabaseLock[DatabaseLock.GetSystemConfig], async () => {
      if (timestamp !== lastUpdated) {
        return;
      }

      config = await buildConfig(repos);
      lastUpdated = Date.now();
    });
  }

  return repos.forkSchemaRepo ? repos.forkSchemaRepo.overlayConfig(config!) : config!;
};

/**
 * FL-66: the saved configuration read straight from storage, never from the cache. A cached read
 * can hand back a configuration built before another save committed, which must not be what a
 * revision check or a read-modify-write under the settings lock starts from.
 */
export const readConfig = async (repos: RepoDeps): Promise<SystemConfig> => {
  const config = await buildConfig(repos);
  return repos.forkSchemaRepo ? repos.forkSchemaRepo.overlayConfig(config) : config;
};

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
 * another administrator (or a resource action such as RunPod provisioning) changed since they
 * were loaded can be refused instead of silently overwriting them. The revision is never
 * stored, so no schema change is needed.
 *
 * It digests exactly what an administrator can read (`mapAdminConfig`): write-only credentials
 * (FL-67: the SMTP password, the OAuth client secret, the RunPod API key and the HuggingFace token)
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

  await (repos.forkSchemaRepo
    ? repos.forkSchemaRepo.persistConfig(partialConfig, newConfig)
    : metadataRepo.set(SystemMetadataKey.SystemConfig, partialConfig));

  clearConfigCache();

  // FL-66: what was just written, read from storage, so the revision a save reports is its own.
  return readConfig(repos);
};

const loadFromFile = async ({ metadataRepo, logger }: RepoDeps, filepath: string) => {
  try {
    const file = await metadataRepo.readFile(filepath);
    return loadYaml(file) as unknown;
  } catch (error: Error | any) {
    logger.error(`Unable to load configuration file: ${filepath}`);
    logger.error(error);
    throw error;
  }
};

const buildConfig = async (repos: RepoDeps) => {
  const { configRepo, metadataRepo, logger } = repos;
  const { configFile } = configRepo.getEnv();

  // load partial
  const partial = configFile
    ? await loadFromFile(repos, configFile)
    : await metadataRepo.get(SystemMetadataKey.SystemConfig);

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
    logger.warn(`Unknown keys found: ${JSON.stringify(unknownKeys, null, 2)}`);
  }

  // validate with Zod schema
  const result = AdminConfigDto.schema.safeParse(rawConfig);
  if (!result.success) {
    const messages = ['Invalid system config: '];
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      messages.push(`  - [${path}] ${issue.message}`);
    }
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
