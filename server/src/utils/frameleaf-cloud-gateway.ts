import { join } from 'node:path';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import type { DatabaseRepository } from 'src/repositories/database.repository.js';
import type { EventRepository } from 'src/repositories/event.repository.js';
import type { CloudMlGateway } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import type { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import type { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import type { FrameleafCloudLink, FrameleafInstanceIdentity, FrameleafMlSuspension } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { DatabaseLock, MlAdmissionRefusal, NotificationLevel, NotificationType, SystemMetadataKey } from 'src/enum.js';
import { FrameleafCloudError, regionalGateway } from 'src/utils/frameleaf-cloud.js';

export type CloudGatewayDeps = {
  configRepository: ConfigRepository;
  databaseRepository: DatabaseRepository;
  systemMetadataRepository: SystemMetadataRepository;
  instanceIdentityRepository: InstanceIdentityRepository;
  frameleafCloudRepository: FrameleafCloudRepository;
};

/**
 * What resolving the processing gateway needs besides `CloudGatewayDeps` (FL-185): a `clone_suspected`
 * refusal of the ML token raises the administrators' notice, and a notice that could not be sent is
 * logged.
 */
export type CloudMlGatewayDeps = CloudGatewayDeps & {
  eventRepository: Pick<EventRepository, 'emit'>;
  logger: Pick<LoggingRepository, 'warn'>;
};

/**
 * The notice administrators get when Frameleaf Cloud suspects a copy of this server, whether a
 * check-in said `cloneSuspected: true` (FL-155) or the token endpoint refused an ML token with
 * `clone_suspected` (FL-185). One key, so the two paths never send it twice.
 */
export const CLONE_SUSPECTED_NOTICE = Object.freeze({
  level: NotificationLevel.Warning,
  title: 'Two servers are using this server’s identity',
  description:
    'Frameleaf Cloud saw this server’s key start from two places. If you copied this server, give the copy its own identity folder. Cloud backup and cloud processing pause until this is resolved: the account owner can confirm this server in the Frameleaf account, or it clears on its own after 24 hours without a restart.',
  dedupeKey: 'frameleaf-cloud:clone-suspected',
  dedupeDays: 1,
});

/** Why cloud processing is refused while Frameleaf Cloud suspects a copy of this server (FL-185). */
export const ML_CLONE_SUSPENDED_DETAIL =
  'Frameleaf Cloud paused cloud processing because this server’s identity is in use in two places. It resumes when Frameleaf Cloud clears this.';

/**
 * How long a recorded ML suspension blocks every ML token request before one probe is allowed (FL-185):
 * the cloud's own suspicion clears after 24 hours without a `bootId` change, so a suspension a missed
 * check-in never cleared cannot block cloud processing for good. A refused probe records it again.
 */
export const ML_SUSPENSION_PROBE_AFTER_MS = 24 * 60 * 60 * 1000;

/** The OAuth error the token endpoint answers an ML token request with while it suspects a copy. */
const CLONE_SUSPECTED_ERROR = 'clone_suspected';

/** The token endpoint refused an ML token because Frameleaf Cloud suspects a copy of this server. */
export const isCloneSuspectedRefusal = (error: unknown): boolean =>
  error instanceof FrameleafCloudError && error.status === 400 && error.oauth?.error === CLONE_SUSPECTED_ERROR;

/** The ML suspension recorded for this link, or null (one recorded for another link does not count). */
export const readMlSuspension = async (
  deps: Pick<CloudGatewayDeps, 'systemMetadataRepository'>,
  cloudUrl: string,
  instanceId: string,
): Promise<FrameleafMlSuspension | null> => {
  const suspension = await deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafMlSuspension);
  return suspension?.reason === 'clone-suspected' &&
    suspension.cloudUrl === cloudUrl &&
    suspension.instanceId === instanceId
    ? suspension
    : null;
};

/** Record that ML tokens are refused for this link until a check-in clears it (FL-185). */
export const recordMlSuspension = (
  deps: Pick<CloudGatewayDeps, 'systemMetadataRepository'>,
  cloudUrl: string,
  instanceId: string,
): Promise<void> =>
  deps.systemMetadataRepository.set(SystemMetadataKey.FrameleafMlSuspension, {
    reason: 'clone-suspected',
    cloudUrl,
    instanceId,
    since: new Date().toISOString(),
  });

/** ML tokens may be requested again (FL-185). */
export const clearMlSuspension = (deps: Pick<CloudGatewayDeps, 'systemMetadataRepository'>): Promise<void> =>
  deps.systemMetadataRepository.delete(SystemMetadataKey.FrameleafMlSuspension);

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
 *
 * FL-185: while Frameleaf Cloud suspects a copy of this server, no ML token is requested at all (no
 * retry, no backoff) and the refusal says why. A `clone_suspected` answer to the token request records
 * that state, which survives a restart, and tells the administrators; a check-in clears it. After
 * `ML_SUSPENSION_PROBE_AFTER_MS` one ML token request is allowed: a token clears the suspension, a new
 * refusal records it again from now.
 */
export const resolveCloudGateway = async (deps: CloudMlGatewayDeps): Promise<CloudGatewayResolution> => {
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

  const suspendedRefusal: CloudGatewayResolution = {
    state: CloudConnectionState.Unavailable,
    refusal: MlAdmissionRefusal.CloudUnavailable,
    detail: ML_CLONE_SUSPENDED_DETAIL,
    link,
  };
  // a `since` that does not parse counts as expired
  const blocks = (suspension: FrameleafMlSuspension) =>
    Date.now() - Date.parse(suspension.since) < ML_SUSPENSION_PROBE_AFTER_MS;
  const suspension = await readMlSuspension(deps, cloudUrl, link.instanceId);
  let probing = false;
  if (suspension) {
    if (blocks(suspension)) {
      return suspendedRefusal;
    }
    // One probe a day. The claim re-reads the suspension and rewrites it from now under a lock, so a
    // second worker (or job) waiting on the lock finds the fresh claim and is refused instead of probing
    // too. The lock is released before the probe, and before loadInstanceIdentity takes its own lock.
    type Claim = 'blocked' | 'claimed' | 'cleared';
    const { instanceId } = link;
    let claim: Claim;
    try {
      claim = await deps.databaseRepository.withLock(DatabaseLock.FrameleafMlProbe, async (): Promise<Claim> => {
        const current = await readMlSuspension(deps, cloudUrl, instanceId);
        if (!current) {
          return 'cleared';
        }
        if (blocks(current)) {
          return 'blocked';
        }
        await recordMlSuspension(deps, cloudUrl, instanceId);
        return 'claimed';
      });
    } catch (error) {
      deps.logger.warn(`Could not claim the cloud processing probe: ${error}`);
      return suspendedRefusal;
    }
    if (claim === 'blocked') {
      return suspendedRefusal;
    }
    // `cleared`: a check-in cleared the suspension meanwhile, so this is an ordinary request
    probing = claim === 'claimed';
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
    if (probing) {
      // the cloud issued an ML token again, so it no longer suspects a copy
      try {
        await clearMlSuspension(deps);
      } catch (error) {
        // the claim's fresh `since` then blocks ML tokens until the next check-in clears it (or a day)
        deps.logger.warn(
          `Could not clear the cloud processing suspension after Frameleaf Cloud issued an ML token; the next check-in clears it: ${error}`,
        );
      }
    }
    return { state: CloudConnectionState.Ready, gateway: { url: gatewayUrl, token }, region: link.dataRegion, link };
  } catch (error) {
    if (isCloneSuspectedRefusal(error)) {
      // the refusal stands even when the suspension cannot be written; the next admission asks again
      try {
        await recordMlSuspension(deps, cloudUrl, link.instanceId);
      } catch (recordError) {
        deps.logger.warn(`Could not record the cloud processing suspension: ${recordError}`);
      }
      // a new suspicion always notifies (the dedupe key keeps repeats out); a refused daily probe is not new
      if (!probing) {
        try {
          await deps.eventRepository.emit('AdminNotify', {
            type: NotificationType.SystemMessage,
            ...CLONE_SUSPECTED_NOTICE,
          });
        } catch (notifyError) {
          deps.logger.warn(`Could not notify administrators: ${notifyError}`);
        }
      }
      return suspendedRefusal;
    }
    if (error instanceof FrameleafCloudError) {
      return { state: CloudConnectionState.Unavailable, refusal: error.refusal, detail: error.message, link };
    }
    throw error;
  }
};
