import { Injectable, NotFoundException } from '@nestjs/common';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { RemoteConnectionsResponseDto } from 'src/dtos/frameleaf-remote-access.dto.js';
import {
  ImageCapabilitiesDto,
  ServerAboutResponseDto,
  ServerApkLinksDto,
  ServerAppReleasesResponseDto,
  ServerConfigDto,
  ServerFeaturesDto,
  ServerMediaTypesResponseDto,
  ServerPingResponse,
  ServerStatsResponseDto,
  ServerStorageResponseDto,
  UsageByUserDto,
} from 'src/dtos/server.dto.js';
import { StorageFolder, SystemMetadataKey } from 'src/enum.js';
import { UserStatsQueryResponse } from 'src/repositories/user.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { DEFAULT_RAW_PROMPT_TEMPLATE } from 'src/services/prompt-assembler.service.js';
import { apkLinks } from 'src/utils/app-releases.js';
import { asHumanReadable } from 'src/utils/bytes.js';
import { readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { localConnectionCandidates } from 'src/utils/frameleaf-lan-discovery.js';
import { entitlementFlags, isLicensed } from 'src/utils/frameleaf-license.js';
import { detectHostAddresses } from 'src/utils/frameleaf-remote-access.js';
import { serverIdentity } from 'src/utils/frameleaf-server-identity.js';
import { type FrameleafVia, isRemoteVia, signInClient } from 'src/utils/frameleaf-sign-in.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import {
  isDuplicateDetectionEnabled,
  isFacialRecognitionEnabled,
  isImageDescriptionEnabled,
  isNsfwDetectionEnabled,
  isNsfwHidingEnabled,
  isOcrEnabled,
  isSmartSearchEnabled,
} from 'src/utils/misc.js';
import { remoteAccessPublication } from 'src/utils/public-url.js';

