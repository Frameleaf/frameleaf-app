import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { FrameleafLicense, FrameleafLicenseStore } from 'src/types.js';
import { FRAMELEAF_LICENSE_KEYS } from 'src/constants.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  LicenseActivateDto,
  LicenseCertificateDto,
  LicenseProductsResponseDto,
  LicenseStatusResponseDto,
} from 'src/dtos/frameleaf-license.dto.js';
import { LicenseResponseDto } from 'src/dtos/license.dto.js';
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
  UserMetadataKey,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { CloudErrorCode, FrameleafCloudError, cloudErrorCode, storeAddress } from 'src/utils/frameleaf-cloud.js';
import {
  BUNDLED_PRICING,
  LicenseSigningKey,
  certificateKind,
  certificateProblem,
  checkLicenseKey,
  effectivePricing,
  entitlementFlags,
  isLicensed,
  licenseKeyProblem,
  licenseStatus,
  nextRefreshAt,
  verifyLicenseCertificate,
} from 'src/utils/frameleaf-license.js';
import { handlePromiseError } from 'src/utils/misc.js';

/**
 * Bundled price snapshots in US dollars, matching the prices Frameleaf Cloud records (owner decision,
 * 2026-09-25): a plan is $9.99 a month or $99.90 a year and includes 1 TB of cloud backup.
 */
export const LICENSE_PRODUCTS = Object.freeze([
  { id: 'cloud-monthly', kind: 'plan', period: 'month', priceUsd: 9.99 },
  { id: 'cloud-annual', kind: 'plan', period: 'year', priceUsd: 99.9 },
  { id: 'supporter-server', kind: 'supporter', period: 'one-time', priceUsd: 100 },
  { id: 'supporter-individual', kind: 'supporter', period: 'one-time', priceUsd: 25 },
  // AI credit presets (never discounted); the store also takes $20 to $500 (docs/ai-wallet.md)
  { id: 'credit-25', kind: 'credit', period: 'one-time', priceUsd: 25 },
  { id: 'credit-50', kind: 'credit', period: 'one-time', priceUsd: 50 },
  { id: 'credit-100', kind: 'credit', period: 'one-time', priceUsd: 100 },
] as const);

/** A plan includes this much cloud backup; more is sold in whole blocks at this rate per TB a month. */
export const CLOUD_BACKUP_PRICE = Object.freeze({ includedTb: 1, blockTb: 1, usdPerTbMonth: 9.99 });

/**
 * The bundled share taken off plans on a licensed server, used until Frameleaf Cloud publishes one
 * on a heartbeat. AI credit and extra backup blocks are never discounted (FL-156).
 */
export const LICENSED_DISCOUNT = BUNDLED_PRICING.licensedDiscountPercent / 100;

const certificateResponseSchema = z.object({
  certificate: z
    .string()
    .min(1)
    .max(64 * 1024),
  activationId: z.string().max(200).optional(),
});
/** FL-185: the complete current set, never empty: the plan certificate first, then one per key activation. */
const refreshResponseSchema = z.object({
  certificates: z
    .array(
      z
        .string()
        .min(1)
        .max(64 * 1024),
    )
    .min(1)
    .max(10),
});

/** FL-185: a refresh answer without a plan certificate is not one the contract allows. */
const REFRESH_WITHOUT_PLAN_MESSAGE = 'Frameleaf Cloud sent licence certificates without a plan certificate';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * FL-177: Frameleaf Cloud refused an activation because this server's ID is already registered
 * with a different identity key (409 `instance-id-taken`), usually after the key was replaced here.
 */
export const IDENTITY_KEY_MISMATCH_MESSAGE =
  'This server’s identity key does not match the one Frameleaf Cloud has registered for it. Link this server again from Settings → Frameleaf Cloud → Account & link, then activate the key.';

/** How long a signed activation from an unlinked server may be used (the token assertions' limit). */
const ACTIVATION_PROOF_TTL_SECONDS = 120;

