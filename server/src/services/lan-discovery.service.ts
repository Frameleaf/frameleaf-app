import { Injectable } from '@nestjs/common';
import Bonjour, { Service } from 'bonjour-service';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { ImmichWorker } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { localAddressFor } from 'src/utils/frameleaf-lan-discovery.js';
import { detectHostAddresses } from 'src/utils/frameleaf-remote-access.js';
import { serverIdentity } from 'src/utils/frameleaf-server-identity.js';

/** Wait for a callback, or a second at most. */
const settle = (run: (done: () => void) => void) =>
  Promise.race([
    new Promise<void>((resolve) => run(resolve)),
    new Promise<void>((resolve) => setTimeout(resolve, 1000).unref()),
  ]);

/**
 * FL-229 (NAPI-005, owner decision 2026-09-30): advertises this server on the LAN via DNS-SD
 * (`_frameleaf._tcp`) so an app on the same Wi-Fi can find it without typing an address. On by
 * default on a fresh install; an admin can turn it off (`config.server.lanDiscovery`). The TXT
 * record carries `id` and `name` - the same identity fields `GET /server/ping` returns - so an app
 * can confirm it found the right server before ever connecting to it.
 *
 * FL-292 (NAPI-012): it also carries the setup state, as `/server/ping` does: `setup=needed` while
 * the server has no administrator (else `complete`), `linked=true|false` and
 * `cloud=available|unavailable`. Never the setup code, nor anything about users or content. The
 * record is published again when that state changes.
 *
 * Runs on the API worker only (one process). Not unit-testable against real multicast without
 * flaking in CI, so tests mock the `bonjour-service` module rather than exercising real UDP.
 */
@Injectable()
export class LanDiscoveryService extends BaseService {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;
  private published: string | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  /** FL-291: set once the worker is shutting down, so nothing is published again. */
  private closed = false;

  /** FL-292: how often the setup state is checked while the record is published. */
  static readonly REFRESH_MS = 30_000;

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Api] })
  async onBootstrap(): Promise<void> {
    const { server } = await this.getConfig({ withCache: true });
    if (server.lanDiscovery) {
      await this.start();
    }
  }

  /** FL-292: the first administrator completes setup; the record says so at once. */
  @OnEvent({ name: 'UserCreate', workers: [ImmichWorker.Api] })
  async onUserCreate({ isAdmin }: ArgOf<'UserCreate'>): Promise<void> {
    if (isAdmin && this.service) {
      await this.refresh();
    }
  }

  /** FL-291: a graceful shutdown withdraws the record and stops the setup-state check. */
  @OnEvent({ name: 'AppShutdown', workers: [ImmichWorker.Api] })
  async onShutdown(): Promise<void> {
    this.closed = true;
    const bonjour = this.bonjour;
    this.bonjour = null;
    if (this.watch) {
      clearInterval(this.watch);
      this.watch = null;
    }
    if (!bonjour) {
      this.stop();
      return;
    }
    // the goodbye goes out before the multicast socket closes, so apps drop the server at once;
    // never waits more than a moment, so it cannot hold up the shutdown
    await settle((done) => bonjour.unpublishAll(() => done()));
    this.service = null;
    this.published = null;
    await settle((done) => bonjour.destroy(() => done()));
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
    const { lanAddresses } = detectHostAddresses(frameleafCloud.localUrl);
    if (lanAddresses.length === 0) {
      // nothing to advertise on (e.g. inside a container with no LAN interface visible)
      return;
    }
    const { id } = await serverIdentity({
      configRepository: this.configRepository,
      systemMetadataRepository: this.systemMetadataRepository,
    });
    const name = server.name?.trim() || 'Frameleaf server';
    const txt = { id, name, ...(await this.setupRecord()) };
    if (this.closed) {
      return;
    }

    this.bonjour ??= new Bonjour();
    // FL-218: advertise the port the network can reach (FRAMELEAF_LOCAL_URL's, behind a port mapping)
    const advertised = localAddressFor(lanAddresses[0], { port, localUrl: frameleafCloud.localUrl }).port;
    this.service = this.bonjour.publish({ name, type: 'frameleaf', protocol: 'tcp', port: advertised, txt });
    this.published = JSON.stringify(txt);
    this.watch ??= setInterval(() => void this.refresh(), LanDiscoveryService.REFRESH_MS);
    this.watch.unref?.();
  }

  /** FL-292: the setup fields of the TXT record. */
  private async setupRecord(): Promise<{ setup: 'needed' | 'complete'; linked: string; cloud: string }> {
    const admin = await this.userRepository.getAdmin();
    const { linked } = await serverIdentity({
      configRepository: this.configRepository,
      systemMetadataRepository: this.systemMetadataRepository,
    });
    return {
      setup: admin || !this.configRepository.getEnv().setup.allow ? 'complete' : 'needed',
      linked: String(linked),
      cloud: this.configRepository.getEnv().frameleafCloud.url ? 'available' : 'unavailable',
    };
  }

  /** Publish again when what the record says has changed (a link, an unlink, the first administrator). */
  private async refresh(): Promise<void> {
    if (!this.service) {
      return;
    }
    try {
      const { server } = await this.getConfig({ withCache: true });
      const { id } = await serverIdentity({
        configRepository: this.configRepository,
        systemMetadataRepository: this.systemMetadataRepository,
      });
      const txt = { id, name: server.name?.trim() || 'Frameleaf server', ...(await this.setupRecord()) };
      if (JSON.stringify(txt) !== this.published) {
        await this.start();
      }
    } catch (error) {
      this.logger.warn(`Could not refresh the LAN discovery record: ${error}`);
    }
  }

  private stop(): void {
    this.service?.stop();
    this.service = null;
    this.published = null;
    if (this.watch) {
      clearInterval(this.watch);
      this.watch = null;
    }
  }
}