@Injectable()
export class ServerService extends BaseService {
  @OnEvent({ name: 'AppBootstrap' })
  async onBootstrap(): Promise<void> {
    const featureFlags = await this.getFeatures();
    if (featureFlags.configFile) {
      await this.systemMetadataRepository.set(SystemMetadataKey.AdminOnboarding, {
        isOnboarded: true,
      });
      // FL-176: a configuration file owns the settings setup would change, so setup never runs.
      const setup = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafSetup);
      if (!setup?.completed) {
        await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafSetup, {
          completed: true,
          completedAt: new Date().toISOString(),
          flow: setup?.flow ?? null,
          progress: null,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    this.logger.log(`Feature Flags: ${JSON.stringify(await this.getFeatures(), null, 2)}`);
  }

  async getAboutInfo(): Promise<ServerAboutResponseDto> {
    const version = `v${serverVersion.toString()}`;
    const { buildMetadata } = this.configRepository.getEnv();
    const buildVersions = await this.serverInfoRepository.getBuildVersions();
    // FL-156: licensed while the supporter key or the plan certificate is active or in grace
    const licenses = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafLicense);
    const licensed = isLicensed(licenses);

    return {
      version,
      // Releases are tagged frameleaf-v<version>-<n> (.github/frameleaf-release.cjs) and carry GitHub's generated notes;
      // the server only knows <version>, so link the release search for it.
      versionUrl: `https://github.com/Frameleaf/frameleaf-app/releases?q=frameleaf-${version}&expanded=true`,
      licensed,
      ...buildMetadata,
      ...buildVersions,
    };
  }

  /**
   * The signed APKs of this server version, from the release destination the operator configured
   * (FL-82). Without one there is nothing to download: installation is never sent to another
   * product's releases.
   */
  getApkLinks(): ServerApkLinksDto {
    const { android } = this.configRepository.getEnv().appReleases;
    if (!android) {
      throw new NotFoundException('No signed Android release is configured for this server');
    }
    return apkLinks(android.releaseUrl, serverVersion.toString());
  }

  /** What the app download and Obtainium setup pages can offer, and what is unavailable (FL-82). */
  getAppReleases(): ServerAppReleasesResponseDto {
    const { android, iosUrl, androidStoreUrl } = this.configRepository.getEnv().appReleases;
    const store = androidStoreUrl ? { storeUrl: androidStoreUrl } : {};
    return {
      android: android
        ? {
            available: true,
            appId: android.appId,
            signingCertificateSha256: android.signingSha256,
            links: apkLinks(android.releaseUrl, serverVersion.toString()),
            ...store,
          }
        : { available: false, ...store },
      ios: iosUrl ? { available: true, url: iosUrl } : { available: false },
    };
  }

  async getStorage(): Promise<ServerStorageResponseDto> {
    const libraryBase = StorageCore.getBaseFolder(StorageFolder.Library);
    const diskInfo = await this.storageRepository.checkDiskUsage(libraryBase);

    const usagePercentage = (((diskInfo.total - diskInfo.free) / diskInfo.total) * 100).toFixed(2);

    const serverInfo = new ServerStorageResponseDto();
    serverInfo.diskAvailable = asHumanReadable(diskInfo.available);
    serverInfo.diskSize = asHumanReadable(diskInfo.total);
    serverInfo.diskUse = asHumanReadable(diskInfo.total - diskInfo.free);
    serverInfo.diskAvailableRaw = diskInfo.available;
    serverInfo.diskSizeRaw = diskInfo.total;
    serverInfo.diskUseRaw = diskInfo.total - diskInfo.free;
    serverInfo.diskUsagePercentage = Number(usagePercentage);
    return serverInfo;
  }

  /**
   * FL-229 (NAPI-005): identity on every route, unauthenticated, so an app can confirm it reached
   * the server it expects before signing in - see serverIdentity() for what `id`/`linked` mean.
   */
  async ping(): Promise<ServerPingResponse> {
    const deps = { configRepository: this.configRepository, systemMetadataRepository: this.systemMetadataRepository };
    const [{ id, linked }, config, admin] = await Promise.all([
      serverIdentity(deps),
      this.getConfig({ withCache: true }),
      this.userRepository.getAdmin(),
    ]);
    return {
      res: 'pong',
      id,
      linked,
      name: config.server.name?.trim() || 'Frameleaf server',
      setup: admin ? 'complete' : 'needed',
      cloud: this.configRepository.getEnv().frameleafCloud.url ? 'available' : 'unavailable',
    };
  }

  async getFeatures(): Promise<ServerFeaturesDto> {
    const {
      reverseGeocoding,
      metadata,
      map,
      machineLearning,
      trash,
      oauth,
      passwordLogin,
      notifications,
      ffmpeg,
      localFeatures,
    } = await this.getConfig({ withCache: false });
    const { configFile } = this.configRepository.getEnv();
    const cloud = await this.frameleafCloudFlags();

    return {
      ...cloud,
      imageCapabilities: await this.imageCapabilities(),
      smartSearch: isSmartSearchEnabled(machineLearning),
      // FL-31: Ask Search answers through smart search, so it needs both the setting and smart search
      askSearch: localFeatures.askSearch.enabled && isSmartSearchEnabled(machineLearning),
      facialRecognition: isFacialRecognitionEnabled(machineLearning),
      duplicateDetection: isDuplicateDetectionEnabled(machineLearning),
      map: map.enabled,
      reverseGeocoding: reverseGeocoding.enabled,
      importFaces: metadata.faces.import,
      sidecar: true,
      search: true,
      trash: trash.enabled,
      oauth: oauth.enabled,
      oauthAutoLaunch: oauth.autoLaunch,
      ocr: isOcrEnabled(machineLearning),
      passwordLogin: passwordLogin.enabled,
      configFile: !!configFile,
      email: notifications.smtp.enabled,
      imageDescription: isImageDescriptionEnabled(machineLearning),
      nsfwDetection: isNsfwDetectionEnabled(machineLearning),
      nsfwHiding: isNsfwHidingEnabled(machineLearning),
      // universal storage: one file per content is always on
      physicalDeduplication: true,
      realtimeTranscoding: ffmpeg.realtime.enabled,
    };
  }

  private async imageCapabilities(): Promise<ImageCapabilitiesDto> {
    const result: ImageCapabilitiesDto = {
      experimentalEnabled: process.env.FRAMELEAF_HDR_IMAGES === 'experimental',
      // Remains false until the pinned codec build, consented camera corpus and real HDR displays pass.
      qualified: false,
      renderer: null,
      codecs: {},
      decode: [],
      render: [],
      export: [],
      unavailable: ['apple-gain-map-heic', 'iso-adaptive-heif', 'hdr-heic'],
    };
    try {
      const codec = await this.mediaRepository.getHdrCodecCapabilities();
      if (!codec) return result;
      result.renderer = 'frameleaf-develop-hdr/1';
      result.codecs = { libheif: codec.libheif, libultrahdr: codec.libultrahdr };
      result.decode = [
        'gain-map-jpeg',
        ...(codec.heicDecoder ? ['sdr-heic', 'pq-heic', 'hlg-heic'] : []),
        ...(codec.avifDecoder ? ['sdr-avif', 'pq-avif', 'hlg-avif'] : []),
      ];
      if (codec.heicDecoder && codec.appleGainMapDecoder) {
        result.decode.push('apple-gain-map-heic');
        result.unavailable = result.unavailable.filter((format) => format !== 'apple-gain-map-heic');
      }
      result.render = ['linear-hdr-develop'];
      result.export = ['sdr-jpeg', 'hdr-jpeg'];
      if (codec.heicPqEncoder) {
        result.export.push('hdr-heic');
        result.unavailable = result.unavailable.filter((format) => format !== 'hdr-heic');
      }
    } catch {
      this.logger.warn('HDR codec capability probe unavailable');
    }
    return result;
  }

  /**
   * FL-156: what cloud-connected features the server may offer. `frameleafCloud` is true while the
   * server is linked; the others follow the licence certificates. Self-hosted features never read
   * these flags.
   */
  private async frameleafCloudFlags() {
    const { linked } = await readCloudLink({
      configRepository: this.configRepository,
      systemMetadataRepository: this.systemMetadataRepository,
    });
    const licenses = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafLicense);
    const flags = entitlementFlags([licenses?.key, licenses?.plan]);
    return {
      frameleafCloud: linked,
      remoteAccess: linked && flags.remoteAccess,
      cloudMl: linked && flags.cloudMl,
      cloudBackup: linked && flags.cloudBackup,
      supporter: flags.supporter,
    };
  }

