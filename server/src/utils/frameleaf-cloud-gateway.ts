import { join } from 'node:path';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import type { DatabaseRepository } from 'src/repositories/database.repository.js';
import type { CloudMlGateway } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import type { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import type { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import type { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import type { FrameleafCloudLink, FrameleafInstanceIdentity } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { DatabaseLock, MlAdmissionRefusal, SystemMetadataKey } from 'src/enum.js';
import { FrameleafCloudError, regionalGateway } from 'src/utils/frameleaf-cloud.js';

export type CloudGatewayDeps = {
  configRepository: ConfigRepository;
  databaseRepository: DatabaseRepository;
  systemMetadataRepository: SystemMetadataRepository;
  instanceIdentityRepository: InstanceIdentityRepository;
  frameleafCloudRepository: FrameleafCloudRepository;
};

/** Where this server stands with Frameleaf Cloud, before any processing question is asked. */
export enum CloudConnectionState {
  /** `FRAMELEAF_CLOUD_URL` is not set: nothing is ever contacted. */
  NotConfigured = 'not-configured',
  /** Configured, but this server is not linked to a Frameleaf account (FL-155). */
  NotLinked = 'not-linked',
  /** Linked, and the regional gateway and a token were obtained. */
  Ready = 'ready',
  /** Linked, but discovery, the token or the region failed. */
  Unavailable = 'unavailable',
}

export type CloudGatewayResolution =
  | { state: CloudConnectionState.Ready; gateway: CloudMlGateway; region: string; link: FrameleafCloudLink }
  | {
      state: Exclude<CloudConnectionState, CloudConnectionState.Ready>;
      refusal: MlAdmissionRefusal;
      detail: string;
      link: FrameleafCloudLink | null;
    };

/** The directory holding this server's identity key: `FRAMELEAF_IDENTITY_DIR` or `<media>/frameleaf/identity`. */
export const identityDirectory = (configRepository: ConfigRepository): string =>
  configRepository.getEnv().frameleafCloud.identityDir ?? join(StorageCore.getMediaLocation(), 'frameleaf', 'identity');

/**
 * `loadInstanceIdentity` for a caller that already holds `DatabaseLock.FrameleafIdentity`. The lock is
 * not re-entrant (a second `withLock` on it from inside waits for itself forever), so such a caller
 * must use this instead (FL-175).
 */
export const loadInstanceIdentityLocked = async (deps: CloudGatewayDeps): Promise<FrameleafInstanceIdentity> => {
  const existing = await deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafInstance);
  const identity = await deps.instanceIdentityRepository.loadOrCreate(
    identityDirectory(deps.configRepository),
    existing,
  );
  if (
    !existing ||
    existing.kid !== identity.kid ||
    existing.instanceId !== identity.instanceId ||
    existing.retiring?.rotationId !== identity.retiring?.rotationId ||
    existing.candidate?.kid !== identity.candidate?.kid ||
    existing.rotationNeeded?.since !== identity.rotationNeeded?.since
  ) {
    await deps.systemMetadataRepository.set(SystemMetadataKey.FrameleafInstance, identity);
  }
  return identity;
};

/**
 * This server's identity key, created once under `DatabaseLock.FrameleafIdentity` (FL-159 builds this
 * part of FL-154). The public half is kept in `system_metadata`; the private key never leaves its file.
 */
export const loadInstanceIdentity = async (deps: CloudGatewayDeps): Promise<FrameleafInstanceIdentity> =>
  deps.databaseRepository.withLock(DatabaseLock.FrameleafIdentity, () => loadInstanceIdentityLocked(deps));

/** The configured cloud and the link record, without contacting anything. */
export const readCloudLink = async (
  deps: Pick<CloudGatewayDeps, 'configRepository' | 'systemMetadataRepository'>,
): Promise<{ cloudUrl: string | null; link: FrameleafCloudLink | null; linked: boolean }> => {
  const cloudUrl = deps.configRepository.getEnv().frameleafCloud.url;
  const link = await deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudLink);
  const linked = !!cloudUrl && !!link && link.status === 'linked' && !!link.instanceId && link.cloudUrl === cloudUrl;
  return { cloudUrl, link, linked };
};

/**
 * Resolve the regional processing gateway and a short-lived token for it (FL-159): the configured
 * `FRAMELEAF_CLOUD_URL`, the link record written by linking the server (FL-155), discovery for the
 * account's data region, and a `client_credentials` token minted with this server's current key
 * (`resource` = the regional gateway), DPoP-bound to that key, which signs every call's proof
 * (FL-178). No outbound call happens unless the server is configured and linked; every failure is a
 * refusal of Frameleaf Cloud, never a fallback.
 */
export const resolveCloudGateway = async (deps: CloudGatewayDeps): Promise<CloudGatewayResolution> => {
  const { cloudUrl, link, linked } = await readCloudLink(deps);
  if (!cloudUrl) {
    return {
      state: CloudConnectionState.NotConfigured,
      refusal: MlAdmissionRefusal.CloudUnavailable,
      detail: 'Frameleaf Cloud is not configured on this server',
      link,
    };
  }
  if (!linked || !link?.instanceId) {
    return {
      state: CloudConnectionState.NotLinked,
      refusal: MlAdmissionRefusal.CloudUnavailable,
      detail:
        link?.status === 'revoked'
          ? 'The link to Frameleaf Cloud was revoked'
          : 'This server is not linked to a Frameleaf account',
      link,
    };
  }

  try {
    const document = await deps.frameleafCloudRepository.discovery(cloudUrl);
    const gatewayUrl = regionalGateway(document, link.dataRegion);
    if (!gatewayUrl || !link.dataRegion) {
      return {
        state: CloudConnectionState.Unavailable,
        refusal: MlAdmissionRefusal.CloudUnavailable,
        detail: `Frameleaf Cloud offers no processing in the account's region (${link.dataRegion ?? 'none'})`,
        link,
      };
    }
    await loadInstanceIdentity(deps);
    const token = await deps.frameleafCloudRepository.accessToken(
      document,
      link.instanceId,
      gatewayUrl,
      deps.instanceIdentityRepository.currentSigner(),
    );
    return { state: CloudConnectionState.Ready, gateway: { url: gatewayUrl, token }, region: link.dataRegion, link };
  } catch (error) {
    if (error instanceof FrameleafCloudError) {
      return { state: CloudConnectionState.Unavailable, refusal: error.refusal, detail: error.message, link };
    }
    throw error;
  }
};
