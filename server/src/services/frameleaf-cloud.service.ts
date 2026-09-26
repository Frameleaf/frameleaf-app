import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { isEqual } from 'lodash-es';
import { createHash, randomUUID } from 'node:crypto';
import { arch, platform } from 'node:os';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { FrameleafCloudTopic } from 'src/repositories/websocket.repository.js';
import type { FrameleafCloudLink, FrameleafCloudPermissions, FrameleafInstanceIdentity } from 'src/types.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  CloudPermissionsUpdateDto,
  CloudSignInUpdateDto,
  CloudStatusResponseDto,
} from 'src/dtos/frameleaf-cloud.dto.js';
import {
  AdminAuditAction,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  NotificationLevel,
  NotificationType,
  QueueName,
  SystemMetadataKey,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { loadInstanceIdentity } from 'src/utils/frameleaf-cloud-gateway.js';
import {
  CloudCommand,
  CloudCommandType,
  DEVICE_CODE_GRANT,
  FRAMELEAF_LINK_CLIENT_ID,
  HEARTBEAT_FAILURE_NOTICE_THRESHOLD,
  HEARTBEAT_FIELDS,
  HeartbeatResponse,
  InstanceRegistration,
  KEY_RETIRE_HOURS,
  LINK_REFUSAL_MESSAGES,
  SLOW_DOWN_SECONDS,
  accountLabelOf,
  buildHeartbeat,
  commandPermission,
  deviceAuthorizationSchema,
  heartbeatResponseSchema,
  instanceRegistrationSchema,
  keyNonceSchema,
  linkEndpoints,
  linkRefusalOf,
  linkTokenSchema,
  nextHeartbeatDelay,
  permissionsOf,
} from 'src/utils/frameleaf-cloud-link.js';
import {
  CloudErrorCode,
  FrameleafCloudError,
  FrameleafDiscoveryDocument,
  cloudAddressProblem,
  cloudErrorCode,
} from 'src/utils/frameleaf-cloud.js';
import { acceptPublishedPricing } from 'src/utils/frameleaf-license.js';
import { handlePromiseError } from 'src/utils/misc.js';

/** Capabilities this build announces when it registers (instance contract step 4). */
const INSTANCE_CAPABILITIES = ['heartbeat', 'commands', 'license', 'oidc'];

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const emptyLink = (cloudUrl: string, previous?: FrameleafCloudLink | null): FrameleafCloudLink => ({
  status: 'unlinked',
  cloudUrl,
  permissions: permissionsOf(previous),
  usedLinkTokens: previous?.usedLinkTokens,
});

/**
 * Linking this server to a Frameleaf account (FL-155, CLD-002; FL-154 status).
 *
 * - Nothing is contacted until an administrator starts linking, or `FRAMELEAF_LINK_TOKEN` is set.
 *   An unset `FRAMELEAF_CLOUD_URL` means "not configured"; no default host is ever used.
 * - The device code and link token are never returned or kept after use; no cloud secret is stored.
 * - The heartbeat sends exactly `HEARTBEAT_FIELDS`; cloud commands run only when the matching
 *   instance-side toggle allows them, and no command or revoke deletes local data.
 * - Unlink and cloud-side revoke clear the link and switch cloud-connected features off.
 */
@Injectable()
export class FrameleafCloudService extends BaseService {
  // ------------------------------------------------------------------ status (FL-154)

  async getStatus(): Promise<CloudStatusResponseDto> {
    const cloudUrl = this.configRepository.getEnv().frameleafCloud.url;
    const identity = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafInstance);
    const stored = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudLink);
    // a link made against another FRAMELEAF_CLOUD_URL does not count here
    const link = cloudUrl && stored?.cloudUrl === cloudUrl ? stored : null;
    const config = await this.getConfig({ withCache: false });
    return {
      ...this.mapStatus(cloudUrl, identity, link),
      signInLinkedAccounts: await this.frameleafAccountRepository.countLinks(),
      signInShowOnLocalLogin: !!config.frameleafCloud.signIn?.showOnLocalLogin,
      signInButtonText: config.frameleafCloud.signIn?.buttonText ?? '',
    };
  }

  private mapStatus(
    cloudUrl: string | null,
    identity: FrameleafInstanceIdentity | null,
    link: FrameleafCloudLink | null,
  ): Omit<CloudStatusResponseDto, 'signInLinkedAccounts' | 'signInShowOnLocalLogin' | 'signInButtonText'> {
    const linked = link?.status === 'linked';
    return {
      state: cloudUrl ? (link?.status ?? 'unlinked') : 'not-configured',
      configured: !!cloudUrl,
      cloudHost: cloudUrl ? new URL(cloudUrl).host : null,
      instanceId: link?.instanceId ?? identity?.instanceId ?? null,
      keyFingerprint: identity?.kid ?? null,
      account: linked ? { id: link.accountId ?? null, label: link.accountLabel ?? null } : null,
      dataRegion: linked ? (link.dataRegion ?? null) : null,
      linkedAt: linked ? (link.linkedAt ?? null) : null,
      lastContactAt: linked ? (link.lastContactAt ?? null) : null,
      pending: link?.status === 'pending' && link.pending ? this.mapPending(link.pending) : null,
      linkResult: link?.status === 'pending' ? 'pending' : (link?.lastLinkResult ?? null),
      linkRefusal: link?.status === 'unlinked' ? (link.lastLinkRefusal ?? null) : null,
      permissions: permissionsOf(link),
      revoked: link?.status === 'revoked' ? (link.revoked ?? null) : null,
      lastError: link?.lastError ?? null,
      heartbeatFields: [...HEARTBEAT_FIELDS],
      heartbeatFailures: link?.heartbeat?.failures ?? 0,
      cloneSuspected: !!link?.heartbeat?.cloneSuspected,
      relinkRequested: !!link?.heartbeat?.relinkRequested,
      linkTokenConfigured: !!this.configRepository.getEnv().frameleafCloud.linkToken,
      remoteAccessEnabled: linked && !!link.desired?.remoteAccess,
      signInClientId: linked ? (link.oidc?.clientId ?? null) : null,
      signInIssuer: linked ? (link.oidc?.issuer ?? null) : null,
    };
  }

  private mapPending(pending: NonNullable<FrameleafCloudLink['pending']>) {
    return {
      userCode: pending.userCode,
      verificationUri: pending.verificationUri,
      verificationUriComplete: pending.verificationUriComplete,
      expiresAt: pending.expiresAt,
      intervalSeconds: pending.intervalSeconds,
    };
  }

  // ------------------------------------------------------------------ device flow (FL-155)

  /** `POST admin/cloud/link`: start an RFC 8628 device authorization. */
  async startLink(auth: AuthDto): Promise<CloudStatusResponseDto> {
    const cloudUrl = this.requireCloudUrl();
    const current = await this.readLink(cloudUrl);
    if (current?.status === 'linked') {
      throw new ConflictException('This server is already linked to a Frameleaf account. Unlink it first.');
    }

    const identity = await loadInstanceIdentity(this.gatewayDeps());
    const { name } = await this.serverIdentity();
    const authorization = await this.unavailableOnError(async () => {
      const document = await this.discover(cloudUrl);
      return this.frameleafCloudRepository.requestJson(deviceAuthorizationSchema, {
        method: 'POST',
        url: linkEndpoints(document).deviceAuthorization,
        form: {
          client_id: FRAMELEAF_LINK_CLIENT_ID,
          instance_name: name,
          version: serverVersion.toString(),
          jkt: identity.kid,
          platform: this.platform(),
        },
      });
    });

    const now = Date.now();
    const link: FrameleafCloudLink = {
      ...emptyLink(cloudUrl, current),
      status: 'pending',
      pending: {
        deviceCode: authorization.device_code,
        userCode: authorization.user_code,
        verificationUri: authorization.verification_uri,
        verificationUriComplete: authorization.verification_uri_complete,
        expiresAt: new Date(now + authorization.expires_in * 1000).toISOString(),
        intervalSeconds: authorization.interval,
        nextPollAt: new Date(now + authorization.interval * 1000).toISOString(),
        startedBy: auth.user.id,
      },
    };
    await this.saveLink(link, 'link');
    return this.getStatus();
  }

  /**
   * `GET admin/cloud/link`: the link state. While a code is pending, asks the cloud whether it was
   * approved, no more often than the interval it set (raised by every `slow_down`).
   */
  async getLink(): Promise<CloudStatusResponseDto> {
    const cloudUrl = this.configRepository.getEnv().frameleafCloud.url;
    if (cloudUrl) {
      const link = await this.readLink(cloudUrl);
      if (link?.status === 'pending' && link.pending) {
        await this.pollSafely(cloudUrl, link);
      }
    }
    return this.getStatus();
  }

  /** Poll once; a failure is shown on the page as the last error instead of failing the read. */
  private async pollSafely(cloudUrl: string, link: FrameleafCloudLink) {
    try {
      await this.pollDeviceCode(cloudUrl, link);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Frameleaf Cloud link check failed: ${message}`);
      const current = await this.readLink(cloudUrl);
      if (current?.status === 'pending' && current.pending) {
        const approved =
          current.pending.deviceCode === link.pending?.deviceCode && error instanceof FrameleafCloudError;
        await this.saveLink(
          approved && error.status !== null && error.status < 500
            ? {
                ...emptyLink(cloudUrl, current),
                lastError: `Linking did not finish: ${message}`,
                lastLinkRefusal: linkRefusalOf(error) ?? undefined,
              }
            : {
                ...current,
                lastError: message,
                pending: { ...current.pending, nextPollAt: this.after(Date.now(), current.pending.intervalSeconds) },
              },
          'link',
        );
      }
    }
  }

  /** A cloud failure while an administrator waits becomes a 503 with the cloud's plain message. */
  private async unavailableOnError<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof FrameleafCloudError) {
        throw new ServiceUnavailableException(`Frameleaf Cloud did not complete the request: ${error.message}`);
      }
      throw error;
    }
  }

  /** `DELETE admin/cloud/link/pending`: give up on a code that is waiting for approval. */
  async cancelLink(): Promise<CloudStatusResponseDto> {
    const cloudUrl = this.requireCloudUrl();
    const link = await this.readLink(cloudUrl);
    if (link?.status === 'pending') {
      await this.saveLink(emptyLink(cloudUrl, link), 'link');
    }
    return this.getStatus();
  }

  /** One poll of the device-code grant (RFC 8628 section 3.4). */
  async pollDeviceCode(cloudUrl: string, link: FrameleafCloudLink, now = Date.now()): Promise<void> {
    const pending = link.pending;
    if (!pending) {
      return;
    }
    if (Date.parse(pending.expiresAt) <= now) {
      await this.endPending(cloudUrl, link, 'expired');
      return;
    }
    if (Date.parse(pending.nextPollAt) > now) {
      return;
    }

    const document = await this.discover(cloudUrl);
    const result = await this.frameleafCloudRepository.requestOAuth(linkTokenSchema, {
      method: 'POST',
      url: linkEndpoints(document).token,
      form: { grant_type: DEVICE_CODE_GRANT, device_code: pending.deviceCode, client_id: FRAMELEAF_LINK_CLIENT_ID },
    });

    if (result.ok) {
      await this.completeLink(cloudUrl, { linkToken: result.data.access_token, actorId: pending.startedBy });
      return;
    }

    switch (result.error) {
      case 'authorization_pending': {
        await this.saveLink(
          { ...link, pending: { ...pending, nextPollAt: this.after(now, pending.intervalSeconds) } },
          null,
        );
        return;
      }
      case 'slow_down': {
        const intervalSeconds = pending.intervalSeconds + SLOW_DOWN_SECONDS;
        await this.saveLink(
          { ...link, pending: { ...pending, intervalSeconds, nextPollAt: this.after(now, intervalSeconds) } },
          null,
        );
        return;
      }
      case 'expired_token': {
        await this.endPending(cloudUrl, link, 'expired');
        return;
      }
      case 'access_denied': {
        await this.endPending(cloudUrl, link, 'denied');
        return;
      }
      default: {
        await this.saveLink(
          {
            ...link,
            lastError: `Frameleaf Cloud refused the code (${result.error})`,
            pending: { ...pending, nextPollAt: this.after(now, pending.intervalSeconds) },
          },
          'link',
        );
      }
    }
  }

  private async endPending(cloudUrl: string, link: FrameleafCloudLink, result: 'denied' | 'expired') {
    await this.saveLink({ ...emptyLink(cloudUrl, link), lastLinkResult: result }, 'link');
  }

  /**
   * Register this server with the link token from the device flow, or headlessly with
   * `FRAMELEAF_LINK_TOKEN` (sent as `X-Frameleaf-Link-Token`). The server names its own UUIDv7
   * `instanceId` (as-built decision #4); Frameleaf Cloud registers the Sign in with Frameleaf client
   * itself, so this server never runs dynamic client registration and sends no redirect URIs
   * (decisions #7–#9). A refusal the contract names comes back in words an administrator can act on
   * (`LINK_REFUSAL_MESSAGES`).
   */
  async completeLink(
    cloudUrl: string,
    source: { linkToken: string; actorId?: string } | { headlessToken: string },
  ): Promise<FrameleafCloudLink> {
    const identity = await loadInstanceIdentity(this.gatewayDeps());
    const document = await this.discover(cloudUrl);
    const endpoints = linkEndpoints(document);
    const previous = await this.readLink(cloudUrl);
    const permissions = permissionsOf(previous);
    const { name } = await this.serverIdentity();

    let registration: InstanceRegistration;
    try {
      registration = await this.frameleafCloudRepository.requestJson(instanceRegistrationSchema, {
        method: 'POST',
        url: endpoints.instances,
        ...('linkToken' in source
          ? { bearer: source.linkToken }
          : { headers: { 'X-Frameleaf-Link-Token': source.headlessToken } }),
        body: {
          instanceId: identity.instanceId,
          name,
          version: serverVersion.toString(),
          platform: this.platform(),
          jwk: { ...identity.publicJwk, kid: identity.kid },
          bootId: await this.bootId(),
          capabilities: INSTANCE_CAPABILITIES,
          permissions,
        },
      });
    } catch (error) {
      const refusal = linkRefusalOf(error);
      if (refusal && error instanceof FrameleafCloudError) {
        throw new FrameleafCloudError(
          error.refusal,
          error.status,
          LINK_REFUSAL_MESSAGES[refusal],
          error.envelope,
          error.oauth,
        );
      }
      throw error;
    }

    const { oidc } = registration;
    const problem = cloudAddressProblem(cloudUrl, 'sign-in issuer', oidc.issuer);
    if (problem) {
      throw new ServiceUnavailableException(
        `Frameleaf Cloud answered with an address this server will not use: ${problem}`,
      );
    }
    if (registration.instanceId !== identity.instanceId) {
      // a cloud from before as-built decision #4 names its own id; it is the one it knows this server by
      this.logger.warn(
        `Frameleaf Cloud registered this server as ${registration.instanceId}, not as its own instance ID`,
      );
    }

    const at = new Date().toISOString();
    const link: FrameleafCloudLink = {
      status: 'linked',
      cloudUrl,
      instanceId: registration.instanceId,
      accountId: registration.owner.accountId ?? registration.owner.id,
      accountLabel: accountLabelOf(registration.owner),
      dataRegion: registration.owner.dataRegion ?? registration.owner.region,
      linkedAt: at,
      lastContactAt: at,
      lastLinkResult: 'approved',
      permissions,
      oidc: {
        issuer: oidc.issuer,
        clientId: oidc.clientId,
        scope: oidc.scope,
        roleClaim: oidc.roleClaim,
        storageLabelClaim: oidc.storageLabelClaim,
      },
      services: registration.services,
      desired: { remoteAccess: false, cloudBackup: false },
      heartbeat: { failures: 0, nextAt: this.after(Date.now(), nextHeartbeatDelay(null)) },
      usedLinkTokens: previous?.usedLinkTokens,
    };
    this.frameleafCloudRepository.forget();
    await this.saveLink(link, 'link');

    const actor = 'actorId' in source ? source.actorId : undefined;
    await this.audit(AdminAuditAction.CloudLinked, link.accountLabel ?? null, actor);
    this.notify({
      level: NotificationLevel.Info,
      title: 'Server linked to Frameleaf',
      description: `This server is linked to ${link.accountLabel ?? 'a Frameleaf account'}. Cloud features you turn on use this link.`,
      dedupeKey: `frameleaf-cloud:linked:${link.linkedAt}`,
    });
    return link;
  }

  /** `DELETE admin/cloud/link`: unlink from this side. Local data is never touched. */
  async unlink(auth: AuthDto): Promise<CloudStatusResponseDto> {
    const cloudUrl = this.requireCloudUrl();
    const link = await this.readLink(cloudUrl);
    if (!link || (link.status !== 'linked' && link.status !== 'revoked')) {
      throw new BadRequestException('This server is not linked');
    }
    if (link.status === 'linked' && link.instanceId) {
      // tell the cloud when it is reachable; the local unlink happens either way
      try {
        const { document, bearer } = await this.apiToken(cloudUrl, link);
        await this.frameleafCloudRepository.requestJson(z.unknown(), {
          method: 'DELETE',
          url: linkEndpoints(document).instance,
          bearer,
        });
      } catch (error) {
        this.logger.warn(`Frameleaf Cloud was not told about the unlink: ${error}`);
      }
    }
    await this.clearLink(cloudUrl, link, 'unlinked');
    await this.audit(AdminAuditAction.CloudUnlinked, link.accountLabel ?? null, auth.user.id);
    this.notify({
      level: NotificationLevel.Info,
      title: 'Server unlinked from Frameleaf',
      description: 'Cloud features on this server stopped. Local photos, accounts and sign-in are unchanged.',
      dedupeKey: `frameleaf-cloud:unlinked:${Date.now()}`,
    });
    return this.getStatus();
  }

  /** `PUT admin/cloud/permissions`: what Frameleaf Cloud may ask this server to do. */
  async updatePermissions(auth: AuthDto, dto: CloudPermissionsUpdateDto): Promise<CloudStatusResponseDto> {
    const cloudUrl = this.requireCloudUrl();
    const link = (await this.readLink(cloudUrl)) ?? emptyLink(cloudUrl);
    const permissions: FrameleafCloudPermissions = { ...permissionsOf(link), ...dto };
    await this.saveLink({ ...link, permissions }, 'link');
    const on = Object.entries(permissions)
      .filter(([, value]) => value)
      .map(([key]) => key)
      .join(',');
    await this.audit(AdminAuditAction.CloudPermissionsChanged, on || 'none', auth.user.id);
    return this.getStatus();
  }

  /**
   * `PUT admin/cloud/sign-in` (FL-158): whether Sign in with Frameleaf is also offered at home, and its
   * button text. Remote access always requires it; this only adds the button to the local login
   * page, once linked.
   */
  async updateSignIn(auth: AuthDto, dto: CloudSignInUpdateDto): Promise<CloudStatusResponseDto> {
    const cloudUrl = this.requireCloudUrl();
    const link = await this.readLink(cloudUrl);
    if (dto.showOnLocalLogin !== undefined && link?.status !== 'linked') {
      throw new BadRequestException('Link this server first.');
    }
    const { oldConfig, newConfig } = await this.updateConfigExclusively((config) => {
      config.frameleafCloud.signIn = {
        ...config.frameleafCloud.signIn,
        ...(dto.showOnLocalLogin !== undefined && { showOnLocalLogin: dto.showOnLocalLogin }),
        ...(dto.buttonText !== undefined && { buttonText: dto.buttonText }),
      };
    });
    await this.eventRepository.emit('ConfigUpdate', { oldConfig, newConfig });
    this.logger.log(`Sign in with Frameleaf settings changed by ${auth.user.id}`);
    return this.getStatus();
  }

  /**
   * Cloud-side revoke or local unlink: clear the credential and cached tokens, mark the link, remove
   * the Frameleaf Cloud plan certificate, and switch remote access, cloud processing and cloud backup
   * off. Supporter key certificates stay (they work without a link); no photo, account or other local
   * data is deleted.
   */
  private async clearLink(
    cloudUrl: string,
    link: FrameleafCloudLink,
    status: 'unlinked' | 'revoked',
    reason?: string,
  ): Promise<void> {
    this.frameleafCloudRepository.forget();
    const next: FrameleafCloudLink = {
      ...emptyLink(cloudUrl, link),
      status,
      desired: { remoteAccess: false, cloudBackup: false },
      ...(status === 'revoked' && {
        instanceId: link.instanceId,
        revoked: { at: new Date().toISOString(), reason: reason ?? '' },
      }),
    };
    await this.saveLink(next, 'link');
    await this.systemMetadataRepository.delete(SystemMetadataKey.FrameleafMlWallet);
    await this.removePlanCertificate();
    const { oldConfig, newConfig } = await this.updateConfigExclusively((config) => {
      config.frameleafCloud.cloudMl.enabled = false;
    });
    if (!isEqual(oldConfig.frameleafCloud, newConfig.frameleafCloud)) {
      await this.eventRepository.emit('ConfigUpdate', { oldConfig, newConfig });
    }
    await this.endFrameleafSignIns();
  }

  /**
   * FL-177 (as-built decision #12): the plan belongs to the link, so its certificate goes with it. A
   * supporter key's certificate is kept. A failure is logged; the plan then ages out on its own.
   */
  private async removePlanCertificate() {
    try {
      const store = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafLicense);
      if (store?.plan) {
        await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafLicense, { ...store, plan: null });
        await this.broadcast('license');
      }
    } catch (error) {
      this.logger.error(`Could not remove the Frameleaf Cloud plan from this server: ${error}`);
    }
  }

  /**
   * FL-158: with the link gone Frameleaf Cloud can no longer vouch for anyone, so every Sign in with
   * Frameleaf session ends and the account links are removed. Local sign-in is unchanged.
   */
  private async endFrameleafSignIns() {
    try {
      const sessionIds = await this.frameleafAccountRepository.deleteAllSessions();
      for (const sessionId of sessionIds) {
        await this.sessionRepository.delete(sessionId);
        await this.eventRepository.emit('SessionDelete', { sessionId });
      }
      await this.frameleafAccountRepository.deleteAllLinks();
    } catch (error) {
      this.logger.error(`Could not end the Sign in with Frameleaf sessions: ${error}`);
    }
  }

  private async revoke(cloudUrl: string, link: FrameleafCloudLink, reason: string): Promise<void> {
    await this.clearLink(cloudUrl, link, 'revoked', reason);
    await this.audit(AdminAuditAction.CloudRevoked, reason, undefined);
    this.notify({
      level: NotificationLevel.Warning,
      title: 'Frameleaf Cloud ended this server’s link',
      description: `${reason} Cloud features stopped; local photos, accounts and sign-in are unchanged. Link again from Settings → Frameleaf Cloud.`,
      dedupeKey: 'frameleaf-cloud:revoked',
      dedupeDays: 1,
    });
  }

  // ------------------------------------------------------------------ headless link (FL-155)

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap(): Promise<void> {
    const { url: cloudUrl, linkToken } = this.configRepository.getEnv().frameleafCloud;
    await this.startBoot();
    await this.forgetSignInClientSecret();
    this.cronRepository.create({
      name: 'frameleafHeartbeat',
      expression: '* * * * *',
      onTick: () =>
        handlePromiseError(this.jobRepository.queue({ name: JobName.FrameleafHeartbeat, data: {} }), this.logger),
      start: !!cloudUrl,
    });
    if (cloudUrl && linkToken) {
      await this.linkHeadless(cloudUrl, linkToken);
    }
  }

  /** Link once with `FRAMELEAF_LINK_TOKEN`; a token that was used before is never sent again. */
  async linkHeadless(cloudUrl: string, token: string): Promise<void> {
    await this.databaseRepository.withLock(DatabaseLock.FrameleafHeartbeat, async () => {
      const link = await this.readLink(cloudUrl);
      const hash = sha256(token);
      if (link?.usedLinkTokens?.includes(hash)) {
        this.logger.log('FRAMELEAF_LINK_TOKEN was already used once; it is ignored. Remove it from the environment.');
        return;
      }
      if (link?.status === 'linked') {
        this.logger.log(
          'FRAMELEAF_LINK_TOKEN is ignored: this server is already linked. Remove it from the environment.',
        );
        return;
      }
      const usedLinkTokens = [...(link?.usedLinkTokens ?? []), hash].slice(-20);
      await this.saveLink({ ...(link ?? emptyLink(cloudUrl)), usedLinkTokens }, null);
      try {
        await this.completeLink(cloudUrl, { headlessToken: token });
        this.logger.log('Linked to Frameleaf with FRAMELEAF_LINK_TOKEN. Remove it from the environment.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`FRAMELEAF_LINK_TOKEN did not link this server: ${message}`);
        const current = (await this.readLink(cloudUrl)) ?? emptyLink(cloudUrl);
        await this.saveLink(
          {
            ...current,
            lastError: `The link token did not work: ${message}`,
            lastLinkRefusal: linkRefusalOf(error) ?? undefined,
          },
          'link',
        );
      }
    });
  }

  /**
   * FL-177 (as-built decision #14): a new boot id each time the server starts, kept in system
   * metadata so every worker (the API one for registration and "Check in now", this one for
   * scheduled check-ins) sends the same value. Two values alternating then only ever means two
   * servers, which is what the cloud's clone rule looks for.
   */
  private async startBoot() {
    try {
      await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafBoot, {
        bootId: randomUUID(),
        startedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.warn(`Could not record this server's boot id: ${error}`);
    }
  }

  /** The boot id of this server start; created here only when no worker recorded one yet. */
  async bootId(): Promise<string> {
    const stored = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafBoot);
    if (stored?.bootId) {
      return stored.bootId;
    }
    const boot = { bootId: randomUUID(), startedAt: new Date().toISOString() };
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafBoot, boot);
    return boot.bootId;
  }

  /**
   * FL-177 (as-built decision #10): Sign in with Frameleaf authenticates with this server's key only,
   * and the client secret setting is gone. A secret an earlier version saved is removed from the
   * stored settings once, so no cloud secret stays on the server. A configuration file is left to the
   * administrator who owns it.
   */
  private async forgetSignInClientSecret() {
    try {
      if (this.configRepository.getEnv().configFile) {
        return;
      }
      const stored = await this.systemMetadataRepository.get(SystemMetadataKey.SystemConfig);
      const signIn = stored?.frameleafCloud?.signIn as Record<string, unknown> | undefined;
      if (!signIn || !Object.hasOwn(signIn, 'clientSecret')) {
        return;
      }
      // saving writes the settings back from the current schema, which has no client secret
      await this.updateConfigExclusively(() => {});
      this.logger.log('Removed the unused Sign in with Frameleaf client secret an earlier version saved');
    } catch (error) {
      this.logger.warn(`Could not remove the unused Sign in with Frameleaf client secret: ${error}`);
    }
  }

  // ------------------------------------------------------------------ heartbeat (FL-155)

  @OnJob({ name: JobName.FrameleafHeartbeat, queue: QueueName.BackgroundTask })
  async handleHeartbeat({ force }: { force?: boolean } = {}): Promise<JobStatus> {
    const cloudUrl = this.configRepository.getEnv().frameleafCloud.url;
    if (!cloudUrl) {
      return JobStatus.Skipped;
    }
    return this.databaseRepository.withLock(DatabaseLock.FrameleafHeartbeat, async () => {
      const link = await this.readLink(cloudUrl);
      if (link?.status === 'pending' && link.pending) {
        // keep a waiting code moving even when no administrator has the page open
        await this.pollSafely(cloudUrl, link);
        return JobStatus.Success;
      }
      if (link?.status !== 'linked' || !link.instanceId) {
        return JobStatus.Skipped;
      }
      if (!force && link.heartbeat?.nextAt && Date.parse(link.heartbeat.nextAt) > Date.now()) {
        return JobStatus.Skipped;
      }
      return this.checkIn(cloudUrl, link);
    });
  }

  /** `POST admin/cloud/heartbeat`: check in now ("Check in now"). */
  async checkInNow(): Promise<CloudStatusResponseDto> {
    const cloudUrl = this.requireCloudUrl();
    await this.databaseRepository.withLock(DatabaseLock.FrameleafHeartbeat, async () => {
      const link = await this.readLink(cloudUrl);
      if (link?.status !== 'linked') {
        throw new BadRequestException('This server is not linked');
      }
      const status = await this.checkIn(cloudUrl, link);
      if (status === JobStatus.Failed) {
        const after = await this.readLink(cloudUrl);
        throw new ServiceUnavailableException(after?.lastError ?? 'Frameleaf Cloud did not answer');
      }
    });
    return this.getStatus();
  }

  /** The exact payload of one check-in. */
  async buildHeartbeatPayload(link: FrameleafCloudLink) {
    const license = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafLicense);
    let storage: 'ok' | 'error' = 'ok';
    try {
      await this.storageRepository.stat(StorageCore.getMediaLocation());
    } catch {
      storage = 'error';
    }
    return buildHeartbeat({
      version: serverVersion.toString(),
      bootId: await this.bootId(),
      uptimeSec: process.uptime(),
      health: { database: 'ok', storage, jobs: 'ok' },
      endpoints: [],
      remoteAccess: { enabled: !!link.desired?.remoteAccess, relayConnected: false, direct: false },
      permissions: permissionsOf(link),
      licenseKid: license?.plan?.kid ?? license?.key?.kid ?? null,
    });
  }

  private async checkIn(cloudUrl: string, link: FrameleafCloudLink): Promise<JobStatus> {
    let response: HeartbeatResponse;
    let document: FrameleafDiscoveryDocument;
    try {
      const token = await this.apiToken(cloudUrl, link);
      document = token.document;
      response = await this.frameleafCloudRepository.requestJson(heartbeatResponseSchema, {
        method: 'POST',
        url: linkEndpoints(document).heartbeat,
        bearer: token.bearer,
        body: await this.buildHeartbeatPayload(link),
      });
    } catch (error) {
      if (cloudErrorCode(error) === CloudErrorCode.KeyRetired) {
        // FL-177 (FC-19): the token was minted with a key the cloud retired or revoked. A candidate
        // key the cloud may hold after a lost rotation answer is tried first; otherwise only a new
        // link helps, which the administrators are asked for. The link itself is not revoked.
        const recovered = await this.tryCandidateKey(cloudUrl, link);
        const current = (await this.readLink(cloudUrl)) ?? link;
        await this.recordHeartbeatFailure(recovered ? current : this.requireRelink(current, 'key'), error);
        return JobStatus.Failed;
      }
      if (this.isRevocation(error)) {
        // a rotation whose answer was lost may have left the cloud holding the candidate key; only
        // invalid_client can mean that, an explicit instance-revoked never does
        if (this.isInvalidClient(error) && (await this.tryCandidateKey(cloudUrl, link))) {
          // this check-in still failed: count it, so repeated failures still reach the administrators
          await this.recordHeartbeatFailure((await this.readLink(cloudUrl)) ?? link, error);
          return JobStatus.Failed;
        }
        await this.revoke(cloudUrl, link, 'Frameleaf Cloud no longer recognises this server.');
        return JobStatus.Failed;
      }
      await this.recordHeartbeatFailure(link, error);
      return JobStatus.Failed;
    }

    const now = Date.now();
    let next: FrameleafCloudLink = {
      ...link,
      lastContactAt: new Date(now).toISOString(),
      lastError: undefined,
      heartbeat: {
        ...link.heartbeat,
        failures: 0,
        lastFailureAt: undefined,
        cloneSuspected: response.cloneSuspected,
        nextAt: this.after(now, nextHeartbeatDelay(response.nextHeartbeatSec)),
      },
    };
    if (response.servicesChanged) {
      this.frameleafCloudRepository.forget();
    }
    if (response.cloneSuspected && !link.heartbeat?.cloneSuspected) {
      this.notify({
        level: NotificationLevel.Warning,
        title: 'Two servers are using this server’s identity',
        description:
          'Frameleaf Cloud saw this server’s key start from two places. If you copied this server, give the copy its own identity directory. Cloud backup pauses until this is resolved.',
        dedupeKey: 'frameleaf-cloud:clone-suspected',
        dedupeDays: 1,
      });
    }
    for (const notice of response.notices) {
      this.notify({
        level:
          notice.level === 'error'
            ? NotificationLevel.Error
            : notice.level === 'warning'
              ? NotificationLevel.Warning
              : NotificationLevel.Info,
        title: 'Message from Frameleaf Cloud',
        description: notice.message,
        dedupeKey: `frameleaf-cloud:notice:${notice.id ?? sha256(notice.message)}`,
        dedupeDays: 30,
      });
    }
    for (const command of response.commands) {
      next = await this.runCommand(cloudUrl, document, next, command);
    }
    await this.keepPublishedPricing(response.pricing);
    if (response.entitlementsChanged && permissionsOf(next).allowEntitlementRefresh) {
      await this.jobRepository.queue({ name: JobName.FrameleafLicenseRefresh, data: { force: true } });
    }
    await this.removeRetiredKey();
    await this.saveLink(next, 'link');
    return JobStatus.Success;
  }

  /**
   * Keep the plan pricing a heartbeat published (`acceptPublishedPricing`). A storage failure only
   * logs a warning: the check-in, whose commands have already run, still succeeds, and the last good
   * pricing stays.
   */
  private async keepPublishedPricing(raw: unknown) {
    try {
      const stored = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafPricing);
      const next = acceptPublishedPricing(raw, stored);
      if (!isEqual(next, stored ?? { current: null })) {
        await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafPricing, next);
      }
    } catch (error) {
      this.logger.warn(`Could not keep the plan pricing Frameleaf Cloud published: ${error}`);
    }
  }

  private async recordHeartbeatFailure(link: FrameleafCloudLink, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const failures = (link.heartbeat?.failures ?? 0) + 1;
    this.logger.warn(`Frameleaf Cloud check-in failed (${failures} in a row): ${message}`);
    await this.saveLink(
      {
        ...link,
        lastError: message,
        heartbeat: {
          ...link.heartbeat,
          failures,
          lastFailureAt: new Date().toISOString(),
          nextAt: this.after(Date.now(), nextHeartbeatDelay(null)),
        },
      },
      'link',
    );
    if (failures >= HEARTBEAT_FAILURE_NOTICE_THRESHOLD) {
      this.notify({
        level: NotificationLevel.Warning,
        title: 'This server cannot reach Frameleaf Cloud',
        description: `The last ${failures} check-ins failed (${message}). Cloud features may pause; local features keep working.`,
        dedupeKey: 'frameleaf-cloud:heartbeat-failing',
        dedupeDays: 1,
      });
    }
  }

  /**
   * A token or check-in refusal that means the cloud ended this server's link: `invalid_client` at
   * the token endpoint, or `instance_revoked` (`instance-revoked` from earlier drafts too). An
   * `invalid_token` (FL-177) only means the access token was not accepted: any 401 drops the cached
   * tokens and the next call mints a new one, so it is never a revoke.
   */
  private isRevocation(error: unknown): boolean {
    if (!(error instanceof FrameleafCloudError) || (error.status !== 401 && error.status !== 403)) {
      return false;
    }
    const code = error.oauth?.error ?? cloudErrorCode(error) ?? '';
    return ['invalid_client', CloudErrorCode.InstanceRevoked, 'instance-revoked'].includes(code);
  }

  /** The token endpoint refused this server's key (not an explicit revoke). */
  private isInvalidClient(error: unknown): boolean {
    return error instanceof FrameleafCloudError && (error.oauth?.error ?? cloudErrorCode(error)) === 'invalid_client';
  }

  // ------------------------------------------------------------------ commands (FL-155)

  private async runCommand(
    cloudUrl: string,
    document: FrameleafDiscoveryDocument,
    link: FrameleafCloudLink,
    command: CloudCommand,
  ): Promise<FrameleafCloudLink> {
    const needed = commandPermission(command.type);
    const permissions = permissionsOf(link);
    let next = link;
    let result: 'done' | 'refused' | 'failed' = 'done';
    let detail: string | undefined;

    if (needed === null) {
      result = 'refused';
      detail = 'unknown command';
    } else if (needed !== 'always' && !permissions[needed]) {
      result = 'refused';
      detail = `not allowed on this server (${needed} is off)`;
    } else {
      try {
        next = await this.applyCommand(cloudUrl, document, link, command.type as CloudCommandType);
      } catch (error) {
        result = 'failed';
        detail = error instanceof Error ? error.message : String(error);
      }
    }

    this.logger.log(
      `Frameleaf Cloud command ${command.type} (${command.id}): ${result}${detail ? ` — ${detail}` : ''}`,
    );
    try {
      const { bearer } = await this.apiToken(cloudUrl, next);
      await this.frameleafCloudRepository.requestJson(z.unknown(), {
        method: 'POST',
        url: linkEndpoints(document).commandAck(command.id),
        bearer,
        body: { result, detail: detail ?? null },
      });
    } catch (error) {
      this.logger.warn(`Could not acknowledge Frameleaf Cloud command ${command.id}: ${error}`);
    }
    return next;
  }

  /** What each allowed command does. None of them deletes local data. */
  private async applyCommand(
    cloudUrl: string,
    document: FrameleafDiscoveryDocument,
    link: FrameleafCloudLink,
    type: CloudCommandType,
  ): Promise<FrameleafCloudLink> {
    const desired = link.desired ?? { remoteAccess: false, cloudBackup: false };
    switch (type) {
      case CloudCommandType.RemoteEnable: {
        return { ...link, desired: { ...desired, remoteAccess: true } };
      }
      case CloudCommandType.RemoteDisable: {
        return { ...link, desired: { ...desired, remoteAccess: false } };
      }
      case CloudCommandType.BackupRun: {
        throw new Error('cloud backup is not set up on this server');
      }
      case CloudCommandType.SecretRotate: {
        // FL-177 (as-built decision #10): no client secret exists; tokens come from the key, so the rotation
        // is dropping the cached tokens and discovery
        this.frameleafCloudRepository.forget();
        return link;
      }
      case CloudCommandType.KeyRotate: {
        await this.rotateKey(cloudUrl, document, link);
        return link;
      }
      case CloudCommandType.Relink: {
        return this.requireRelink(link, 'command');
      }
    }
  }

  /**
   * Ask the administrators to link this server again: on the cloud's `relink` command, or when every
   * instance route answers 401 `key_retired` (FL-177). Nothing on this server is removed.
   */
  private requireRelink(link: FrameleafCloudLink, why: 'command' | 'key'): FrameleafCloudLink {
    this.notify({
      level: NotificationLevel.Warning,
      title: 'Link this server to Frameleaf again',
      description: `${
        why === 'key'
          ? 'Frameleaf Cloud no longer accepts this server’s key.'
          : 'Frameleaf Cloud asked for this server to be linked again.'
      } Open Settings → Frameleaf Cloud → Account & link, unlink and link again. Nothing on this server is removed.`,
      dedupeKey: 'frameleaf-cloud:relink',
      dedupeDays: 1,
    });
    return {
      ...link,
      heartbeat: { ...link.heartbeat, failures: link.heartbeat?.failures ?? 0, relinkRequested: true },
    };
  }

  /** Key rotation: nonce, then the new key with a proof signed by the current key. */
  private async rotateKey(cloudUrl: string, document: FrameleafDiscoveryDocument, link: FrameleafCloudLink) {
    const identity = await loadInstanceIdentity(this.gatewayDeps());
    const endpoints = linkEndpoints(document);
    const { bearer } = await this.apiToken(cloudUrl, link);
    const { nonce } = await this.frameleafCloudRepository.requestJson(keyNonceSchema, {
      url: endpoints.keyNonce,
      bearer,
    });
    // under the identity lock, so no other worker loads the key while it is being swapped; the swap
    // itself survives a crash (InstanceIdentityRepository.recoverRotation)
    await this.databaseRepository.withLock(DatabaseLock.FrameleafIdentity, async () => {
      const rotated = await this.instanceIdentityRepository.rotate(
        identity,
        async (newJwk, signWithCurrent) => {
          await this.frameleafCloudRepository.requestJson(z.unknown(), {
            method: 'POST',
            url: endpoints.keyRotate,
            bearer,
            body: { newJwk, proof: signWithCurrent({ nonce, jkt: newJwk.kid }) },
          });
        },
        KEY_RETIRE_HOURS,
        Date.now(),
        // only a refusal the cloud answered deletes the new key; a lost answer keeps it as the candidate
        (error) =>
          error instanceof FrameleafCloudError && error.status !== null && error.status >= 400 && error.status < 500,
      );
      this.frameleafCloudRepository.forget();
      await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafInstance, rotated);
    });
  }

  /**
   * The cloud refused the current key (`invalid_client`). If a rotation left a candidate key (its
   * answer was lost), ask the cloud for a token with that key: when it is accepted the rotation is
   * finished and the link lives on; when it is refused too, the candidate is discarded and the
   * refusal stands. Returns whether the refusal must not be treated as a revoke (yet).
   */
  private async tryCandidateKey(cloudUrl: string, link: FrameleafCloudLink): Promise<boolean> {
    const instanceId = link.instanceId;
    if (!instanceId) {
      return false;
    }
    return this.databaseRepository.withLock(DatabaseLock.FrameleafIdentity, async () => {
      const identity = await loadInstanceIdentity(this.gatewayDeps());
      if (!identity.candidate) {
        return false;
      }
      this.frameleafCloudRepository.forget();
      try {
        const document = await this.discover(cloudUrl);
        const signer = await this.instanceIdentityRepository.candidateSigner(identity);
        await this.frameleafCloudRepository.accessToken(document, instanceId, document.api, signer);
      } catch (error) {
        this.frameleafCloudRepository.forget();
        if (!this.isRevocation(error)) {
          // no clear answer: keep the candidate (at most a day) and ask again at the next check-in
          return true;
        }
        await this.systemMetadataRepository.set(
          SystemMetadataKey.FrameleafInstance,
          await this.instanceIdentityRepository.discardCandidate(identity),
        );
        return false;
      }
      this.frameleafCloudRepository.forget();
      const promoted = await this.instanceIdentityRepository.promoteCandidate(identity, KEY_RETIRE_HOURS);
      await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafInstance, promoted);
      this.logger.log('Frameleaf Cloud holds the new identity key after all; the key rotation is finished');
      return true;
    });
  }

  private async removeRetiredKey() {
    const identity = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafInstance);
    if (identity?.retiring && Date.parse(identity.retiring.until) <= Date.now()) {
      await this.systemMetadataRepository.set(
        SystemMetadataKey.FrameleafInstance,
        await this.instanceIdentityRepository.removeRetired(identity),
      );
    }
  }

  // ------------------------------------------------------------------ helpers

  private requireCloudUrl(): string {
    const cloudUrl = this.configRepository.getEnv().frameleafCloud.url;
    if (!cloudUrl) {
      throw new BadRequestException('Frameleaf Cloud is not configured on this server (FRAMELEAF_CLOUD_URL is unset)');
    }
    return cloudUrl;
  }

  private async readLink(cloudUrl: string): Promise<FrameleafCloudLink | null> {
    const link = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudLink);
    return link && link.cloudUrl === cloudUrl ? link : null;
  }

  private async saveLink(link: FrameleafCloudLink, topic: FrameleafCloudTopic | null) {
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafCloudLink, link);
    if (topic) {
      await this.broadcast(topic);
    }
  }

  /** Tell open admin pages that something changed; only the topic travels. */
  async broadcast(topic: FrameleafCloudTopic) {
    try {
      for (const admin of await this.userRepository.getAdmins()) {
        this.websocketRepository.clientSend('on_frameleaf_cloud', admin.id, { topic });
      }
    } catch (error) {
      this.logger.warn(`Could not tell administrators about a Frameleaf Cloud change: ${error}`);
    }
  }

  private notify(notice: {
    level: NotificationLevel;
    title: string;
    description: string;
    dedupeKey: string;
    dedupeDays?: number;
  }) {
    this.eventRepository.emit('AdminNotify', { type: NotificationType.SystemMessage, ...notice }).catch((error) => {
      this.logger.warn(`Could not notify administrators: ${error}`);
    });
  }

  private async audit(action: AdminAuditAction, detail: string | null, actorId: string | undefined) {
    const admins = await this.userRepository.getAdmins();
    const subject = (actorId && admins.find((admin) => admin.id === actorId)) || admins[0];
    if (!subject) {
      return;
    }
    await this.recordAdminEvents([
      { userId: subject.id, actorId: actorId ?? null, action, subject: subject.name, detail },
    ]);
  }

  private async discover(cloudUrl: string) {
    return this.frameleafCloudRepository.discovery(cloudUrl);
  }

  /** An access token for the cloud API, minted with this server's key. */
  private async apiToken(cloudUrl: string, link: FrameleafCloudLink) {
    if (!link.instanceId) {
      throw new BadRequestException('This server is not linked');
    }
    const document = await this.discover(cloudUrl);
    const identity = await loadInstanceIdentity(this.gatewayDeps());
    const bearer = await this.frameleafCloudRepository.accessToken(document, link.instanceId, document.api, (claims) =>
      this.instanceIdentityRepository.signJws(identity.kid, claims),
    );
    return { document, bearer };
  }

  private gatewayDeps() {
    return {
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
    };
  }

  private async serverIdentity() {
    const config = await this.getConfig({ withCache: true });
    return { name: config.server.name?.trim() || 'Frameleaf server' };
  }

  private platform() {
    return `${platform()}/${arch()}`;
  }

  private after(now: number, seconds: number) {
    return new Date(now + seconds * 1000).toISOString();
  }
}
