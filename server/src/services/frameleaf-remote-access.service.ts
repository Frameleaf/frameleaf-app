import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import tls from 'node:tls';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { FrameleafCloudLink, FrameleafRemoteAccess, FrameleafRemoteAccessTest } from 'src/types.js';
import {
  RemoteAccessStatusResponseDto,
  RemoteAccessUpdateDto,
  RemoteAccessUsageResponseDto,
  RemoteHostnameUpdateDto,
} from 'src/dtos/frameleaf-remote-access.dto.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import {
  type RemoteHostname,
  customHostnameRecords,
  directDomainOf,
  edgeStateCurrent,
  hostnameProblem,
  hostnameStatus,
  ipv4Name,
  remoteAccessUnavailable,
  remoteEndpoints,
  remoteHostnameListSchema,
  remoteHostnameSchema,
  remoteLabel,
  remotePublicUrl,
  remoteUsageSchema,
  validateCustomHostname,
  verifiedCustomHost,
} from 'src/utils/frameleaf-remote-access.js';

/** Relay use is metered every minute, so a newer answer is never asked for sooner. */
const USAGE_FRESH_MS = 60_000;

/** The direct connection as the edge worker last saw it: the router, the address and Frameleaf Cloud's probe. */
const directCheck = (
  settings: { portMapping: boolean; directPort: number },
  state: FrameleafRemoteAccess | null,
  listening: boolean,
): ProbeResult => {
  const direct = state?.direct;
  if (!listening || !direct) {
    return { ok: false, detail: 'Not tried: the HTTPS listener is not running.' };
  }
  if (direct.cgnatSuspected) {
    return {
      ok: false,
      detail:
        'Your internet provider shares one public address between customers, so direct connections cannot reach this server. The relay is used instead.',
    };
  }
  if (direct.wan?.verified) {
    return { ok: true, detail: `Frameleaf Cloud reached this server directly at ${direct.wan.uri}` };
  }
  if (settings.portMapping && !direct.mapping) {
    return {
      ok: false,
      detail:
        direct.guidance === 'bridge'
          ? 'The router could not be reached from this container. Use host networking, or forward the port yourself.'
          : `The router did not open port ${settings.directPort}${direct.mappingError ? ` (${direct.mappingError})` : ''}.`,
    };
  }
  return {
    ok: false,
    detail: direct.wan
      ? `Frameleaf Cloud could not reach port ${settings.directPort} from the internet (${direct.wan.reason ?? 'unreachable'}).`
      : `Waiting for Frameleaf Cloud to test port ${settings.directPort}.`,
  };
};

/** The self-check gives the edge worker this long to answer through the direct listener. */
const PROBE_TIMEOUT_MS = 5000;

type ProbeResult = { ok: boolean; detail: string };

/**
 * Settings › Frameleaf Cloud › Remote access (FL-165, CLD-102): the switch, connection mode, direct
 * port and published address; the custom hostname (added to and checked by Frameleaf Cloud, which
 * verifies its two CNAME records; the certificate for it is issued here by the edge worker); and a
 * self-check of the direct listener. The edge worker does the serving; this reads what it reported.
 */
@Injectable()
export class FrameleafRemoteAccessService extends BaseService {
  /** The last relay use Frameleaf Cloud reported, for the instance it was asked for. */
  private usageCache?: { instanceId: string; at: number; usage: RemoteAccessUsageResponseDto };

  private get linkDeps() {
    return { configRepository: this.configRepository, systemMetadataRepository: this.systemMetadataRepository };
  }

  /** `GET admin/cloud/remote`: settings, what the edge worker reports, and the custom hostname. Local reads only. */
  async getStatus(now = Date.now(), problem: string | null = null): Promise<RemoteAccessStatusResponseDto> {
    const config = await this.getConfig({ withCache: false });
    const settings = config.frameleafCloud.remoteAccess;
    const unavailableReason = await remoteAccessUnavailable(this.linkDeps, now);
    const { cloudUrl, link, linked } = await readCloudLink(this.linkDeps);
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafRemoteAccess);
    const current = edgeStateCurrent(state, now);
    // an enrolment belongs to the link it was made for
    const names = linked && state?.names?.instanceId === link?.instanceId ? state?.names : undefined;

