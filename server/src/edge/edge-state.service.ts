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
import { type EdgeCertificateKind, EdgeCertificateRepository } from 'src/edge/edge-certificate.repository.js';
import { EdgeDirectService } from 'src/edge/edge-direct.service.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { DatabaseLock, NotificationLevel, NotificationType, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { getConfig } from 'src/utils/config.js';
import { identityDirectory, loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { FrameleafDiscoveryDocument } from 'src/utils/frameleaf-cloud.js';
import { FrameleafInstanceToken } from 'src/utils/frameleaf-dpop.js';
import { entitlementFlags } from 'src/utils/frameleaf-license.js';
import {
  ACME_ACCOUNT_URI,
  DNS_TXT_TIMEOUT_MS,
  EDGE_POLL_MS,
  LETS_ENCRYPT_DIRECTORY,
  TEARDOWN_MS,
  buildCandidates,
  certificateFacts,
  certificateReport,
  challengeRecordName,
  dnsTxtPutResponseSchema,
  enrollResponseSchema,
  enrollmentProblem,
  nextRenewalCheck,
  remoteEndpoints,
  renewalDue,
  retryDelayMs,
  verifiedCustomHost,
  wildcardNames,
} from 'src/utils/frameleaf-remote-access.js';

type RemoteSettings = SystemConfig['frameleafCloud']['remoteAccess'];

/** Discovery and an instance token, fetched only when a pass needs the cloud. */
type CloudSession = { document: FrameleafDiscoveryDocument; token: FrameleafInstanceToken };

/** What remote access should be doing right now, decided without any network call. */
export type EdgeDesired =
  | {
      serve: false;
      status: 'off' | 'idle';
      reason: string;
      removeCertificates: boolean;
      link: FrameleafCloudLink | null;
    }
  | { serve: true; cloudUrl: string; link: FrameleafCloudLink & { instanceId: string }; settings: RemoteSettings };

/** An enrolment is refreshed (it is idempotent and heals the cloud's records) once a day. */
const ENROLL_REFRESH_MS = 24 * 60 * 60 * 1000;
/** A failed enrolment is retried after 5 minutes, doubling up to an hour. */
const ENROLL_RETRY_FIRST_MS = 5 * 60 * 1000;
const ENROLL_RETRY_MAX_MS = 60 * 60 * 1000;
/** A certificate report that failed is sent again after this long. */
const REPORT_RETRY_MS = 10 * 60 * 1000;
/** When the cloud's name servers do not serve a challenge value yet, wait this long before validating. */
const PROPAGATION_WAIT_MS = 30 * 1000;
/** Without a change, the state is written again this often, so the API sees the edge worker is alive. */
const STATE_REFRESH_MS = 20 * 1000;
/** The notice administrators get when a certificate cannot be issued or renewed. */
const CERTIFICATE_NOTICE_KEY = 'frameleaf-remote:certificate';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The edge worker's desired-state loop (FL-165, CLD-102). Every 10 seconds it reads what remote access
 * should be doing and makes it so:
 *
 * - Exactly one edge worker serves: the one holding `DatabaseLock.FrameleafEdge`. Any other stays idle.
 * - Without `FRAMELEAF_CLOUD_URL`, a link, an active or grace remote access entitlement and
 *   `frameleafCloud.remoteAccess.enabled`, it serves nothing and makes no network call. Turning remote
 *   access off or unlinking closes the listener and removes the certificates and their keys; a lapsed
 *   entitlement only closes the listener.
 * - Otherwise it enrols (`POST /v1/remote/enroll`), keeps the wildcard certificate (and the verified
 *   custom hostname's) issued and renewed through ACME DNS-01 and the cloud's TXT API, reports each
 *   certificate's facts (`POST /v1/remote/certs`), pins the CAA record to its ACME account, and serves
 *   the direct listener.
 * - It writes what it is doing to `SystemMetadataKey.FrameleafRemoteAccess` for the API: never a key.
 * - On shutdown every socket closes within 5 seconds.
 */
@Injectable()
export class EdgeStateService {
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | null = null;
  private stopped = false;
  private holdsLock = false;
  private readonly bootId = randomUUID();
  private served: string | null = null;
  private lastWritten: { state: Omit<FrameleafRemoteAccess, 'updatedAt' | 'lastTest'>; at: number } | null = null;
  private enrollRetry: { at: number; failures: number } | null = null;
  private reportAttempts = new Map<EdgeCertificateKind, number>();
  /** Specs replace the waits. */
  wait = (ms: number) => sleep(ms);

  constructor(
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
    private databaseRepository: DatabaseRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private instanceIdentityRepository: InstanceIdentityRepository,
    private frameleafCloudRepository: FrameleafCloudRepository,
    private forkSchemaRepository: ForkSchemaRepository,
    private userRepository: UserRepository,
    private notificationRepository: NotificationRepository,
    private certificates: EdgeCertificateRepository,
    private direct: EdgeDirectService,
    private proxy: EdgeProxyService,
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
    await this.direct.stop(Math.max(250, timeoutMs - (Date.now() - started)));
    this.proxy.destroy();
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
        forkSchemaRepo: this.forkSchemaRepository,
      },
      { withCache: false },
    );
  }

  /** What remote access should be doing, from local state only. */
  async desired(): Promise<EdgeDesired> {
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
    if (!settings.enabled) {
      return { serve: false, status: 'off', reason: 'Remote access is off.', removeCertificates: true, link };
    }
    const licenses = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafLicense);
    if (!entitlementFlags([licenses?.key, licenses?.plan]).remoteAccess) {
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

  private async reconcile(now: number) {
    if (!this.holdsLock) {
      this.holdsLock = await this.databaseRepository.tryLock(DatabaseLock.FrameleafEdge);
      if (!this.holdsLock) {
        // another edge worker serves remote access
        return;
      }
      this.logger.log('This edge worker serves remote access');
    }

    const previous = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafRemoteAccess);
    const desired = await this.desired();
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
    if (this.direct.listening) {
      await this.direct.stop();
      this.served = null;
    }
    if (desired.removeCertificates && (previous?.certificate || previous?.customCertificate || !previous)) {
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
      reason: null,
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
    if (wildcard.pair && Date.parse(wildcard.facts?.notAfter ?? '') > now) {
      const signature = JSON.stringify([
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
        });
        this.served = signature;
      }
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
    state.candidates = buildCandidates({
      enrollment,
      settings,
      listenPort: this.listenPort(),
      ...this.addresses(),
      trustedLanCidrs: this.configRepository.getEnv().frameleafCloud.trustedLanCidrs,
    });
    if (state.status === 'starting' && this.direct.listening) {
      state.status = 'ready';
    }
    await this.writeState(state, now);
  }

  private async stopServing() {
    if (this.direct.listening) {
      await this.direct.stop();
    }
    this.served = null;
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
    const fresh =
      current &&
      current.instanceId === desired.link.instanceId &&
      current.cloudUrl === desired.cloudUrl &&
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
    const directoryUrl =
      this.configRepository.getEnv().frameleafCloud.edge.acmeDirectoryUrl ?? LETS_ENCRYPT_DIRECTORY;

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

  private listenPort() {
    return this.configRepository.getEnv().frameleafCloud.edge.port;
  }

  /**
   * The addresses LAN candidates are built from: `FRAMELEAF_LOCAL_URL`'s address when it is one (the
   * address the home network knows this server by, behind Docker's bridge network too), else this
   * host's own interfaces.
   */
  private addresses(): { lanAddresses: string[]; ipv6Addresses: string[] } {
    const lanAddresses: string[] = [];
    const ipv6Addresses: string[] = [];
    const localUrl = this.configRepository.getEnv().frameleafCloud.localUrl;
    const localHost = localUrl ? new URL(localUrl).hostname : null;
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal) {
          continue;
        }
        if (entry.family === 'IPv4') {
          lanAddresses.push(entry.address);
        } else {
          ipv6Addresses.push(entry.address.split('%', 1)[0]);
        }
      }
    }
    if (localHost && isIP(localHost) === 4) {
      return { lanAddresses: [localHost], ipv6Addresses };
    }
    return { lanAddresses, ipv6Addresses };
  }

  /**
   * Write the state when it changed, or at least every 20 seconds while this worker serves. The
   * administrator's last self-check is kept as the API wrote it.
   */
  private async writeState(state: Omit<FrameleafRemoteAccess, 'updatedAt' | 'lastTest'>, now: number) {
    const unchanged = this.lastWritten && isEqual(this.lastWritten.state, state);
    if (unchanged && now - this.lastWritten!.at < STATE_REFRESH_MS) {
      return;
    }
    const current = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafRemoteAccess);
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafRemoteAccess, {
      ...state,
      updatedAt: new Date(now).toISOString(),
      ...(current?.lastTest && { lastTest: current.lastTest }),
    });
    this.lastWritten = { state, at: now };
  }
}
