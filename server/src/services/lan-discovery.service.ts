import { Injectable } from '@nestjs/common';
import Bonjour, { Service } from 'bonjour-service';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { ImmichWorker } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { detectHostAddresses } from 'src/utils/frameleaf-remote-access.js';
import { serverIdentity } from 'src/utils/frameleaf-server-identity.js';

/**
 * FL-229 (NAPI-005, owner decision 2026-09-30): advertises this server on the LAN via DNS-SD
 * (`_frameleaf._tcp`) so an app on the same Wi-Fi can find it without typing an address. On by
 * default on a fresh install; an admin can turn it off (`config.server.lanDiscovery`). The TXT
 * record carries `id` and `name` - the same identity fields `GET /server/ping` returns - so an app
 * can confirm it found the right server before ever connecting to it.
 *
 * Runs on the API worker only (one process). Not unit-testable against real multicast without
 * flaking in CI, so tests mock the `bonjour-service` module rather than exercising real UDP.
 */
@Injectable()
export class LanDiscoveryService extends BaseService {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Api] })
  async onBootstrap(): Promise<void> {
    const { server } = await this.getConfig({ withCache: true });
    if (server.lanDiscovery) {
      await this.start();
    }
  }

  @OnEvent({ name: 'ConfigUpdate', server: true, workers: [ImmichWorker.Api] })
  async onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>): Promise<void> {
    if (newConfig.server.lanDiscovery) {
      await this.start();
    } else {
      this.stop();
    }
  }

  private async start(): Promise<void> {
    // ponytail: republish rather than diff - a rename is rare, and stopping+starting the one
    // service is far simpler than patching a live mdns TXT record in place.
    this.stop();

    const { server } = await this.getConfig({ withCache: true });
    const { port, frameleafCloud } = this.configRepository.getEnv();
    if (detectHostAddresses(frameleafCloud.localUrl).lanAddresses.length === 0) {
      // nothing to advertise on (e.g. inside a container with no LAN interface visible)
      return;
    }
    const { id } = await serverIdentity({
      configRepository: this.configRepository,
      systemMetadataRepository: this.systemMetadataRepository,
    });
    const name = server.name?.trim() || 'Frameleaf server';

    this.bonjour ??= new Bonjour();
    this.service = this.bonjour.publish({ name, type: 'frameleaf', protocol: 'tcp', port, txt: { id, name } });
  }

  private stop(): void {
    this.service?.stop();
    this.service = null;
  }
}
