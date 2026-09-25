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
  KEY_RETIRE_HOURS,
  SLOW_DOWN_SECONDS,
  accountLabelOf,
  buildHeartbeat,
  clientRegistrationSchema,
  commandPermission,
  deviceAuthorizationSchema,
  heartbeatResponseSchema,
  instanceRegistrationSchema,
  keyNonceSchema,
  linkEndpoints,
  linkTokenSchema,
  nextHeartbeatDelay,
  permissionsOf,
  redirectUris,
} from 'src/utils/frameleaf-cloud-link.js';
import { FrameleafCloudError, FrameleafDiscoveryDocument } from 'src/utils/frameleaf-cloud.js';
import { handlePromiseError } from 'src/utils/misc.js';

/** One process start: the cloud's clone rule compares these between check-ins. */
const BOOT_ID = randomUUID();

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
 * - The device code, link token and initial access token are never returned or kept after use.
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
    };
  }

  private mapStatus(
    cloudUrl: string | null,
    identity: FrameleafInstanceIdentity | null,
    link: FrameleafCloudLink | null,
  ): Omit<CloudStatusResponseDto, 'signInLinkedAccounts' | 'signInShowOnLocalLogin'> {
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
      permissions: permissionsOf(link),
      revoked: link?.status === 'revoked' ? (link.revoked ?? null) : null,
      lastError: link?.lastError ?? null,
      heartbeatFields: [...HEARTBEAT_FIELDS],
      heartbeatFailures: link?.heartbeat?.failures ?? 0,
      cloneSuspected: !!link?.heartbeat?.cloneSuspected,
      relinkRequested: !!link?.heartbeat?.relinkRequested,
      linkTokenConfigured: !!this.configRepository.getEnv().frameleafCloud.linkToken,
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
            ? { ...emptyLink(cloudUrl, current), lastError: `Linking did not finish: ${message}` }
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
   * `FRAMELEAF_LINK_TOKEN` (sent as `X-Frameleaf-Link-Token`), then complete dynamic client
   * registration. The initial access token is used once and never kept.
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

    const registration = await this.frameleafCloudRepository.requestJson(instanceRegistrationSchema, {
      method: 'POST',
      url: endpoints.instances,
      ...('linkToken' in source
        ? { bearer: source.linkToken }
        : { headers: { 'X-Frameleaf-Link-Token': source.headlessToken } }),
      body: {
        name,
        version: serverVersion.toString(),
        platform: this.platform(),
        jwk: { ...identity.publicJwk, kid: identity.kid },
        bootId: BOOT_ID,
        capabilities: INSTANCE_CAPABILITIES,
        permissions,
      },
    });

    const { oidc } = registration;
    if (oidc.initialAccessToken) {
      const origins = await this.publicOrigins(registration.services);
      await this.frameleafCloudRepository.requestJson(clientRegistrationSchema, {
        method: 'POST',
        url: oidc.registrationEndpoint ?? endpoints.registration,
        bearer: oidc.initialAccessToken,
        body: {
          client_id: oidc.clientId,
          client_name: name,
          token_endpoint_auth_method: 'private_key_jwt',
          jwks: { keys: [{ ...identity.publicJwk, kid: identity.kid, use: 'sig', alg: 'EdDSA' }] },
          grant_types: ['authorization_code', 'client_credentials'],
          response_types: ['code'],
          redirect_uris: redirectUris(origins),
        },
      });
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
        registrationEndpoint: oidc.registrationEndpoint,
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
   * `PUT admin/cloud/sign-in` (FL-158): whether Sign in with Frameleaf is also offered at home. Remote
   * access always requires it; this only adds the button to the local login page, once linked.
   */
  async updateSignIn(auth: AuthDto, dto: CloudSignInUpdateDto): Promise<CloudStatusResponseDto> {
    const cloudUrl = this.requireCloudUrl();
    const link = await this.readLink(cloudUrl);
    if (link?.status !== 'linked') {
      throw new BadRequestException('Link this server first.');
    }
    const { oldConfig, newConfig } = await this.updateConfigExclusively((config) => {
      config.frameleafCloud.signIn = { ...config.frameleafCloud.signIn, showOnLocalLogin: dto.showOnLocalLogin };
    });
    await this.eventRepository.emit('ConfigUpdate', { oldConfig, newConfig });
    this.logger.log(`Sign in with Frameleaf at home turned ${dto.showOnLocalLogin ? 'on' : 'off'} by ${auth.user.id}`);
    return this.getStatus();
  }

  /**
   * Cloud-side revoke or local unlink: clear the credential and cached tokens, mark the link, and
   * switch remote access, cloud processing and cloud backup off. Nothing local is deleted.
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
    const { oldConfig, newConfig } = await this.updateConfigExclusively((config) => {
      config.frameleafCloud.cloudMl.enabled = false;
      // FL-158: the sign-in client is gone with the link, and no secret of it remains here
      config.frameleafCloud.signIn = { ...config.frameleafCloud.signIn, clientSecret: '' };
    });
    if (!isEqual(oldConfig.frameleafCloud, newConfig.frameleafCloud)) {
      await this.eventRepository.emit('ConfigUpdate', { oldConfig, newConfig });
    }
    await this.endFrameleafSignIns();
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
        await this.saveLink({ ...current, lastError: `The link token did not work: ${message}` }, 'link');
      }
    });
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
      bootId: BOOT_ID,
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
      if (this.isRevocation(error)) {
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
    if (response.entitlementsChanged && permissionsOf(next).allowEntitlementRefresh) {
      await this.jobRepository.queue({ name: JobName.FrameleafLicenseRefresh, data: { force: true } });
    }
    await this.removeRetiredKey();
    await this.saveLink(next, 'link');
    return JobStatus.Success;
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

  /** A token or check-in refusal that means the cloud ended this server's link. */
  private isRevocation(error: unknown): boolean {
    if (!(error instanceof FrameleafCloudError) || (error.status !== 401 && error.status !== 403)) {
      return false;
    }
    const code = error.oauth?.error ?? error.envelope?.code ?? '';
    return ['invalid_client', 'instance-revoked', 'instance_revoked'].includes(code);
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
        // no client secret is kept: tokens come from the key, so dropping cached tokens is the rotation
        this.frameleafCloudRepository.forget();
        return link;
      }
      case CloudCommandType.KeyRotate: {
        await this.rotateKey(cloudUrl, document, link);
        return link;
      }
      case CloudCommandType.Relink: {
        this.notify({
          level: NotificationLevel.Warning,
          title: 'Link this server to Frameleaf again',
          description:
            'Frameleaf Cloud asked for this server to be linked again. Open Settings → Frameleaf Cloud → Account & link, unlink and link again. Nothing on this server is removed.',
          dedupeKey: 'frameleaf-cloud:relink',
          dedupeDays: 1,
        });
        return {
          ...link,
          heartbeat: { ...link.heartbeat, failures: link.heartbeat?.failures ?? 0, relinkRequested: true },
        };
      }
    }
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
    );
    this.frameleafCloudRepository.forget();
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafInstance, rotated);
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
    return { name: config.server.name?.trim() || 'Frameleaf server', externalDomain: config.server.externalDomain };
  }

  /** Public origins the Sign in with Frameleaf callbacks are registered on. */
  private async publicOrigins(services: Record<string, unknown>): Promise<string[]> {
    const { externalDomain } = await this.serverIdentity();
    const origins: string[] = [];
    for (const value of [services.relayOrigin, services.publicUrl, externalDomain]) {
      if (typeof value === 'string' && value) {
        origins.push(value);
      }
    }
    return origins;
  }

  private platform() {
    return `${platform()}/${arch()}`;
  }

  private after(now: number, seconds: number) {
    return new Date(now + seconds * 1000).toISOString();
  }
}