    let status: RemoteAccessStatusResponseDto['status'] = 'off';
    if (settings.enabled && !unavailableReason) {
      status = current && state ? state.status : 'unknown';
    } else if (current && state?.status === 'idle') {
      status = 'idle';
    }

    // the records to add need the label (from the instance id) and the direct domain in use
    const label = names?.label ?? (linked && link?.instanceId ? remoteLabel(link.instanceId) : null);
    const discovery = cloudUrl ? this.frameleafCloudRepository.peekDiscovery(cloudUrl) : null;
    const domain = directDomainOf(names, discovery);
    const host = settings.customHostname.host || null;
    const lastTest = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafRemoteAccessTest);

    return {
      unavailableReason,
      enabled: settings.enabled,
      mode: settings.mode,
      directPort: settings.directPort,
      portMapping: settings.portMapping,
      publicUrlChoice: settings.publicUrl,
      status,
      reason: status === 'unknown' ? 'Remote access is starting. This can take a minute.' : (state?.reason ?? null),
      publicUrl: settings.enabled && names ? remotePublicUrl(names, settings) : null,
      frameleafAddress: names ? `https://${names.names.relay}` : null,
      certificateName: state?.certificate?.names[0] ?? null,
      certificateExpiresAt: state?.certificate?.notAfter ?? null,
      certificateError: state?.certificateIssuance?.lastError ?? null,
      relayConnected: current && !!state?.relay.connected,
      relayRegion: state?.relay.relayId ?? names?.relay.id ?? null,
      relayLatencyMs: current && state?.relay.connected ? (state.relay.latencyMs ?? null) : null,
      relayConnectedAt: current && state?.relay.connected ? (state.relay.connectedAt ?? null) : null,
      relayBytesIn: state?.relay.bytesIn ?? 0,
      relayBytesOut: state?.relay.bytesOut ?? 0,
      relayLastError: state?.relay.lastError ?? null,
      relayLastErrorAt: state?.relay.lastErrorAt ?? null,
      relayRevoked: !!state?.relay.revoked,
      directListening: current && !!state?.direct.listening,
      cgnatSuspected: !!state?.direct.cgnatSuspected,
      mappingMethod: (current && state?.direct.mapping?.method) || null,
      mappingError: (current && state?.direct.mappingError) || null,
      directGuidance: (current && state?.direct.guidance) || null,
      directExternalIp: (current && state?.direct.externalIp) || null,
      wanAddress: (current && state?.direct.wan?.uri) || null,
      wanVerified: current && !!state?.direct.wan?.verified,
      wanProblem: (current && !state?.direct.wan?.verified && state?.direct.wan?.reason) || null,
      customHostname: host,
      customHostnameStatus: host ? settings.customHostname.status : null,
      customHostnameCheckedAt: host ? settings.customHostname.checkedAt : null,
      customHostnameProblem: host ? problem : null,
      customHostnameRecords: host && label ? customHostnameRecords(host, { label, domain }) : [],
      candidates: settings.enabled && current && state ? state.candidates : [],
      lastTestAt: lastTest?.at ?? null,
      lastTestOk: lastTest?.ok ?? null,
      lastTestChecks: lastTest?.checks ?? [],
    };
  }

  /** `PUT admin/cloud/remote`: turn remote access on or off; its mode, direct port and published address. */
  async update(auth: AuthDto, dto: RemoteAccessUpdateDto): Promise<RemoteAccessStatusResponseDto> {
    if (dto.enabled) {
      const reason = await remoteAccessUnavailable(this.linkDeps);
      if (reason) {
        throw new BadRequestException(reason);
      }
    }
    const { oldConfig, newConfig } = await this.updateConfigExclusively(
      (config) => {
        const remote = config.frameleafCloud.remoteAccess;
        if (dto.publicUrl === 'custom' && !verifiedCustomHost(remote)) {
          throw new BadRequestException('Use my domain needs a custom hostname that Frameleaf Cloud verified.');
        }
        config.frameleafCloud.remoteAccess = {
          ...remote,
          ...(dto.enabled !== undefined && { enabled: dto.enabled }),
          ...(dto.mode !== undefined && { mode: dto.mode }),
          ...(dto.directPort !== undefined && { directPort: dto.directPort }),
          ...(dto.portMapping !== undefined && { portMapping: dto.portMapping }),
          ...(dto.publicUrl !== undefined && { publicUrl: dto.publicUrl }),
        };
      },
      { source: 'frameleaf-cloud', auth },
    );
    await this.eventRepository.emit('ConfigUpdate', { oldConfig, newConfig });
    if (dto.enabled !== undefined) {
      await this.syncDesired(dto.enabled);
    }
    const remote = newConfig.frameleafCloud.remoteAccess;
    this.logger.log(
      `Remote access changed by ${auth.user.id}: ${remote.enabled ? 'on' : 'off'}, ${remote.mode}, ` +
        `port ${remote.directPort}, publishes ${remote.publicUrl}`,
    );
    return this.getStatus();
  }

  /**
   * The link's desired remote access state follows the switch, so the check-in reports it and a
   * command from Frameleaf Cloud starts from it.
   */
  private async syncDesired(enabled: boolean) {
    // under the check-in's lock, so a check-in saving the link at the same time is not overwritten
    await this.databaseRepository.withLock(DatabaseLock.FrameleafHeartbeat, () =>
      this.databaseRepository.withLock(DatabaseLock.FrameleafLinkAuthority, async () => {
        const { link, linked } = await readCloudLink(this.linkDeps);
        if (!linked || !link || !!link.desired?.remoteAccess === enabled) {
          return;
        }
        await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafCloudLink, {
          ...link,
          desired: { cloudBackup: false, ...link.desired, remoteAccess: enabled },
        });
      }),
    );
  }

  // ------------------------------------------------------------------ custom hostname

  /** `PUT admin/cloud/remote/hostname`: add a hostname the administrator owns; its records then wait for DNS. */
  async setCustomHostname(auth: AuthDto, dto: RemoteHostnameUpdateDto): Promise<RemoteAccessStatusResponseDto> {
    const { cloudUrl, link } = await this.requireAvailable();
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafRemoteAccess);
    const names = state?.names?.instanceId === link.instanceId ? state.names : null;
    const document = await this.cloudCall(() => this.frameleafCloudRepository.discovery(cloudUrl));
    const check = validateCustomHostname(dto.hostname, directDomainOf(names, document));
    if (!check.valid) {
      throw new BadRequestException(check.message);
    }

    const config = await this.getConfig({ withCache: false });
    const previous = config.frameleafCloud.remoteAccess.customHostname.host;
    const answer = await this.cloudCall(async () => {
      const { token } = await this.session(cloudUrl, link);
      return this.frameleafCloudRepository.requestJson(remoteHostnameSchema, {
        method: 'PUT',
        url: remoteEndpoints(document).hostnames,
        dpop: token,
        body: { hostname: check.host },
      });
    });
    await this.saveHostname(answer, previous !== check.host, check.host);
    // the new hostname is in place before the old one goes, so a failure never leaves neither
    if (previous && previous !== check.host) {
      await this.removeAtCloud(cloudUrl, link, previous).catch((error: unknown) => {
        this.logger.warn(`The previous custom hostname ${previous} could not be removed: ${error}`);
      });
    }
    this.logger.log(`Custom hostname ${check.host} added by ${auth.user.id}: ${answer.state}`);
    return this.getStatus(Date.now(), hostnameProblem(answer));
  }

  /** `POST admin/cloud/remote/hostname/check`: ask Frameleaf Cloud whether the records are in place. */
  async checkCustomHostname(auth: AuthDto): Promise<RemoteAccessStatusResponseDto> {
    const { cloudUrl, link } = await this.requireAvailable();
    const config = await this.getConfig({ withCache: false });
    const host = config.frameleafCloud.remoteAccess.customHostname.host;
    if (!host) {
      throw new BadRequestException('Add a custom hostname first.');
    }
    const answer = await this.cloudCall(async () => {
      const { document, token } = await this.session(cloudUrl, link);
      const { hostnames } = await this.frameleafCloudRepository.requestJson(remoteHostnameListSchema, {
        url: remoteEndpoints(document).hostnames,
        dpop: token,
      });
      const found = hostnames.find((hostname) => hostname.hostname === host);
      if (found) {
        return found;
      }
      // Frameleaf Cloud no longer has it (it gave up after seven days, or the link changed): add it again
      return this.frameleafCloudRepository.requestJson(remoteHostnameSchema, {
        method: 'PUT',
        url: remoteEndpoints(document).hostnames,
        dpop: token,
        body: { hostname: host },
      });
    });
    await this.saveHostname(answer, false, host, true);
    this.logger.log(`Custom hostname ${host} checked by ${auth.user.id}: ${answer.state}`);
    return this.getStatus(Date.now(), hostnameProblem(answer));
  }

  /** `DELETE admin/cloud/remote/hostname`: stop using the custom hostname. Its DNS records can then be deleted. */
  async removeCustomHostname(auth: AuthDto): Promise<RemoteAccessStatusResponseDto> {
    const config = await this.getConfig({ withCache: false });
    const host = config.frameleafCloud.remoteAccess.customHostname.host;
    if (!host) {
      return this.getStatus();
    }
    // this server stops using it first; telling Frameleaf Cloud is best effort (it releases the
    // hostname on unlink too, and an unverified claim expires on its own)
    const { oldConfig, newConfig } = await this.updateConfigExclusively(
      (next) => {
        next.frameleafCloud.remoteAccess = {
          ...next.frameleafCloud.remoteAccess,
          publicUrl: 'frameleaf',
          customHostname: { host: '', status: 'pending', checkedAt: null },
        };
      },
      { source: 'frameleaf-cloud', auth },
    );
    await this.eventRepository.emit('ConfigUpdate', { oldConfig, newConfig });
    const { cloudUrl, link, linked } = await readCloudLink(this.linkDeps);
    if (cloudUrl && linked && link?.instanceId) {
      await this.removeAtCloud(cloudUrl, link as FrameleafCloudLink & { instanceId: string }, host).catch(
        (error: unknown) => this.logger.warn(`Frameleaf Cloud was not told that ${host} was removed: ${error}`),
      );
    }
    this.logger.log(`Custom hostname ${host} removed by ${auth.user.id}`);
    return this.getStatus();
  }

  private async removeAtCloud(cloudUrl: string, link: FrameleafCloudLink & { instanceId: string }, host: string) {
    await this.cloudCall(async () => {
      const { document, token } = await this.session(cloudUrl, link);
      try {
        await this.frameleafCloudRepository.requestJson(z.unknown(), {
          method: 'DELETE',
          url: remoteEndpoints(document).hostname(host),
          dpop: token,
        });
      } catch (error) {
        // already gone there
        if (!(error instanceof FrameleafCloudError && error.status === 404)) {
          throw error;
        }
      }
    });
  }

  /** Keep what Frameleaf Cloud said about the hostname; "Use my domain" falls back while it is not verified. */
  private async saveHostname(answer: RemoteHostname, changed: boolean, host: string, onlyIfStored = false) {
    if (answer.hostname !== host) {
      throw new ServiceUnavailableException('Frameleaf Cloud answered for another hostname. Try again.');
    }
    const status = hostnameStatus(answer.state);
    const { oldConfig, newConfig } = await this.updateConfigExclusively(
      (config) => {
        const remote = config.frameleafCloud.remoteAccess;
        // a check never writes back a hostname that was removed while it ran
        if (onlyIfStored && remote.customHostname.host !== host) {
          return;
        }
        config.frameleafCloud.remoteAccess = {
          ...remote,
          publicUrl: status === 'verified' && !changed ? remote.publicUrl : 'frameleaf',
          customHostname: {
            host: answer.hostname,
            status,
            checkedAt: answer.checkedAt ?? new Date().toISOString(),
          },
        };
      },
      { source: 'frameleaf-cloud' },
    );
    await this.eventRepository.emit('ConfigUpdate', { oldConfig, newConfig });
  }

  // ------------------------------------------------------------------ relay use

  /**
   * `GET admin/cloud/remote/usage`: this month's relay use and the plan's allowance, as Frameleaf Cloud
   * meters them (the "Relay use this month" meter). Asked for only on a linked server with a remote
   * access plan, and at most once a minute.
   */
  async getUsage(auth: AuthDto, now = Date.now()): Promise<RemoteAccessUsageResponseDto> {
    const { cloudUrl, link } = await this.requireAvailable();
    const cached = this.usageCache;
    if (cached?.instanceId === link.instanceId && now - cached.at < USAGE_FRESH_MS) {
      return cached.usage;
    }
    const answer = await this.cloudCall(async () => {
      const { document, token } = await this.session(cloudUrl, link);
      return this.frameleafCloudRepository.requestJson(remoteUsageSchema, {
        url: remoteEndpoints(document).usage,
        dpop: token,
      });
    });
    const usage: RemoteAccessUsageResponseDto = {
      period: answer.period,
      periodStart: answer.periodStart,
      periodEnd: answer.periodEnd,
      bytes: answer.bytes,
      limitBytes: answer.limitBytes,
      throttled: !!answer.throttle,
      throttleBps: answer.throttle?.bps ?? null,
      throttleUntil: answer.throttle?.until ?? null,
    };
    this.usageCache = { instanceId: link.instanceId, at: now, usage };
    this.logger.debug(`Relay use read by ${auth.user.id}: ${usage.bytes} of ${usage.limitBytes} bytes`);
    return usage;
  }

  // ------------------------------------------------------------------ self-check

  /**
   * `POST admin/cloud/remote/test`: check what can be checked from here: the edge worker reports in,
   * the certificate is current, and a request through the direct listener reaches this server over
   * HTTPS with the certificate for its LAN name. The relay and the router mapping are reported as the
   * edge worker last saw them.
   */
  async test(auth: AuthDto, now = Date.now()): Promise<RemoteAccessStatusResponseDto> {
    const config = await this.getConfig({ withCache: false });
    const settings = config.frameleafCloud.remoteAccess;
    const reason = await remoteAccessUnavailable(this.linkDeps, now);
    if (reason) {
      throw new BadRequestException(reason);
    }
    if (!settings.enabled) {
      throw new BadRequestException('Turn remote access on first.');
    }
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafRemoteAccess);
    const current = edgeStateCurrent(state, now);
    const checks: FrameleafRemoteAccessTest['checks'] = [];

    const certificate = state?.certificate;
    const certificateOk = !!certificate && Date.parse(certificate.notAfter) > now;
    checks.push({
      id: 'certificate',
      ok: certificateOk,
      detail: certificateOk
        ? `Issued to this server for ${certificate.names[0]}; expires ${certificate.notAfter.slice(0, 10)}`
        : (state?.certificateIssuance?.lastError ?? 'This server has no certificate yet.'),
    });

    const listening = current && !!state?.direct.listening;
    checks.push({
      id: 'listener',
      ok: listening,
      detail: listening
        ? `Listening for HTTPS on port ${state.direct.port}`
        : current
          ? (state?.reason ?? 'The HTTPS listener is not running.')
          : 'The edge worker did not report in the last minute.',
    });

    const probe: ProbeResult =
      listening && state?.names
        ? await this.probe(state)
        : { ok: false, detail: 'Not tried: the HTTPS listener is not running.' };
    checks.push({ id: 'api', ...probe });

    const relayConnected = current && !!state?.relay.connected;
    checks.push({
      id: 'relay',
      ok: relayConnected,
      detail: relayConnected ? 'Connected to the Frameleaf relay.' : 'Not connected to the Frameleaf relay yet.',
    });

    if (settings.mode === 'relay-and-direct') {
      checks.push({ id: 'direct', ...directCheck(settings, state, listening) });
    }

    const result: FrameleafRemoteAccessTest = {
      at: new Date(now).toISOString(),
      // the relay and the router are reported, not required: direct HTTPS and the certificate are
      ok: certificateOk && listening && probe.ok,
      checks,
    };
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafRemoteAccessTest, result);
    this.logger.log(`Remote access self-check by ${auth.user.id}: ${result.ok ? 'passed' : 'failed'}`);
    return this.getStatus(now);
  }

  /** One request through the direct listener, as a device on the home network would make it. */
  private async probe(state: FrameleafRemoteAccess): Promise<ProbeResult> {
    const names = state.names!;
    const { bind, port } = this.configRepository.getEnv().frameleafCloud.edge;
    const host = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
    // the loopback name: a connection from this host is served even in "Relay only" mode (as remote)
    const servername = ipv4Name(names, '127.0.0.1')!;
    return this.probeEdge(host, port, servername);
  }

  /** Connect with TLS, check the certificate covers the name, and ask for `/api/server/ping`. */
  protected probeEdge(host: string, port: number, servername: string): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      // the name is checked below; the chain is not, so a staging or test CA also passes
      const socket = tls.connect({ host, port, servername, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
      let settled = false;
      const done = (result: ProbeResult) => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(PROBE_TIMEOUT_MS, () => {
        done({ ok: false, detail: 'The HTTPS listener did not answer in time.' });
      });
      socket.once('error', (error) => {
        done({ ok: false, detail: `The HTTPS listener refused the connection: ${error.message}` });
      });
      socket.once('secureConnect', () => {
        const identity = tls.checkServerIdentity(servername, socket.getPeerCertificate());
        if (identity) {
          done({ ok: false, detail: 'The HTTPS listener served a certificate for another name.' });
          return;
        }
        socket.write(`GET /api/server/ping HTTP/1.1\r\nHost: ${servername}\r\nConnection: close\r\n\r\n`);
      });
      let answer = '';
      socket.on('data', (chunk: Buffer) => {
        answer += chunk.toString();
        if (answer.length > 4096 || answer.includes('\r\n\r\n')) {
          const ok = /^HTTP\/1\.1 200 /.test(answer);
          done(
            ok
              ? { ok: true, detail: 'This server answered over HTTPS through the direct listener.' }
              : { ok: false, detail: `This server answered ${answer.split('\r\n', 1)[0]}` },
          );
        }
      });
      socket.once('end', () =>
        done({ ok: false, detail: 'The HTTPS listener closed the connection without an answer.' }),
      );
    });
  }

  // ------------------------------------------------------------------ helpers

  private async requireAvailable() {
    const reason = await remoteAccessUnavailable(this.linkDeps);
    if (reason) {
      throw new BadRequestException(reason);
    }
    const { cloudUrl, link } = await readCloudLink(this.linkDeps);
    return { cloudUrl: cloudUrl!, link: link as FrameleafCloudLink & { instanceId: string } };
  }

  /** Discovery and a DPoP-bound instance token for the cloud API, minted with this server's key. */
  private async session(cloudUrl: string, link: FrameleafCloudLink & { instanceId: string }) {
    const document = await this.frameleafCloudRepository.discovery(cloudUrl);
    await loadInstanceIdentity({
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
    });
    const token = await this.frameleafCloudRepository.accessToken(
      document,
      link.instanceId,
      document.api,
      this.instanceIdentityRepository.currentSigner(),
    );
    return { document, token };
  }

  /** A cloud failure while an administrator waits becomes a 503 (or the cloud's 400) in plain words. */
  private async cloudCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof FrameleafCloudError) {
        if (error.status !== null && error.status >= 400 && error.status < 500 && error.status !== 401) {
          throw new BadRequestException(error.message);
        }
        throw new ServiceUnavailableException(`Frameleaf Cloud did not complete the request: ${error.message}`);
      }
      throw error;
    }
  }
}