/**
 * Frameleaf licence certificates replace the inherited product key (FL-156, CLD-003).
 *
 * - Certificates are verified only with the keys pinned in `FRAMELEAF_LICENSE_KEYS`.
 * - The supporter key and the Frameleaf Cloud plan are held separately, so each can be removed alone.
 * - A daily refresh keeps them current; while it fails they stay on in grace, then the cloud flags
 *   turn off. Local data and self-hosted features never depend on any of this.
 * - Personal supporter keys (`FL-I…`) live in `immich_fork.frameleaf_user_license`.
 */
@Injectable()
export class FrameleafLicenseService extends BaseService {
  /** The pinned signing keys; a spec may pin its own. */
  protected licenseKeys: readonly LicenseSigningKey[] = FRAMELEAF_LICENSE_KEYS;

  // ------------------------------------------------------------------ status

  async getStatus(now = Date.now()): Promise<LicenseStatusResponseDto> {
    const store = await this.readStore();
    const { cloudUrl, linked, link } = await readCloudLink(this.gatewayDeps());
    const identity = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafInstance);
    const key = store.key ? this.mapSlot(store.key, now) : null;
    const plan = store.plan ? this.mapSlot(store.plan, now) : null;
    const lead = plan ?? key;
    const leadLicense = store.plan ?? store.key;
    return {
      state: lead?.state ?? 'none',
      kind: lead?.kind ?? null,
      keyHint: key?.keyHint ?? null,
      expiresAt: lead?.expiresAt ?? null,
      graceUntil: lead?.graceUntil ?? null,
      fingerprint: {
        instanceId: (linked ? link?.instanceId : undefined) ?? identity?.instanceId ?? null,
        jkt: identity?.kid ?? null,
      },
      entitlements: entitlementFlags([store.key, store.plan], now),
      licensed: isLicensed(store, now),
      refresh: {
        refreshedAt: leadLicense?.refreshedAt ?? null,
        nextRefreshAt: leadLicense?.nextRefreshAt ?? null,
        lastError: leadLicense?.lastRefreshError ?? null,
      },
      offline: !!leadLicense && leadLicense.source === 'file',
      linked,
      configured: !!cloudUrl,
      key,
      plan,
    };
  }

  private mapSlot(license: FrameleafLicense, now: number) {
    const status = licenseStatus(license, now);
    return {
      state: status.state,
      kind: license.kind,
      source: license.source,
      keyHint: license.keyHint ?? null,
      activatedAt: license.verifiedAt,
      expiresAt: status.expiresAt?.toISOString() ?? null,
      graceUntil: status.graceUntil?.toISOString() ?? null,
      refreshedAt: license.refreshedAt ?? null,
    };
  }

  /**
   * `GET license/products`: bundled prices, the plan discount Frameleaf Cloud published that is in
   * effect by the server clock (else the bundled one) and the deployment's store. Makes no outbound
   * call.
   */
  async getProducts(): Promise<LicenseProductsResponseDto> {
    const storeUrl = await this.storeUrl();
    const pricing = effectivePricing(await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafPricing));
    return {
      currency: 'USD',
      pricesVersion: pricing.pricesVersion,
      licensedDiscount: pricing.licensedDiscountPercent / 100,
      storeUrl,
      products: LICENSE_PRODUCTS.map((product) => ({
        ...product,
        storeUrl: storeUrl ? `${storeUrl}?product=${encodeURIComponent(product.id)}` : null,
      })),
      credit: { minimumUsd: 20, maximumUsd: 500 },
      backup: { ...CLOUD_BACKUP_PRICE },
    };
  }

  /**
   * The store (FL-177, as-built decision #29): the one discovery names (`store`, on the account site),
   * as the link last recorded it or as this process already holds discovery, else `/store` on the
   * Frameleaf Cloud address this server was deployed with; none when that is unset. Either way it must
   * pass the cloud address rule. Nothing is fetched here.
   */
  private async storeUrl(): Promise<string | null> {
    const cloudUrl = this.configRepository.getEnv().frameleafCloud.url;
    if (!cloudUrl) {
      return null;
    }
    const { link } = await readCloudLink(this.gatewayDeps());
    const recorded = link?.cloudUrl === cloudUrl ? storeAddress(cloudUrl, link.store) : null;
    const held = storeAddress(cloudUrl, this.frameleafCloudRepository.peekDiscovery(cloudUrl)?.store);
    return recorded ?? held ?? `${cloudUrl}/store`;
  }

  // ------------------------------------------------------------------ server key and file

  /** `PUT admin/license/activate`: activate a server supporter key with Frameleaf Cloud. */
  async activate(auth: AuthDto, dto: LicenseActivateDto): Promise<LicenseStatusResponseDto> {
    const check = checkLicenseKey(dto.key);
    if (!check.valid) {
      throw new BadRequestException(licenseKeyProblem(check.reason));
    }
    if (check.kind !== 'server') {
      throw new BadRequestException(
        'This is a personal key. Activate it for your own account under Your preferences or Support Frameleaf.',
      );
    }
    const { certificate, activationId } = await this.activateWithCloud(check.key, {});
    const license = await this.verifyForStore(certificate, 'key', { keyHint: check.last4, activationId });
    const store = await this.readStore();
    await this.writeStore({ ...store, key: license });
    await this.audit(auth, AdminAuditAction.LicenseActivated, check.last4);
    return this.getStatus();
  }

  /** `PUT admin/license/certificate`: install an offline licence file for this server. */
  async installCertificate(auth: AuthDto, dto: LicenseCertificateDto): Promise<LicenseStatusResponseDto> {
    const certificate = this.certificateFromFile(dto.certificate);
    const license = await this.verifyForStore(certificate, 'file', {});
    if (license.kind === 'individual') {
      throw new BadRequestException('This licence is for one person. Activate it in your own settings.');
    }
    const store = await this.readStore();
    await this.writeStore(license.kind === 'plan' ? { ...store, plan: license } : { ...store, key: license });
    await this.audit(auth, AdminAuditAction.LicenseActivated, 'file');
    return this.getStatus();
  }

  /** `DELETE admin/license`: remove the supporter key, deactivating it with the cloud when reachable. */
  async removeKey(auth: AuthDto): Promise<LicenseStatusResponseDto> {
    const store = await this.readStore();
    if (!store.key) {
      throw new NotFoundException('This server has no licence key');
    }
    await this.deactivateWithCloud(store.key);
    await this.writeStore({ ...store, key: null });
    await this.audit(auth, AdminAuditAction.LicenseRemoved, store.key.keyHint ?? null);
    return this.getStatus();
  }

  /** `DELETE admin/license/plan`: remove the plan from this server; the subscription is untouched. */
  async removePlan(auth: AuthDto): Promise<LicenseStatusResponseDto> {
    const store = await this.readStore();
    if (!store.plan) {
      throw new NotFoundException('This server has no Frameleaf Cloud plan');
    }
    await this.writeStore({ ...store, plan: null });
    await this.audit(auth, AdminAuditAction.LicenseRemoved, 'plan');
    return this.getStatus();
  }

  /** `POST admin/license/refresh`: ask Frameleaf Cloud for current certificates now. */
  async refreshNow(): Promise<LicenseStatusResponseDto> {
    const store = await this.readStore();
    const { linked } = await readCloudLink(this.gatewayDeps());
    if (!linked) {
      throw new BadRequestException(
        store.key?.source === 'file' || store.plan?.source === 'file'
          ? 'This licence came from a file. Install a newer file to update it.'
          : 'Link this server to refresh its licence.',
      );
    }
    await this.databaseRepository.withLock(DatabaseLock.FrameleafLicenseRefresh, () => this.refresh(true));
    const after = await this.readStore();
    const error = after.plan?.lastRefreshError ?? after.key?.lastRefreshError;
    if (
      error &&
      after.plan?.refreshedAt === store.plan?.refreshedAt &&
      after.key?.refreshedAt === store.key?.refreshedAt
    ) {
      throw new ConflictException(error);
    }
    return this.getStatus();
  }

  // ------------------------------------------------------------------ daily refresh

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.cronRepository.create({
      name: 'frameleafLicenseRefresh',
      expression: '17 * * * *',
      onTick: () =>
        handlePromiseError(this.jobRepository.queue({ name: JobName.FrameleafLicenseRefresh, data: {} }), this.logger),
      start: true,
    });
  }

  @OnJob({ name: JobName.FrameleafLicenseRefresh, queue: QueueName.BackgroundTask })
  async handleRefresh({ force }: { force?: boolean } = {}): Promise<JobStatus> {
    return this.databaseRepository.withLock(DatabaseLock.FrameleafLicenseRefresh, async () => {
      const { linked } = await readCloudLink(this.gatewayDeps());
      if (linked) {
        await this.refresh(!!force);
      }
      await this.noticeStateChange();
      return JobStatus.Success;
    });
  }

  /**
   * Refresh every certificate that is due (or all, when forced) with `POST /v1/licenses/refresh`.
   * A failure is kept on the certificate; its state then moves into grace by itself.
   */
  private async refresh(force: boolean, now = Date.now()) {
    const store = await this.readStore();
    const due = (license: FrameleafLicense | null) =>
      !license?.nextRefreshAt || Date.parse(license.nextRefreshAt) <= now;
    if (!force && !due(store.key) && !due(store.plan) && (store.key || store.plan)) {
      return;
    }
    const { cloudUrl, link } = await readCloudLink(this.gatewayDeps());
    if (!cloudUrl || !link?.instanceId) {
      return;
    }
    try {
      const { document, token } = await this.apiToken(cloudUrl, link.instanceId);
      const response = await this.frameleafCloudRepository.requestJson(refreshResponseSchema, {
        method: 'POST',
        url: `${document.api.replace(/\/+$/, '')}/v1/licenses/refresh`,
        dpop: token,
        body: {
          instanceId: link.instanceId,
          certificates: [store.key, store.plan].filter(Boolean).map((license) => license!.claims.jti ?? null),
        },
      });
      // FL-185: the answer is the complete current set (the plan certificate first, then one per usable
      // key activation on this server, an empty plan certificate for an account without a plan), so it
      // replaces everything held here: a key certificate it leaves out is dropped, not kept to age out
      let plan: FrameleafLicense | null = null;
      let key: FrameleafLicense | null = null;
      for (const certificate of response.certificates) {
        const license = await this.verifyForStore(certificate, 'account', {}, now);
        switch (license.kind) {
          case 'plan': {
            plan ??= { ...license, source: store.plan?.source === 'file' ? 'file' : 'account' };
            break;
          }
          case 'server': {
            // this server holds one key certificate: the activation of the key it already holds, else the first
            const sameKey = !!store.key && store.key.claims.lic?.id === license.claims.lic?.id;
            if (!key || sameKey) {
              key = {
                ...license,
                source: 'key',
                keyHint: (sameKey ? store.key?.keyHint : undefined) ?? license.keyHint,
                activationId: sameKey ? store.key?.activationId : undefined,
              };
            }
            break;
          }
          case 'individual': {
            // a personal key is held per person (users/me/license), never as this server's certificate
            break;
          }
        }
      }
      if (!plan) {
        // malformed: keep what is held (it ages out through grace only if this persists) and retry in an hour
        throw new BadRequestException(REFRESH_WITHOUT_PLAN_MESSAGE);
      }
      if (store.key && !key) {
        this.logger.log(
          'Frameleaf Cloud no longer lists the key activation on this server; its certificate is removed',
        );
      }
      const stamp = (license: FrameleafLicense | null) =>
        license && { ...license, refreshedAt: new Date(now).toISOString(), lastRefreshError: undefined };
      await this.writeStore({ ...store, key: stamp(key), plan: stamp(plan) });
    } catch (error) {
      const message =
        error instanceof FrameleafCloudError || error instanceof BadRequestException ? error.message : String(error);
      this.logger.warn(`Frameleaf licence refresh failed: ${message}`);
      const retry = new Date(now + 60 * 60 * 1000).toISOString();
      const fail = (license: FrameleafLicense | null) =>
        license ? { ...license, lastRefreshError: message, nextRefreshAt: retry } : license;
      await this.writeStore({ ...store, key: fail(store.key), plan: fail(store.plan) });
    }
  }

  /** Tell administrators once when the licence enters grace and once when it expires. */
  private async noticeStateChange(now = Date.now()) {
    const store = await this.readStore();
    const lead = store.plan ?? store.key;
    if (!lead) {
      return;
    }
    const { state, graceUntil } = licenseStatus(lead, now);
    if (state !== 'active' && state !== 'grace' && state !== 'expired') {
      return;
    }
    if (store.noticeState === state) {
      return;
    }
    await this.writeStore({ ...store, noticeState: state });
    if (state === 'grace') {
      await this.eventRepository.emit('AdminNotify', {
        type: NotificationType.SystemMessage,
        level: NotificationLevel.Warning,
        title: 'Your Frameleaf Cloud renewal did not go through',
        description: `Remote access and cloud backup keep working until ${graceUntil?.toISOString().slice(0, 10)}. Update your payment method in your Frameleaf account to avoid a pause. Local features are not affected.`,
        dedupeKey: `frameleaf-license:grace:${lead.claims.jti ?? lead.kid}`,
        dedupeDays: 30,
      });
    } else if (state === 'expired') {
      await this.eventRepository.emit('AdminNotify', {
        type: NotificationType.SystemMessage,
        level: NotificationLevel.Error,
        title: 'Your Frameleaf Cloud plan has ended',
        description:
          'Remote access and cloud backup are paused. Everything else on this server, including every photo, keeps working.',
        dedupeKey: `frameleaf-license:expired:${lead.claims.jti ?? lead.kid}`,
        dedupeDays: 30,
      });
    }
  }

  // ------------------------------------------------------------------ personal supporter keys

  /** `GET users/me/license`: the person's own supporter key. */
  async getUserSupporter(auth: AuthDto): Promise<LicenseResponseDto> {
    const row = await this.frameleafUserLicenseRepository.get(auth.user.id);
    if (!row) {
      throw new NotFoundException();
    }
    return { kind: 'individual', keyHint: row.keyHint, activatedAt: row.activatedAt };
  }

  /** `PUT users/me/license`: activate a personal supporter key (`FL-I…`) for this account. */
  async activateUserSupporter(auth: AuthDto, dto: LicenseActivateDto): Promise<LicenseResponseDto> {
    const check = checkLicenseKey(dto.key);
    if (!check.valid) {
      throw new BadRequestException(licenseKeyProblem(check.reason));
    }
    if (check.kind !== 'individual') {
      throw new BadRequestException(
        'This is a server key. An administrator activates it under Frameleaf Cloud → Licence.',
      );
    }
    const keySha256 = sha256(check.key);
    const existing = await this.frameleafUserLicenseRepository.getByKeyHash(keySha256);
    if (existing && existing.userId !== auth.user.id) {
      throw new ConflictException('This key is already active for another account on this server.');
    }
    const identity = await loadInstanceIdentity(this.gatewayDeps());
    const binding = sha256(`${identity.instanceId}${auth.user.id}`);
    const { certificate, activationId } = await this.activateWithCloud(check.key, { user: binding });
    const license = await this.verifyForStore(certificate, 'key', { keyHint: check.last4, activationId });
    if (license.kind !== 'individual') {
      throw new BadRequestException('Frameleaf Cloud returned a licence that is not a personal one.');
    }
    const row = await this.frameleafUserLicenseRepository.upsert({
      userId: auth.user.id,
      keyHint: check.last4,
      keySha256,
      binding,
      certificate,
      activationId: activationId ?? null,
    });
    await this.userRepository.upsertMetadata(auth.user.id, {
      key: UserMetadataKey.License,
      value: { kind: 'individual', keyHint: row.keyHint, activatedAt: new Date(row.activatedAt).toISOString() },
    });
    return { kind: 'individual', keyHint: row.keyHint, activatedAt: row.activatedAt };
  }

  /** `DELETE users/me/license`: remove the person's key; deactivated with the cloud when reachable. */
  async removeUserSupporter(auth: AuthDto): Promise<void> {
    const row = await this.frameleafUserLicenseRepository.get(auth.user.id);
    if (row) {
      await this.deactivateWithCloud(null, { activationId: row.activationId, user: row.binding });
      await this.frameleafUserLicenseRepository.delete(auth.user.id);
    }
    await this.userRepository.deleteMetadata(auth.user.id, UserMetadataKey.License);
  }

  /** A removed account takes its supporter key row with it (the fork table has no foreign key). */
  @OnEvent({ name: 'UserDelete' })
  async onUserDelete({ id }: ArgOf<'UserDelete'>) {
    try {
      await this.frameleafUserLicenseRepository.delete(id);
    } catch (error) {
      this.logger.warn(`Could not remove the supporter key of a removed account: ${error}`);
    }
  }

  // ------------------------------------------------------------------ helpers

  /**
   * `POST /v1/licenses/activate {key, fingerprint {instanceId, jkt}, instanceName}`. A linked server
   * sends it as JSON with its instance token. An unlinked server has no token, so the body travels as
   * a compact JWS signed by this server's identity key (`application/jose`, header `jwk` = the public
   * key and `kid` = its thumbprint, the `jkt`),
   * with `aud` (the activation address), `iat`, `exp` and `jti` so a copy cannot be replayed; the
   * cloud binds the certificate to that key (FL-177, as-built decision #28).
   */
  private async activateWithCloud(key: string, extra: { user?: string }) {
    const { cloudUrl, linked, link } = await readCloudLink(this.gatewayDeps());
    if (!cloudUrl) {
      throw new BadRequestException(
        'Frameleaf Cloud is not set up on this server. Install a licence file from your Frameleaf account instead.',
      );
    }
    const identity = await loadInstanceIdentity(this.gatewayDeps());
    const instanceId = (linked && link?.instanceId) || identity.instanceId;
    const config = await this.getConfig({ withCache: true });
    try {
      const api = linked ? await this.apiToken(cloudUrl, instanceId) : null;
      const document = api?.document ?? (await this.frameleafCloudRepository.discovery(cloudUrl));
      const url = `${document.api.replace(/\/+$/, '')}/v1/licenses/activate`;
      // one key snapshot names the key in the fingerprint and signs the request: the DPoP token's key
      // when linked (FL-178), else the key that signs the activation JWS (FL-177 review)
      const signer = api?.token.signer ?? this.instanceIdentityRepository.currentSigner();
      const body = {
        key,
        fingerprint: { instanceId, jkt: signer.kid, ...extra },
        instanceName: config.server.name?.trim() || 'Frameleaf server',
      };
      if (api) {
        return await this.frameleafCloudRepository.requestJson(certificateResponseSchema, {
          method: 'POST',
          url,
          dpop: api.token,
          body,
        });
      }
      const issuedAt = Math.floor(Date.now() / 1000);
      // the header carries the public key (`jwk`) beside its thumbprint (`kid`): the cloud holds no key
      // for a server that was never linked, so it verifies against the header key (FL-177 review). This
      // is not a DPoP proof: an unlinked server has no instance token.
      const proof = this.instanceIdentityRepository.signJwsWithPublicKey(
        { ...body, aud: url, iat: issuedAt, exp: issuedAt + ACTIVATION_PROOF_TTL_SECONDS, jti: randomUUID() },
        { signer },
      );
      return await this.frameleafCloudRepository.requestJson(certificateResponseSchema, {
        method: 'POST',
        url,
        raw: { contentType: 'application/jose', body: proof },
      });
    } catch (error) {
      if (cloudErrorCode(error) === CloudErrorCode.InstanceIdTaken) {
        // FL-177: this server's ID is registered with Frameleaf Cloud under another identity key
        throw new ConflictException(IDENTITY_KEY_MISMATCH_MESSAGE);
      }
      if (error instanceof FrameleafCloudError) {
        throw error.status !== null && error.status < 500
          ? new BadRequestException(error.message || 'Frameleaf Cloud did not accept this key.')
          : new ConflictException(`Frameleaf Cloud could not be reached: ${error.message}`);
      }
      throw error;
    }
  }

  /** `POST /v1/licenses/deactivate`, best effort: removing a key locally never waits on the cloud. */
  private async deactivateWithCloud(
    license: FrameleafLicense | null,
    extra: { activationId?: string | null; user?: string } = {},
  ) {
    const { cloudUrl, linked, link } = await readCloudLink(this.gatewayDeps());
    if (!cloudUrl) {
      return;
    }
    try {
      const identity = await loadInstanceIdentity(this.gatewayDeps());
      const instanceId = (linked && link?.instanceId) || identity.instanceId;
      const api = linked ? await this.apiToken(cloudUrl, instanceId) : null;
      const document = api?.document ?? (await this.frameleafCloudRepository.discovery(cloudUrl));
      await this.frameleafCloudRepository.requestJson(z.unknown(), {
        method: 'POST',
        url: `${document.api.replace(/\/+$/, '')}/v1/licenses/deactivate`,
        dpop: api?.token,
        body: {
          activationId: extra.activationId ?? license?.activationId ?? null,
          licenseId: license?.claims.lic?.id ?? null,
          fingerprint: { instanceId, ...(extra.user && { user: extra.user }) },
        },
      });
    } catch (error) {
      this.logger.warn(`Frameleaf Cloud was not told about the removed licence: ${error}`);
    }
  }

  /** Verify a certificate for this server and shape what is stored. */
  private async verifyForStore(
    certificate: string,
    source: FrameleafLicense['source'],
    extra: { keyHint?: string; activationId?: string },
    now = Date.now(),
  ): Promise<FrameleafLicense> {
    const identity = await loadInstanceIdentity(this.gatewayDeps());
    const { linked, link } = await readCloudLink(this.gatewayDeps());
    const instanceIds = [...new Set([linked ? link?.instanceId : undefined, identity.instanceId].filter(Boolean))];
    let result: ReturnType<typeof verifyLicenseCertificate> = { ok: false, reason: 'instance' };
    for (const instanceId of instanceIds) {
      result = verifyLicenseCertificate(certificate, {
        keys: this.licenseKeys,
        instanceId: instanceId!,
        accountId: linked ? link?.accountId : null,
        jkt: identity.kid,
        now,
      });
      if (result.ok || result.reason !== 'instance') {
        break;
      }
    }
    if (!result.ok) {
      throw new BadRequestException(certificateProblem(result.reason));
    }
    return {
      certificate: certificate.trim(),
      kind: certificateKind(result.claims),
      source,
      kid: result.kid,
      keyHint: extra.keyHint ?? result.claims.lic?.last4,
      activationId: extra.activationId,
      claims: result.claims,
      verifiedAt: new Date(now).toISOString(),
      nextRefreshAt: nextRefreshAt(result.claims).toISOString(),
    };
  }

  /** A licence file is the certificate itself, or JSON holding it as `certificate`. */
  private certificateFromFile(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { certificate?: unknown };
        if (typeof parsed.certificate === 'string') {
          return parsed.certificate;
        }
      } catch {
        // fall through to the plain refusal
      }
      throw new BadRequestException('This is not a Frameleaf licence file.');
    }
    return trimmed;
  }

  /** A DPoP-bound instance token for the cloud API, minted with this server's current key (FL-178). */
  private async apiToken(cloudUrl: string, instanceId: string) {
    const document = await this.frameleafCloudRepository.discovery(cloudUrl);
    await loadInstanceIdentity(this.gatewayDeps());
    const token = await this.frameleafCloudRepository.accessToken(
      document,
      instanceId,
      document.api,
      this.instanceIdentityRepository.currentSigner(),
    );
    return { document, token };
  }

  private async readStore(): Promise<FrameleafLicenseStore> {
    return (await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafLicense)) ?? { key: null, plan: null };
  }

  private async writeStore(store: FrameleafLicenseStore) {
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafLicense, store);
    try {
      for (const admin of await this.userRepository.getAdmins()) {
        this.websocketRepository.clientSend('on_frameleaf_cloud', admin.id, { topic: 'license' });
      }
    } catch (error) {
      this.logger.warn(`Could not tell administrators about a licence change: ${error}`);
    }
  }

  private async audit(auth: AuthDto, action: AdminAuditAction, detail: string | null) {
    await this.recordAdminEvents([
      { userId: auth.user.id, actorId: auth.user.id, action, subject: auth.user.name, detail },
    ]);
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
}
