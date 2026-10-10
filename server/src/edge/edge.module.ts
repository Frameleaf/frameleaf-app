import { Inject, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { KyselyModule } from 'nestjs-kysely';
import { existsSync } from 'node:fs';
import { IWorker } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { EdgeCertificateRepository } from 'src/edge/edge-certificate.repository.js';
import { EdgeDirectService } from 'src/edge/edge-direct.service.js';
import { EdgePortMappingService } from 'src/edge/edge-port-mapping.service.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { EdgeRelayService } from 'src/edge/edge-relay.service.js';
import { EdgeStateService } from 'src/edge/edge-state.service.js';
import { ImmichWorker } from 'src/enum.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { NotificationRepository } from 'src/repositories/notification.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { discoverMediaLocation } from 'src/utils/media-location.js';

const { cls, database } = new ConfigRepository().getEnv();

/**
 * The media location, found as the storage service finds it (`FRAMELEAF_MEDIA_LOCATION`, else the one
 * existing default folder), so the identity directory is the same one the API and jobs use.
 */
export const detectMediaLocation = (configRepository: ConfigRepository): string => {
  return discoverMediaLocation(configRepository.getEnv().storage.mediaLocation, existsSync);
};

/**
 * The edge worker's module (FL-165, CLD-102), modelled on the maintenance worker's: only what remote
 * access needs, never the API's controllers, services, queues or websocket server. It reads the link,
 * licence, settings and identity key from the database and identity directory, talks to Frameleaf
 * Cloud with this server's key, and proxies to the API over loopback.
 */
@Module({
  imports: [ClsModule.forRoot(cls.config), KyselyModule.forRoot(getKyselyConfig(database.config))],
  providers: [
    ConfigRepository,
    LoggingRepository,
    DatabaseRepository,
    SystemMetadataRepository,
    AssetChecksumRepository,
    InstanceIdentityRepository,
    FrameleafCloudRepository,
    UserRepository,
    NotificationRepository,
    EdgeCertificateRepository,
    EdgeProxyService,
    EdgeDirectService,
    EdgeRelayService,
    EdgePortMappingService,
    EdgeStateService,
    { provide: IWorker, useValue: ImmichWorker.Edge },
  ],
})
export class EdgeModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(IWorker) private worker: ImmichWorker,
    logger: LoggingRepository,
    private configRepository: ConfigRepository,
    private edgeState: EdgeStateService,
  ) {
    logger.setAppName(this.worker);
  }

  onModuleInit() {
    StorageCore.setMediaLocation(detectMediaLocation(this.configRepository));
    this.edgeState.start();
  }

  /** `AppShutdown`: every remote-access socket closes within 5 seconds. */
  async onModuleDestroy() {
    await this.edgeState.shutdown();
  }
}
