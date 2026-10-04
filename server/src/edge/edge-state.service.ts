import { Injectable } from '@nestjs/common';
import { isEqual } from 'lodash-es';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import z from 'zod';
import type { SystemConfig } from 'src/config.js';
import type {
  FrameleafCloudLink,
  FrameleafEdgeCertificate,
  FrameleafEdgeIssuance,
  FrameleafRemoteAccess,
  FrameleafRemoteEnrollment,
} from 'src/types.js';
import { type BuddyRecoveryScope, buddyRecoveryHost, readBuddyRecovery } from 'src/edge/buddy-recovery.js';
import { type EdgeCertificateKind, EdgeCertificateRepository } from 'src/edge/edge-certificate.repository.js';
import { EdgeDirectService } from 'src/edge/edge-direct.service.js';
import { EdgePortMappingService } from 'src/edge/edge-port-mapping.service.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { type EdgeCloudSession, EdgeRelayService } from 'src/edge/edge-relay.service.js';
import { DatabaseLock, NotificationLevel, NotificationType, SystemMetadataKey } from 'src/enum.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository, type HeldLock } from 'src/repositories/database.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { getConfig } from 'src/utils/config.js';
import { identityDirectory, loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { entitlementFlags } from 'src/utils/frameleaf-license.js';
import { RELAY_NOTICE_AFTER_MS, wanProbeResponseSchema } from 'src/utils/frameleaf-relay.js';
import {
  ACME_ACCOUNT_URI,
  DNS_TXT_TIMEOUT_MS,
  EDGE_POLL_MS,
  LETS_ENCRYPT_DIRECTORY,
  TEARDOWN_MS,
  buildCandidates,
  certificateFacts,
  certificateMatchesKey,
  certificateReport,
  challengeRecordName,
  defaultRouteInterfaces,
  dnsTxtPutResponseSchema,
  enrollResponseSchema,
  enrollmentProblem,
  hostAddresses,
  inContainer,
  nextRenewalCheck,
  remoteEndpoints,
  renewalDue,
  retryDelayMs,
  verifiedCustomHost,
  wildcardNames,
} from 'src/utils/frameleaf-remote-access.js';
import { isHomeAddress } from 'src/utils/frameleaf-sign-in.js';

type RemoteSettings = SystemConfig['frameleafCloud']['remoteAccess'];

type CloudSession = EdgeCloudSession;

/** What remote access should be doing right now, decided without any network call. */
export type EdgeDesired =
  | {
      serve: false;
      status: 'off' | 'idle';
      reason: string;
      removeCertificates: boolean;
      link: FrameleafCloudLink | null;
    }
  | {
      serve: true;
      cloudUrl: string;
      link: FrameleafCloudLink & { instanceId: string };
      settings: RemoteSettings;
      buddyRecovery?: BuddyRecoveryScope;
      recoveryOnly?: true;
      buddyOnly?: true;
    };

/** An enrolment is refreshed (it is idempotent and heals the cloud's records) once a day. */
const ENROLL_REFRESH_MS = 24 * 60 * 60 * 1000;
/** A failed enrolment is retried after 5 minutes, doubling up to an hour. */
const ENROLL_RETRY_FIRST_MS = 5 * 60 * 1000;
const ENROLL_RETRY_MAX_MS = 60 * 60 * 1000;
/** A certificate report that failed is sent again after this long. */
const REPORT_RETRY_MS = 10 * 60 * 1000;
/** When the cloud's name servers do not serve a challenge value yet, wait this long before validating. */
const PROPAGATION_WAIT_MS = 30 * 1000;
/** An unverified WAN candidate is probed again after an hour; a verified one twice a day. */
const WAN_RETRY_MS = 60 * 60 * 1000;
const WAN_RECHECK_MS = 12 * 60 * 60 * 1000;
/** Without a change, the state is written again this often, so the API sees the edge worker is alive. */
const STATE_REFRESH_MS = 20 * 1000;
/** The notice administrators get when a certificate cannot be issued or renewed. */
const CERTIFICATE_NOTICE_KEY = 'frameleaf-remote:certificate';
/** The notice administrators get when the relay tunnel is down for 15 minutes (FL-166). */
const RELAY_NOTICE_KEY = 'frameleaf-remote:relay';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Whether this server is behind carrier-grade NAT: the router's own public address is a shared
 * (100.64.0.0/10) or private one, or not the address Frameleaf Cloud sees check-ins come from.
 */
export const carrierGradeNat = (routerIp: string | null, observedIp: string | null): boolean => {
  if (!routerIp || isIP(routerIp) !== 4) {
    return false;
  }
  const [a, b] = routerIp.split('.', 2).map(Number);
  if ((a === 100 && b >= 64 && b <= 127) || isHomeAddress(routerIp, [])) {
    return true;
  }
  return !!observedIp && isIP(observedIp) === 4 && observedIp !== routerIp;
};

/**
 * The edge worker's desired-state loop (FL-165, CLD-102). Every 10 seconds it reads what remote access
 * should be doing and makes it so:
 *
 * - Exactly one edge worker serves: the one holding `DatabaseLock.FrameleafEdge`. Any other stays idle.
 * - Without `FRAMELEAF_CLOUD_URL` or a link it serves nothing. Ordinary remote access also requires
 *   an active or grace entitlement and `frameleafCloud.remoteAccess.enabled`. A configured active
 *   Buddy pair may use the same paid transports with every request restricted to its vault. A
 *   readable Buddy pair may retain a recovery-only relay after lapse, using an existing enrollment.
 *   Without a Buddy pair, turning remote access off removes the certificates; lapse preserves them.
 * - Otherwise it enrols (`POST /v1/remote/enroll`), keeps the wildcard certificate (and the verified
 *   custom hostname's) issued and renewed through ACME DNS-01 and the cloud's TXT API, reports each
 *   certificate's facts (`POST /v1/remote/certs`), pins the CAA record to its ACME account, and serves
 *   the direct listener.
 * - It keeps the blind relay tunnel up (FL-166, `EdgeRelayService`) and tells administrators when there
 *   has been no tunnel for 15 minutes (once a day at most).
 * - It writes what it is doing to `SystemMetadataKey.FrameleafRemoteAccess` for the API: never a key.
 * - On shutdown every socket closes within 5 seconds.
 */
@Injectable()
export class EdgeStateService {
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | null = null;
  private stopped = false;
  private lock: HeldLock | null = null;
  private readonly bootId = randomUUID();
  private served: string | null = null;
  private servingMode: 'ordinary' | 'buddy' | 'recovery' = 'ordinary';
  private lastWritten: { state: Omit<FrameleafRemoteAccess, 'updatedAt'>; at: number } | null = null;
  private enrollRetry: { at: number; failures: number } | null = null;
  private reportAttempts = new Map<EdgeCertificateKind, number>();
  private relayNoticeAt = 0;
  /** Set once the migrations have run (see `schemaReady`). */
  private migrated = false;
  /** Specs replace the waits. */
  wait = (ms: number) => sleep(ms);

  constructor(
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
    private databaseRepository: DatabaseRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private instanceIdentityRepository: InstanceIdentityRepository,
    private frameleafCloudRepository: FrameleafCloudRepository,
    private forkSchemaRepository: AssetChecksumRepository,
    private userRepository: UserRepository,
    private notificationRepository: NotificationRepository,
    private certificates: EdgeCertificateRepository,
    private direct: EdgeDirectService,
    private proxy: EdgeProxyService,
    private relay: EdgeRelayService,
    private portMapping: EdgePortMappingService,
  ) {
    this.logger.setContext(EdgeStateService.name);
  }

  /** Start the loop: once now, then every 10 seconds. */
  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), EDGE_POLL_MS);
  }

  /** `AppShutdown`: stop the loop and close the listener and every connection within 5 seconds. */
  async shutdown(timeoutMs = TEARDOWN_MS): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    const started = Date.now();
    // a tick in progress (an ACME order can take a while) is not waited for past the deadline
    await Promise.race([this.running, sleep(Math.max(0, timeoutMs / 2)).then(() => {})]);
    await Promise.all([
      this.direct.stop(Math.max(250, timeoutMs - (Date.now() - started))),
      this.relay.stop(),
      this.portMapping.release(),
    ]);
    this.proxy.destroy();
    await this.lock?.release();
    this.lock = null;
  }

  /** One pass of the loop; a pass already running is not started twice. */
  tick(now = Date.now()): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    if (!this.running) {
      this.running = this.reconcile(now)
        .catch((error) => this.logger.error(`Remote access could not be updated: ${message(error)}`))
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  // ------------------------------------------------------------------ desired state

  private get gatewayDeps() {
    return {
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
    };
  }

  private settings() {
    return getConfig(
      {
        configRepo: this.configRepository,
        metadataRepo: this.systemMetadataRepository,
        logger: this.logger,
      },
      { withCache: false },
    );
  }

  /** What remote access should be doing, from local state only. */
  async desired(now = Date.now()): Promise<EdgeDesired> {
    const { cloudUrl, link, linked } = await readCloudLink(this.gatewayDeps);
    if (!cloudUrl) {
      return {
        serve: false,
        status: 'off',
        reason: 'Frameleaf Cloud is not set up on this server.',
        removeCertificates: true,
        link: null,
      };
    }
    if (!linked || !link?.instanceId) {
      return {
        serve: false,
        status: 'off',
        reason: 'Link this server to a Frameleaf account first.',
        removeCertificates: true,
        link: null,
      };
    }
    const config = await this.settings();
    const settings = config.frameleafCloud.remoteAccess;
    const buddyRecovery = await readBuddyRecovery(identityDirectory(this.configRepository), link.instanceId, now);
    const licenses = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafLicense);
    const paid = entitlementFlags([licenses?.key, licenses?.plan], now).remoteAccess;
    const ordinary = settings.enabled && paid;
    if (buddyRecovery) {
      const buddyOnly = !ordinary && paid && buddyRecovery.backupEnabled;
      return {
        serve: true,
        cloudUrl,
        link: link as FrameleafCloudLink & { instanceId: string },
        settings: buddyOnly ? { ...settings, mode: 'relay-and-direct' } : settings,
        buddyRecovery,
        ...(buddyOnly && { buddyOnly: true as const }),
        ...(!ordinary && !buddyOnly && { recoveryOnly: true as const }),
      };
    }
    if (!settings.enabled) {
      return { serve: false, status: 'off', reason: 'Remote access is off.', removeCertificates: true, link };
    }
    if (!ordinary) {
      return {
        serve: false,
        status: 'idle',
        reason: 'Remote access is included with a Frameleaf Cloud plan.',
        removeCertificates: false,
        link,
      };
    }
    return { serve: true, cloudUrl, link: link as FrameleafCloudLink & { instanceId: string }, settings };
  }

  /**
   * On a fresh install the API migrates while this worker starts: reading `system_metadata` before
   * that finishes fails (and every failed query is logged). Each pass waits for a boot that is
   * migrating (`DatabaseLock.Migrations`) and does nothing until the schema is there.
   */
  private async schemaReady(): Promise<boolean> {
    if (!this.migrated) {
      this.migrated = await this.databaseRepository.withLock(DatabaseLock.Migrations, () =>
        this.databaseRepository.isSchemaReady(),
      );
      if (!this.migrated) {
        this.logger.debug('Waiting for the database migrations before starting remote access');
      }
    }
    return this.migrated;
  }

  private async reconcile(now: number) {
    if (!(await this.schemaReady())) {
      return;
    }
    // the lock lives on a connection of its own; it is checked on every pass, and a lost connection
    // (the lock went with it) stops serving at once, before another edge worker can take over
    if (this.lock && !(await this.lock.verify())) {
      // the connection went (the pool retires connections too): take the lock again at once, and
      // stop serving only when another edge worker got it meanwhile
      this.lock = await this.databaseRepository.holdLock(DatabaseLock.FrameleafEdge);
      if (!this.lock) {
        this.logger.warn('This edge worker lost the edge lock; it stops serving remote access');
        await this.stopServing();
        return;
      }
    }
    if (!this.lock) {
      this.lock = await this.databaseRepository.holdLock(DatabaseLock.FrameleafEdge);
      if (!this.lock) {
        // another edge worker serves remote access
        return;
      }
      this.logger.log('This edge worker serves remote access');
    }

    const previous = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafRemoteAccess);
    const desired = await this.desired(now);
    if (!desired.serve) {
      await this.idle(desired, previous, now);
      return;
    }
    await this.serve(desired, previous, now);
  }

  // ------------------------------------------------------------------ idle

  private async idle(
    desired: Extract<EdgeDesired, { serve: false }>,
    previous: FrameleafRemoteAccess | null,
    now: number,
  ) {
    await this.stopServing();
    if (desired.removeCertificates) {
      // every pass: removing files that are already gone costs nothing, and a pair left by a crash goes too
      await this.certificates.remove(identityDirectory(this.configRepository));
    }
    // an enrolment belongs to the link it was made for
    const names =
      previous?.names && desired.link && previous.names.instanceId === desired.link.instanceId
        ? previous.names
        : undefined;
    await this.writeState(
      {
        status: desired.status,
        bootId: this.bootId,
        reason: desired.reason,
        ...(names && { names }),
        ...(!desired.removeCertificates && {
          certificate: previous?.certificate ?? null,
          customCertificate: previous?.customCertificate ?? null,
        }),
        relay: { connected: false },
        direct: { listening: false, port: this.listenPort(), mapping: null, cgnatSuspected: false },
        candidates: [],
      },
      now,
    );
  }

  // ------------------------------------------------------------------ serve

  private async serve(
    desired: Extract<EdgeDesired, { serve: true }>,
    previous: FrameleafRemoteAccess | null,
    now: number,
  ) {
    const mode = desired.recoveryOnly ? 'recovery' : desired.buddyOnly ? 'buddy' : 'ordinary';
    if (mode !== this.servingMode) {
      // The old ordinary tunnel must close before a possibly slow certificate renewal after lapse.
      await this.stopServing();
      this.servingMode = mode;
    }
    if (desired.recoveryOnly) {
      await this.serveRecovery(desired, previous, now);
      return;
    }
    const { settings } = desired;
    const base = {
      bootId: this.bootId,
      relay: { connected: false },
      direct: {
        listening: this.direct.listening,
        port: this.listenPort(),
        mapping: settings.portMapping ? null : { externalPort: settings.directPort, method: 'manual' as const },
        cgnatSuspected: false,
      },
      candidates: [],
    };

    if (!this.configRepository.getEnv().frameleafCloud.edge.secret) {
      // fail closed: without the secret the API refuses every proxied request
      await this.stopServing();
      await this.writeState(
        {
          ...base,
          status: 'error',
          reason: 'FRAMELEAF_EDGE_SECRET is missing, so remote access stays closed.',
          direct: { ...base.direct, listening: false },
        },
        now,
      );
      return;
    }

    let state: Omit<FrameleafRemoteAccess, 'updatedAt'> = {
      ...base,
      status: 'starting',
      reason: desired.buddyOnly ? 'Buddy Backup transport only. Ordinary remote access is off.' : null,
      names: previous?.names,
      acmeAccountUri: previous?.acmeAccountUri,
      certificate: previous?.certificate ?? null,
      certificateIssuance: previous?.certificateIssuance,
      customCertificate: previous?.customCertificate ?? null,
      customCertificateIssuance: previous?.customCertificateIssuance,
    };

    // enrolment: the label, names, relay assignment and CAA parameters
    const enrollment = await this.ensureEnrollment(desired, state.names, now).catch((error: unknown) => {
      const reason = `Frameleaf Cloud could not set up remote access: ${message(error)}`;
      state = { ...state, status: 'error', reason };
      return null;
    });
    if (!enrollment) {
      await this.writeState(state, now);
      return;
    }
    state.names = enrollment;
    this.proxy.configureRecovery(
      desired.buddyRecovery ? { ...desired.buddyRecovery, host: buddyRecoveryHost(enrollment) } : null,
      !!desired.buddyOnly,
    );
    const identityDir = identityDirectory(this.configRepository);
    const cloud = () => this.cloud(desired);

    // the wildcard certificate: *.<label>.<domain> and <label>.<domain>
    const wildcard = await this.keepCertificate({
      kind: 'wildcard',
      names: wildcardNames(enrollment),
      identityDir,
      enrollment,
      facts: state.certificate ?? null,
      issuance: state.certificateIssuance,
      cloud,
      now,
      onAccount: (accountUri) => {
        state.acmeAccountUri = accountUri;
      },
    });
    state.certificate = wildcard.facts;
    state.certificateIssuance = wildcard.issuance;
    if (wildcard.accountPinned) {
      state.names = { ...enrollment, caa: { ...enrollment.caa, accountUri: wildcard.accountPinned } };
    }

    // the custom hostname's certificate, once Frameleaf Cloud verified its records
    const customHost = verifiedCustomHost(settings);
    let custom: { host: string; certificate: string; key: string } | null = null;
    if (customHost) {
      const issuance =
        state.customCertificateIssuance?.host === customHost ? state.customCertificateIssuance : undefined;
      const result = await this.keepCertificate({
        kind: 'custom',
        names: [customHost],
        identityDir,
        enrollment: state.names,
        facts: state.customCertificate?.host === customHost ? state.customCertificate : null,
        issuance,
        cloud,
        now,
        onAccount: (accountUri) => {
          state.acmeAccountUri = accountUri;
        },
      });
      state.customCertificate = result.facts ? { ...result.facts, host: customHost } : null;
      state.customCertificateIssuance = { ...result.issuance, host: customHost };
      custom = result.pair ? { host: customHost, ...result.pair } : null;
    } else if (state.customCertificate || state.customCertificateIssuance) {
      await this.certificates.remove(identityDir, ['custom']);
      state.customCertificate = null;
      state.customCertificateIssuance = undefined;
    }

    // the direct listener, with the certificates in hand
    const addresses = this.addresses();
    const trustedLanCidrs = this.configRepository.getEnv().frameleafCloud.trustedLanCidrs;
    // only FRAMELEAF_LOCAL_URL's address, or on bare metal the default-route interface's (never a
    // container bridge that other containers, such as a TLS-passthrough proxy, share)
    const advertised = addresses.lanAddresses.filter((address) => isHomeAddress(address, trustedLanCidrs));
    if (this.stopped) {
      return;
    }
    if (wildcard.pair && Date.parse(wildcard.facts?.notAfter ?? '') > now) {
      const signature = JSON.stringify([
        advertised,
        wildcard.facts?.serial,
        custom?.host,
        state.customCertificate?.serial,
        settings.mode,
        enrollment.label,
        enrollment.domain,
      ]);
      if (signature !== this.served) {
        this.direct.configure({
          contexts: { wildcard: wildcard.pair, custom },
          enrollment,
          allowWan: settings.mode === 'relay-and-direct',
          advertised,
        });
        this.relay.configure({ contexts: { wildcard: wildcard.pair, custom }, enrollment });
        this.served = signature;
      }
      // the relay is the baseline path: it runs whatever the direct listener does
      await this.relay.ensure(
        {
          instanceId: desired.link.instanceId,
          linkKey: `${desired.link.instanceId}|${desired.link.linkedAt ?? ''}`,
          enrollment,
          cloud,
          ...(desired.buddyOnly && { buddyOnly: true }),
        },
        now,
      );
      try {
        await this.direct.start();
      } catch (error) {
        state.status = 'error';
        state.reason = `The direct listener could not start on port ${this.listenPort()}: ${message(error)}`;
      }
    } else {
      await this.stopServing();
      state.status = 'error';
      state.reason ??= wildcard.issuance.lastError
        ? `The certificate could not be issued: ${wildcard.issuance.lastError}`
        : 'Waiting for this server’s certificate.';
    }

    state.direct = { ...state.direct, listening: this.direct.listening };
    // the relay's status first: the router can take a while to answer and never holds it up
    state.relay = this.relay.status();
    const wan = await this.directConnect(desired, previous, state, advertised, now);
    await this.noticeRelayDown(state.relay, now);
    state.candidates = buildCandidates({
      relayConnected: state.relay.connected,
      publicIpv4: wan.publicIpv4,
      wanPort: wan.port,
      wanVerifiedUri: wan.verifiedUri,
      enrollment,
      settings,
      listenPort: this.listenPort(),
      ...addresses,
      ipv6Listening: this.ipv6Listening(),
      trustedLanCidrs,
    });
    if (state.status === 'starting' && this.direct.listening) {
      state.status = 'ready';
    }
    await this.writeState(state, now);
  }

  /** Recovery reuses an existing enrollment; it never obtains paid enrollment or enables direct access. */
  private async serveRecovery(
    desired: Extract<EdgeDesired, { serve: true }>,
    previous: FrameleafRemoteAccess | null,
    now: number,
  ) {
    if (this.direct.listening) {
      await this.direct.stop();
      this.served = null;
    }
    await this.portMapping.release();
    const enrollment = previous?.names;
    const recovery = desired.buddyRecovery;
    let state: Omit<FrameleafRemoteAccess, 'updatedAt'> = {
      bootId: this.bootId,
      status: 'idle',
      reason: 'Buddy Backup recovery only. Ordinary remote access is unavailable.',
      names: enrollment,
      certificate: previous?.certificate ?? null,
      certificateIssuance: previous?.certificateIssuance,
      acmeAccountUri: previous?.acmeAccountUri,
      relay: { connected: false },
      direct: { listening: false, port: this.listenPort(), mapping: null, cgnatSuspected: false },
      candidates: [],
    };
    if (
      !recovery ||
      !this.configRepository.getEnv().frameleafCloud.edge.secret ||
      !enrollment ||
      enrollment.instanceId !== desired.link.instanceId ||
      enrollment.cloudUrl !== desired.cloudUrl ||
      enrollment.linkedAt !== desired.link.linkedAt
    ) {
      await this.stopServing();
      await this.writeState(
        { ...state, reason: 'Buddy recovery needs an existing remote enrollment and edge secret.' },
        now,
      );
      return;
    }
    this.proxy.configureRecovery({ ...recovery, host: buddyRecoveryHost(enrollment) });
    const cloud = () => this.cloud(desired);
    // DNS-01, CAA and certificate reports remain available for an enrolled linked instance after lapse.
    // No enrollment request is made: a removed/suspended enrollment must be recovered in Cloud first.
    const wildcard = await this.keepCertificate({
      kind: 'wildcard',
      names: wildcardNames(enrollment),
      identityDir: identityDirectory(this.configRepository),
      enrollment,
      facts: state.certificate ?? null,
      issuance: state.certificateIssuance,
      cloud,
      now,
      onAccount: (accountUri) => {
        state.acmeAccountUri = accountUri;
      },
    });
    state = { ...state, certificate: wildcard.facts, certificateIssuance: wildcard.issuance };
    if (wildcard.accountPinned) {
      state.names = { ...enrollment, caa: { ...enrollment.caa, accountUri: wildcard.accountPinned } };
    }
    if (
      wildcard.pair &&
      Date.parse(wildcard.facts?.notBefore ?? '') <= now &&
      Date.parse(wildcard.facts?.notAfter ?? '') > now
    ) {
      const signature = JSON.stringify(['buddy-recovery', wildcard.facts?.serial, enrollment.label, enrollment.domain]);
      if (signature !== this.served) {
        this.relay.configure({ contexts: { wildcard: wildcard.pair }, enrollment });
        this.served = signature;
      }
      await this.relay.ensure(
        {
          instanceId: desired.link.instanceId,
          linkKey: `${desired.link.instanceId}|${desired.link.linkedAt ?? ''}`,
          enrollment,
          cloud,
          recovery,
        },
        now,
      );
      state.relay = this.relay.status();
    } else {
      await this.stopServing();
      state.reason = 'Buddy recovery is waiting for a valid remote certificate.';
    }
    await this.writeState(state, now);
  }

  /**
   * Direct connect (FL-167): in "Relay and direct" mode, keep the router's mapping (or take the
   * manual port), tell carrier-grade NAT from the router's and the check-in's public addresses, and
   * have Frameleaf Cloud probe the WAN name, which is published as verified only once the probe
   * reached it. Nothing here ever holds up the relay.
   */
  private async directConnect(
    desired: Extract<EdgeDesired, { serve: true }>,
    previous: FrameleafRemoteAccess | null,
    state: Omit<FrameleafRemoteAccess, 'updatedAt'>,
    advertised: string[],
    now: number,
  ): Promise<{ publicIpv4: string | null; port: number; verifiedUri: string | null }> {
    const { settings } = desired;
    const observedIp = desired.link.heartbeat?.observedIp ?? null;
    if (settings.mode !== 'relay-and-direct' || !this.direct.listening) {
      await this.portMapping.release();
      state.direct = {
        ...state.direct,
        mapping: null,
        externalIp: null,
        mappingError: null,
        guidance: null,
        wan: null,
      };
      return { publicIpv4: null, port: settings.directPort, verifiedUri: null };
    }

    let externalIp: string | null;
    if (settings.portMapping) {
      const internalHost = advertised.find((address) => isIP(address) === 4);
      if (!internalHost) {
        await this.portMapping.release();
      }
      const mapped = internalHost
        ? await this.portMapping.keep({
            internalHost,
            internalPort: this.listenPort(),
            externalPort: settings.directPort,
            now,
          })
        : null;
      externalIp = mapped?.externalIp ?? null;
      const noRouter = !mapped || mapped.noGateway;
      state.direct = {
        ...state.direct,
        mapping: mapped?.method ? { externalPort: mapped.externalPort!, method: mapped.method } : null,
        externalIp,
        mappingError: mapped ? mapped.error : 'This server does not know its address on the home network.',
        // in a container nothing reaches the router over the bridge network: say what to do instead
        guidance: noRouter && this.inContainer() ? 'bridge' : null,
        cgnatSuspected: carrierGradeNat(externalIp, observedIp),
      };
    } else {
      await this.portMapping.release();
      externalIp = observedIp;
      state.direct = {
        ...state.direct,
        mapping: { externalPort: settings.directPort, method: 'manual' },
        externalIp,
        mappingError: null,
        guidance: null,
        cgnatSuspected: false,
      };
    }

    const publicIpv4 =
      externalIp &&
      isIP(externalIp) === 4 &&
      !state.direct.cgnatSuspected &&
      (!!state.direct.mapping || !settings.portMapping)
        ? externalIp
        : null;
    // the port the router gave, which NAT-PMP may choose other than the one asked for
    const port = state.direct.mapping?.externalPort ?? settings.directPort;
    state.direct.wan = await this.probeWan(desired, previous?.direct.wan ?? null, publicIpv4, port, now);
    return {
      publicIpv4,
      port,
      verifiedUri:
        state.direct.wan?.verified && state.direct.wan.key === `${publicIpv4}:${port}` ? state.direct.wan.uri : null,
    };
  }

  /**
   * `POST /v1/remote/wan-probe {port}`: Frameleaf Cloud connects back to this server's public address
   * with its WAN name. Asked when the address or port changes, then hourly while unverified and twice
   * a day once verified (the cloud allows 10 an hour).
   */
  private async probeWan(
    desired: Extract<EdgeDesired, { serve: true }>,
    previous: NonNullable<FrameleafRemoteAccess['direct']['wan']> | null,
    publicIpv4: string | null,
    port: number,
    now: number,
  ): Promise<FrameleafRemoteAccess['direct']['wan']> {
    if (!publicIpv4) {
      return null;
    }
    const key = `${publicIpv4}:${port}`;
    const age = previous?.key === key ? now - Date.parse(previous.checkedAt) : Infinity;
    if (previous?.key === key && age < (previous.verified ? WAN_RECHECK_MS : WAN_RETRY_MS)) {
      return previous;
    }
    try {
      const { document, token } = await this.cloud(desired);
      const answer = await this.frameleafCloudRepository.requestJson(wanProbeResponseSchema, {
        method: 'POST',
        url: remoteEndpoints(document).wanProbe,
        dpop: token,
        body: { port },
      });
      if (answer.verified) {
        this.logger.log(`Frameleaf Cloud reached this server directly at ${answer.uri}`);
      }
      return {
        key,
        uri: answer.uri,
        verified: answer.verified,
        reason: answer.reason,
        checkedAt: new Date(now).toISOString(),
      };
    } catch (error) {
      this.logger.warn(`Frameleaf Cloud could not test direct connections: ${message(error)}`);
      return { key, uri: null, verified: false, reason: 'unreachable', checkedAt: new Date(now).toISOString() };
    }
  }

  private async stopServing() {
    // Deny every late arrival until a serving pass explicitly installs its next access policy.
    this.proxy.configureRecovery(null, true);
    // Close both admission paths before awaiting either listener's asynchronous drain.
    await Promise.all([
      this.relay.stop(),
      this.direct.listening ? this.direct.stop() : Promise.resolve(),
      this.portMapping.release(),
    ]);
    this.served = null;
  }

  /** "Relay disconnected": after 15 minutes without a tunnel while serving, once a day at most. */
  private async noticeRelayDown(relay: FrameleafRemoteAccess['relay'], now: number) {
    const since = relay.disconnectedSince ? Date.parse(relay.disconnectedSince) : NaN;
    if (relay.connected || !(now - since >= RELAY_NOTICE_AFTER_MS) || now - this.relayNoticeAt < 60 * 60 * 1000) {
      return;
    }
    // the stored notices are deduplicated for 24 hours; this only spares the lookup on every pass
    this.relayNoticeAt = now;
    const problem = relay.lastError ? ` The last problem was: ${relay.lastError}` : '';
    try {
      await this.notifyAdmins({
        title: 'Remote access relay disconnected',
        description:
          `This server has not been connected to the Frameleaf relay since ${relay.disconnectedSince}. ` +
          `It keeps trying; at home it works as before.${problem}`,
        dedupeKey: RELAY_NOTICE_KEY,
      });
    } catch (error) {
      this.logger.warn(`Could not notify administrators: ${message(error)}`);
    }
  }

  // ------------------------------------------------------------------ cloud

  /** Discovery and an instance token (DPoP-bound to this server's key), fetched only when needed. */
  private async cloud(desired: Extract<EdgeDesired, { serve: true }>): Promise<CloudSession> {
    const document = await this.frameleafCloudRepository.discovery(desired.cloudUrl);
    await loadInstanceIdentity(this.gatewayDeps);
    const token = await this.frameleafCloudRepository.accessToken(
      document,
      desired.link.instanceId,
      document.api,
      this.instanceIdentityRepository.currentSigner(),
    );
    return { document, token };
  }

  private async ensureEnrollment(
    desired: Extract<EdgeDesired, { serve: true }>,
    current: FrameleafRemoteEnrollment | undefined,
    now: number,
  ): Promise<FrameleafRemoteEnrollment | null> {
    // linked again: enrol again at once, which also gives the new sign-in client its relay address
    const fresh =
      current &&
      current.instanceId === desired.link.instanceId &&
      current.cloudUrl === desired.cloudUrl &&
      current.linkedAt === desired.link.linkedAt &&
      now - Date.parse(current.enrolledAt) < ENROLL_REFRESH_MS;
    if (fresh) {
      return current;
    }
    if (this.enrollRetry && this.enrollRetry.at > now) {
      if (current?.instanceId === desired.link.instanceId && current.cloudUrl === desired.cloudUrl) {
        // a refresh that failed keeps the enrolment it had
        return current;
      }
      throw new Error('enrolment failed; it is retried shortly');
    }
    try {
      const { document, token } = await this.cloud(desired);
      const answer = await this.frameleafCloudRepository.requestJson(enrollResponseSchema, {
        method: 'POST',
        url: remoteEndpoints(document).enroll,
        dpop: token,
        body: {},
      });
      const problem = enrollmentProblem(desired.link.instanceId, answer);
      if (problem) {
        throw new Error(problem);
      }
      this.enrollRetry = null;
      if (answer.cloneSuspected) {
        this.logger.warn('Frameleaf Cloud enrolled this server for remote access while it suspects a copy of it');
      }
      return {
        cloudUrl: desired.cloudUrl,
        instanceId: desired.link.instanceId,
        label: answer.label,
        domain: answer.domain,
        names: answer.names,
        relay: answer.relay,
        caa: answer.caa,
        certProfile: answer.certProfile,
        renewBeforeDays: answer.renewBeforeDays,
        cloneSuspected: answer.cloneSuspected,
        linkedAt: desired.link.linkedAt,
        enrolledAt: new Date(now).toISOString(),
      };
    } catch (error) {
      const failures = (this.enrollRetry?.failures ?? 0) + 1;
      this.enrollRetry = {
        failures,
        at: now + Math.min(ENROLL_RETRY_MAX_MS, ENROLL_RETRY_FIRST_MS * 2 ** (failures - 1)),
      };
      this.logger.warn(`Remote access enrolment failed: ${message(error)}`);
      if (current?.instanceId === desired.link.instanceId && current.cloudUrl === desired.cloudUrl) {
        return current;
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------ certificates

  /**
   * Keep one certificate current: read it, and issue it when it is missing, does not cover the names,
   * or is due for renewal at the daily check, unless a failure's retry time has not come yet.
   */
  async keepCertificate(input: {
    kind: EdgeCertificateKind;
    names: string[];
    identityDir: string;
    enrollment: FrameleafRemoteEnrollment;
    facts: FrameleafEdgeCertificate | null;
    issuance: FrameleafEdgeIssuance | undefined;
    cloud: () => Promise<CloudSession>;
    now: number;
    onAccount: (accountUri: string) => void;
  }): Promise<{
    pair: { certificate: string; key: string } | null;
    facts: FrameleafEdgeCertificate | null;
    issuance: FrameleafEdgeIssuance;
    accountPinned: string | null;
  }> {
    const { kind, names, identityDir, now } = input;
    let issuance: FrameleafEdgeIssuance = { failures: 0, ...input.issuance };
    let pair = await this.certificates.read(identityDir, kind);
    let facts: FrameleafEdgeCertificate | null = null;
    if (pair) {
      try {
        const read = certificateFacts(pair.certificate);
        // a crash between writing the key and the certificate leaves a pair that does not match
        if (!certificateMatchesKey(pair.certificate, pair.key)) {
          throw new Error('its key does not match');
        }
        const byName = (a: string, b: string) => a.localeCompare(b);
        const covers = isEqual(read.names.toSorted(byName), names.toSorted(byName));
        facts = covers
          ? { ...read, reported: !!input.facts && input.facts.serial === read.serial && input.facts.reported }
          : null;
      } catch (error) {
        this.logger.warn(`The ${kind} certificate could not be read and is issued again: ${message(error)}`);
      }
      if (!facts) {
        pair = null;
      }
    }

    const checkDue = !issuance.nextCheckAt || Date.parse(issuance.nextCheckAt) <= now;
    const needed = !facts || (checkDue && renewalDue(facts, now, input.enrollment.renewBeforeDays));
    if (checkDue && facts && !needed) {
      issuance = { ...issuance, nextCheckAt: nextRenewalCheck(now) };
    }
    const waiting = issuance.nextAttemptAt && Date.parse(issuance.nextAttemptAt) > now;

    let accountPinned: string | null = null;
    if (needed && !waiting) {
      try {
        const issued = await this.issue(input);
        await this.certificates.write(identityDir, kind, issued);
        pair = { certificate: issued.certificate, key: issued.key };
        facts = { ...certificateFacts(issued.certificate), reported: false };
        accountPinned = issued.accountPinned;
        this.reportAttempts.delete(kind);
        issuance = { failures: 0, lastAttemptAt: new Date(now).toISOString(), nextCheckAt: nextRenewalCheck(now) };
        this.logger.log(`Issued the ${kind} remote access certificate for ${names.join(', ')}`);
      } catch (error) {
        const failures = issuance.failures + 1;
        issuance = {
          ...issuance,
          failures,
          lastError: message(error),
          lastAttemptAt: new Date(now).toISOString(),
          nextAttemptAt: new Date(now + retryDelayMs(failures)).toISOString(),
        };
        this.logger.warn(
          `The ${kind} remote access certificate could not be issued (attempt ${failures}): ${message(error)}`,
        );
        await this.notifyCertificateProblem(kind, facts, issuance);
      }
    }

    // the Certificate Transparency baseline: every certificate obtained is reported, once
    const lastReport = this.reportAttempts.get(kind);
    if (facts && !facts.reported && (lastReport === undefined || now - lastReport >= REPORT_RETRY_MS)) {
      this.reportAttempts.set(kind, now);
      try {
        const { document, token } = await input.cloud();
        await this.frameleafCloudRepository.requestJson(z.unknown(), {
          method: 'POST',
          url: remoteEndpoints(document).certs,
          dpop: token,
          body: certificateReport(facts),
        });
        facts = { ...facts, reported: true };
      } catch (error) {
        this.logger.warn(`The ${kind} certificate could not be reported to Frameleaf Cloud yet: ${message(error)}`);
      }
    }

    return { pair, facts, issuance, accountPinned };
  }

  /** One ACME order through Frameleaf Cloud's TXT API, with the CAA record pinned to this server's account. */
  private async issue(input: {
    names: string[];
    identityDir: string;
    enrollment: FrameleafRemoteEnrollment;
    cloud: () => Promise<CloudSession>;
    onAccount: (accountUri: string) => void;
  }) {
    const { enrollment } = input;
    const { document, token } = await input.cloud();
    const endpoints = remoteEndpoints(document);
    const name = challengeRecordName(enrollment);
    let accountPinned: string | null = null;
    const directoryUrl = this.configRepository.getEnv().frameleafCloud.edge.acmeDirectoryUrl ?? LETS_ENCRYPT_DIRECTORY;

    const result = await this.certificates.issue(input.identityDir, {
      directoryUrl,
      names: input.names,
      profile: enrollment.certProfile,
      onAccount: async (accountUri) => {
        input.onAccount(accountUri);
        if (enrollment.caa.accountUri === accountUri || !ACME_ACCOUNT_URI.test(accountUri)) {
          return;
        }
        // the label's CAA names this server's ACME account, so no other account can be issued for it
        await this.frameleafCloudRepository.requestJson(z.unknown(), {
          method: 'PUT',
          url: endpoints.caa,
          dpop: token,
          body: { accountUri },
        });
        accountPinned = accountUri;
      },
      setChallenge: async (value) => {
        const answer = await this.frameleafCloudRepository.requestJson(dnsTxtPutResponseSchema, {
          method: 'PUT',
          url: endpoints.dnsTxt,
          dpop: token,
          body: { name, value },
          timeoutMs: DNS_TXT_TIMEOUT_MS,
        });
        if (!answer.propagated) {
          await this.wait(PROPAGATION_WAIT_MS);
        }
      },
      removeChallenge: async (value) => {
        await this.frameleafCloudRepository.requestJson(z.unknown(), {
          method: 'DELETE',
          url: endpoints.dnsTxt,
          dpop: token,
          body: { name, value },
        });
      },
    });
    return { ...result, accountPinned };
  }

  /**
   * Tell administrators once a day while a certificate keeps failing. The current certificate keeps
   * serving until it expires; the cloud never serves one in its place.
   */
  private async notifyCertificateProblem(
    kind: EdgeCertificateKind,
    facts: FrameleafEdgeCertificate | null,
    issuance: FrameleafEdgeIssuance,
  ) {
    const which = kind === 'wildcard' ? 'this server’s Frameleaf address' : 'your custom domain';
    const expires = facts ? ` The current certificate works until ${facts.notAfter.slice(0, 10)}.` : '';
    try {
      await this.notifyAdmins({
        title: 'Remote access certificate could not be renewed',
        description:
          `The certificate for ${which} could not be issued (${issuance.lastError}). ` +
          `It is retried automatically, next at ${issuance.nextAttemptAt}.${expires}`,
        dedupeKey: `${CERTIFICATE_NOTICE_KEY}:${kind}`,
      });
    } catch (error) {
      this.logger.warn(`Could not notify administrators: ${message(error)}`);
    }
  }

  /** The same deduplicated system notice the API sends (`NotificationService.notifyAdmins`), without the live push. */
  private async notifyAdmins(notice: { title: string; description: string; dedupeKey: string }) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const admin of await this.userRepository.getAdmins()) {
      if (await this.notificationRepository.findRecentByDedupeKey(admin.id, notice.dedupeKey, since)) {
        continue;
      }
      await this.notificationRepository.create({
        userId: admin.id,
        type: NotificationType.SystemMessage,
        level: NotificationLevel.Warning,
        title: notice.title,
        description: notice.description,
        data: { dedupeKey: notice.dedupeKey },
      });
    }
  }

  // ------------------------------------------------------------------ state

  /** Whether this worker runs in a container (Docker, Podman). Specs replace it. */
  inContainer = inContainer;

  /** Whether the listener takes IPv6 connections: bound to `::` or an IPv6 address. */
  private ipv6Listening() {
    const { bind } = this.configRepository.getEnv().frameleafCloud.edge;
    return bind === '::' || isIP(bind) === 6;
  }

  private listenPort() {
    return this.configRepository.getEnv().frameleafCloud.edge.port;
  }

  /**
   * The addresses LAN candidates are built from: `FRAMELEAF_LOCAL_URL`'s address when it is one (the
   * address the home network knows this server by, behind Docker's bridge network too), else this
   * host's own interfaces.
   */
  private addresses(): { lanAddresses: string[]; ipv6Addresses: string[] } {
    const interfaces = Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
      (entries ?? []).map(({ address, family, internal }) => ({ name, address, family, internal })),
    );
    return hostAddresses({
      localUrl: this.configRepository.getEnv().frameleafCloud.localUrl,
      inContainer: this.inContainer(),
      interfaces,
      defaultInterfaces: this.defaultInterfaces(),
    });
  }

  /** The interfaces the default routes use (Linux `/proc/net/route` and `ipv6_route`). Specs replace it. */
  defaultInterfaces = defaultRouteInterfaces;

  /** Write the state when it changed, or at least every 20 seconds, so the API sees the edge worker is alive. */
  private async writeState(state: Omit<FrameleafRemoteAccess, 'updatedAt'>, now: number) {
    const unchanged = this.lastWritten && isEqual(this.lastWritten.state, state);
    if (this.stopped || (unchanged && now - this.lastWritten!.at < STATE_REFRESH_MS)) {
      return;
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafRemoteAccess, {
      ...state,
      updatedAt: new Date(now).toISOString(),
    });
    this.lastWritten = { state, at: now };
  }
}