  async getSystemConfig(via: FrameleafVia | null = null): Promise<ServerConfigDto> {
    const config = await this.getConfig({ withCache: false });
    const isInitialized = !(await this.isSetupAvailable());
    // FL-176: the server counts as onboarded once Frameleaf first-run setup is complete.
    const setup = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafSetup);
    // FL-161: how this request arrived and what that asks of it, for the web app and the apps
    const deps = { configRepository: this.configRepository, systemMetadataRepository: this.systemMetadataRepository };
    const { link, linked } = await readCloudLink(deps);
    // FL-165: the address remote access publishes (the Frameleaf address, or the verified custom hostname)
    const { publicUrl } = await remoteAccessPublication(config.frameleafCloud.remoteAccess, deps);

    return {
      loginPageMessage: config.server.loginPageMessage,
      serverName: config.server.name,
      trashDays: config.trash.days,
      userDeleteDelay: config.user.deleteDelay,
      oauthButtonText: config.oauth.buttonText,
      oauthAccountManagementUrl: config.oauth.accountManagementUrl,
      isInitialized,
      isOnboarded: setup?.completed === true,
      externalDomain: config.server.externalDomain,
      publicUsers: config.server.publicUsers,
      mapDarkStyleUrl: config.map.darkStyle,
      mapLightStyleUrl: config.map.lightStyle,
      maintenanceMode: false,
      defaultImageDescriptionRawPromptTemplate: DEFAULT_RAW_PROMPT_TEMPLATE,
      minFaces: config.machineLearning.facialRecognition.minFaces,
      frameleaf: {
        via,
        // FL-168: first-run setup features linking only where the deployment set up Frameleaf Cloud
        cloudConfigured: !!this.configRepository.getEnv().frameleafCloud.url,
        signInAvailable: !!signInClient(link, linked),
        signInRequired: isRemoteVia(via) && !config.frameleafCloud.remoteAccess.allowPasswordOverRelay,
        publicUrl,
      },
    };
  }

  /**
   * FL-165: `GET server/connections`: the ways to reach this server, in the order apps should try them
   * (local, wan, ipv6, the custom hostname, then the relay; the cloud's `connections[]` shape), and the
   * address it publishes. Empty unless the server is linked and remote access is on.
   */
  /**
   * FL-229 (NAPI-005): a signed-in caller always gets at least one `local` candidate, even
   * unlinked or with remote access off - the welcome screen's "Use Home Server on this Wi-Fi"
   * and the account sheet's Home indicator need a way to reach this server on its own network
   * regardless of Frameleaf Cloud enrollment. The cloud-reported candidates (a wildcard
   * certificate over HTTPS) win when they exist; this is only the fallback plain-HTTP address
   * when nothing better is available yet.
   */
  async getConnections(): Promise<RemoteConnectionsResponseDto> {
    const config = await this.getConfig({ withCache: false });
    const publication = await remoteAccessPublication(config.frameleafCloud.remoteAccess, {
      configRepository: this.configRepository,
      systemMetadataRepository: this.systemMetadataRepository,
    });
    if (publication.connections.some((connection) => connection.kind === 'local')) {
      return publication;
    }
    const { port, frameleafCloud } = this.configRepository.getEnv();
    const { lanAddresses } = detectHostAddresses(frameleafCloud.localUrl);
    const local = localConnectionCandidates({ port, addresses: lanAddresses, localUrl: frameleafCloud.localUrl });
    return { ...publication, connections: [...publication.connections, ...local] };
  }

  async getStatistics(): Promise<ServerStatsResponseDto> {
    const userStats: UserStatsQueryResponse[] = await this.userRepository.getUserStats();
    const serverStats = new ServerStatsResponseDto();
    serverStats.photos ??= 0;
    serverStats.videos ??= 0;
    serverStats.usage ??= 0;
    serverStats.usagePhotos ??= 0;
    serverStats.usageVideos ??= 0;
    serverStats.usageByUser ??= [];

    for (const user of userStats) {
      const usage = new UsageByUserDto();
      usage.userId = user.userId;
      usage.userName = user.userName;
      usage.photos = user.photos;
      usage.videos = user.videos;
      usage.usage = user.usage;
      usage.usagePhotos = user.usagePhotos;
      usage.usageVideos = user.usageVideos;
      usage.quotaSizeInBytes = user.quotaSizeInBytes;

      serverStats.photos += usage.photos;
      serverStats.videos += usage.videos;
      serverStats.usage += usage.usage;
      serverStats.usagePhotos += usage.usagePhotos;
      serverStats.usageVideos += usage.usageVideos;

      serverStats.usageByUser.push(usage);
    }

    return serverStats;
  }

  getSupportedMediaTypes(): ServerMediaTypesResponseDto {
    return {
      video: Object.keys(mimeTypes.video),
      image: Object.keys(mimeTypes.image),
      sidecar: Object.keys(mimeTypes.sidecar),
    };
  }
}
