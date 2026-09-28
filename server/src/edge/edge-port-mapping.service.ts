import { type Gateway, pmpNat, upnpNat } from '@achingbrain/nat-port-mapper';
import { Injectable } from '@nestjs/common';
import { isIP } from 'node:net';
import { defaultGateways } from 'src/edge/edge-direct.service.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

/** One router that can open a port: found by UPnP, or the default gateway spoken to with NAT-PMP. */
export type MappingGateway = {
  method: 'upnp' | 'nat-pmp';
  map: (internalPort: number, internalHost: string, externalPort: number, ttlSec: number) => Promise<number>;
  unmap: (internalPort: number) => Promise<void>;
  externalIp: () => Promise<string>;
  stop: () => Promise<void>;
};

export type PortMappingStatus = {
  method: 'upnp' | 'nat-pmp' | null;
  externalPort: number | null;
  /** The router's public address, as the router reports it. */
  externalIp: string | null;
  leaseUntil: string | null;
  error: string | null;
  /** No router answered UPnP or NAT-PMP at all (in a container: bridge networking). */
  noGateway: boolean;
};

/** Leases last an hour and are renewed every 30 minutes. */
export const MAPPING_LEASE_SEC = 3600;
export const MAPPING_REFRESH_MS = 30 * 60 * 1000;
/** A mapping that could not be made is tried again after 5 minutes. */
export const MAPPING_RETRY_MS = 5 * 60 * 1000;
/** How long discovery and each router request may take. */
const MAPPING_TIMEOUT_MS = 5000;
const DESCRIPTION = 'Frameleaf remote access';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const IDLE: PortMappingStatus = {
  method: null,
  externalPort: null,
  externalIp: null,
  leaseUntil: null,
  error: null,
  noGateway: false,
};

const wrap = (gateway: Gateway, method: MappingGateway['method']): MappingGateway => ({
  method,
  map: async (internalPort, internalHost, externalPort, ttlSec) => {
    const mapping = await gateway.map(internalPort, internalHost, {
      externalPort,
      protocol: 'tcp',
      ttl: ttlSec,
      description: DESCRIPTION,
      // this service renews the lease itself, so a stopped edge worker leaves nothing running
      autoRefresh: false,
      signal: AbortSignal.timeout(MAPPING_TIMEOUT_MS),
    });
    return mapping.externalPort;
  },
  unmap: (internalPort) => gateway.unmap(internalPort, { signal: AbortSignal.timeout(MAPPING_TIMEOUT_MS) }),
  externalIp: () => gateway.externalIp({ signal: AbortSignal.timeout(MAPPING_TIMEOUT_MS) }),
  stop: () => gateway.stop({ signal: AbortSignal.timeout(MAPPING_TIMEOUT_MS) }),
});

/**
 * Direct connect's router mapping (FL-167, CLD-104): the edge worker asks the router to forward the
 * direct port, by UPnP first and NAT-PMP otherwise, with a one-hour lease it renews every 30
 * minutes, and removes the mapping when remote access or direct connections are turned off, the
 * server is unlinked, or the worker shuts down. A failure never affects the relay; it is retried
 * after 5 minutes. When no router answers at all, `noGateway` tells the caller (in a container with
 * bridge networking, SSDP never reaches the router).
 */
@Injectable()
export class EdgePortMappingService {
  private gateway: MappingGateway | null = null;
  private mapped: { key: string; internalPort: number; refreshAt: number } | null = null;
  private retryAt = 0;
  private current: PortMappingStatus = IDLE;

  /** Specs replace these seams. */
  findUpnp = async (): Promise<MappingGateway | null> => {
    const client = upnpNat({ autoRefresh: false });
    try {
      for await (const gateway of client.findGateways({ signal: AbortSignal.timeout(MAPPING_TIMEOUT_MS) })) {
        return wrap(gateway, 'upnp');
      }
    } catch {
      // nothing answered in time
    }
    return null;
  };
  natPmp = (gatewayIp: string): MappingGateway => wrap(pmpNat(gatewayIp, { autoRefresh: false }), 'nat-pmp');
  routers = (): string[] => defaultGateways().filter((address) => isIP(address) === 4);

  constructor(private logger: LoggingRepository) {
    this.logger.setContext(EdgePortMappingService.name);
  }

  get status(): PortMappingStatus {
    return this.current;
  }

  /** Keep `externalPort` on the router forwarded to `internalHost:internalPort`. */
  async keep(input: {
    internalHost: string;
    internalPort: number;
    externalPort: number;
    now?: number;
  }): Promise<PortMappingStatus> {
    const now = input.now ?? Date.now();
    const key = `${input.internalHost}:${input.internalPort}>${input.externalPort}`;
    if (this.mapped?.key === key && now < this.mapped.refreshAt) {
      return this.current;
    }
    if (this.mapped && this.mapped.key !== key) {
      await this.release();
    }
    if (!this.mapped && now < this.retryAt) {
      return this.current;
    }

    const renewing = !!this.mapped && !!this.gateway;
    const candidates: Array<() => Promise<MappingGateway | null>> = renewing
      ? [() => Promise.resolve(this.gateway)]
      : [this.findUpnp, ...this.routers().map((router) => () => Promise.resolve(this.natPmp(router)))];
    let lastError: string | null = null;
    let answered = false;
    for (const next of candidates) {
      const gateway = await next();
      if (!gateway) {
        continue;
      }
      try {
        const externalPort = await gateway.map(
          input.internalPort,
          input.internalHost,
          input.externalPort,
          MAPPING_LEASE_SEC,
        );
        answered = true;
        const externalIp = await gateway.externalIp().catch(() => null);
        if (this.gateway && this.gateway !== gateway) {
          await this.gateway.stop().catch(() => {});
        }
        this.gateway = gateway;
        this.mapped = { key, internalPort: input.internalPort, refreshAt: now + MAPPING_REFRESH_MS };
        this.retryAt = 0;
        this.current = {
          method: gateway.method,
          externalPort,
          externalIp: externalIp && isIP(externalIp) ? externalIp : null,
          leaseUntil: new Date(now + MAPPING_LEASE_SEC * 1000).toISOString(),
          error: null,
          noGateway: false,
        };
        if (!renewing) {
          this.logger.log(`The router forwards port ${externalPort} to this server (${gateway.method})`);
        }
        return this.current;
      } catch (error) {
        // a router that answered discovery but refused the mapping still counts as a router
        answered ||= gateway.method === 'upnp';
        lastError = `${gateway.method === 'upnp' ? 'UPnP' : 'NAT-PMP'}: ${message(error)}`;
        await gateway.stop().catch(() => {});
        if (gateway === this.gateway) {
          this.gateway = null;
        }
      }
    }

    this.mapped = null;
    this.retryAt = now + MAPPING_RETRY_MS;
    this.current = { ...IDLE, error: lastError ?? 'No router answered UPnP or NAT-PMP.', noGateway: !answered };
    this.logger.warn(`The router did not open port ${input.externalPort}: ${this.current.error}`);
    return this.current;
  }

  /** Remove the mapping (remote access or direct connections off, unlinked, or shutting down). */
  async release(): Promise<void> {
    const { gateway, mapped } = this;
    this.gateway = null;
    this.mapped = null;
    this.retryAt = 0;
    this.current = IDLE;
    if (!gateway) {
      return;
    }
    try {
      if (mapped) {
        await gateway.unmap(mapped.internalPort);
        this.logger.log('The router no longer forwards the direct port');
      }
    } catch (error) {
      this.logger.warn(`The router mapping could not be removed: ${message(error)}`);
    } finally {
      await gateway.stop().catch(() => {});
    }
  }
}
