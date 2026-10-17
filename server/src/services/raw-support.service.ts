import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  RawSupportFormatDto,
  RawSupportQueryDto,
  RawSupportResponseDto,
  RawSupportSource,
  RawSupportStatus,
} from 'src/dtos/raw-support.dto.js';
import { Colorspace, MediaHealthStatus } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RawSupportFacts, RawSupportRepository } from 'src/repositories/raw-support.repository.js';
import { ServerInfoRepository } from 'src/repositories/server-info.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { getConfig } from 'src/utils/config.js';
import { verifyDarktableVersion } from 'src/utils/darktable-renderer.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';

/**
 * Cameras this build's RAW pipeline was qualified with, per extension. The calibrated Canon EOS 70D
 * oracle is the only one so far (server/test/native/README-darktable.md); add a camera here only with
 * its qualification evidence.
 */
export const RAW_TESTED_CAMERAS: Readonly<Record<string, readonly string[]>> = { cr2: ['Canon EOS 70D'] };

/** Integrity-check reasons that mean "try again, it ran out of time or memory" rather than damage. */
const RETRY_REASONS = new Set(['decode_timeout', 'validation_timeout', 'decoder_resource_limit', 'validation_busy']);
const ATTENTION = new Set([
  RawSupportStatus.Timeout,
  RawSupportStatus.Unsupported,
  RawSupportStatus.Damaged,
  RawSupportStatus.Dependency,
]);
/** Engine probes start processes; they change only when the server image does. */
const ENGINE_CACHE_MS = 5 * 60 * 1000;

/**
 * A file's state. An open Library Care finding wins: it is what a deep check of the original said. Then
 * whether a preview exists, and where it comes from: with embedded previews on, a file without a
 * full-resolution render shows the camera's JPEG (media.service.ts `extractOriginalImage`).
 */
export const rawSupportStatus = (facts: RawSupportFacts, embeddedPreviews: boolean): RawSupportStatus => {
  if (facts.healthStatus === MediaHealthStatus.UnsupportedRaw) {
    return RawSupportStatus.Unsupported;
  }
  if (
    facts.healthStatus === MediaHealthStatus.CorruptSuspect ||
    facts.healthStatus === MediaHealthStatus.CorruptConfirmed
  ) {
    if (facts.healthReason === 'decoder_unavailable') {
      return RawSupportStatus.Dependency;
    }
    return facts.healthReason && RETRY_REASONS.has(facts.healthReason)
      ? RawSupportStatus.Timeout
      : RawSupportStatus.Damaged;
  }
  if (!facts.hasPreview) {
    return RawSupportStatus.Pending;
  }
  return embeddedPreviews && !facts.hasFullsize ? RawSupportStatus.Preview : RawSupportStatus.Ready;
};

export const rawSupportSource = (facts: RawSupportFacts, embeddedPreviews: boolean): RawSupportSource => {
  if (!facts.hasPreview) {
    return RawSupportSource.None;
  }
  return embeddedPreviews && !facts.hasFullsize ? RawSupportSource.Embedded : RawSupportSource.Sensor;
};

type Engines = Pick<RawSupportResponseDto, 'decoder' | 'developer'>;

@Injectable()
export class RawSupportService {
  private engines?: { at: number; value: Promise<Engines> };

  constructor(
    private logger: LoggingRepository,
    private rawSupportRepository: RawSupportRepository,
    private serverInfoRepository: ServerInfoRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
  ) {
    this.logger.setContext(RawSupportService.name);
  }

  async getSummary(auth: AuthDto, dto: RawSupportQueryDto): Promise<RawSupportResponseDto> {
    const [config, engines, { groups, items }] = await Promise.all([
      getConfig(
        { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
        { withCache: true },
      ),
      this.getEngines(),
      this.rawSupportRepository.getSummary({
        ...getHiddenContentQueryOptions(auth),
        ownerId: auth.user.id,
        limit: dto.limit,
      }),
    ]);
    const embedded = config.image.extractEmbedded;
    const counts = Object.fromEntries(Object.values(RawSupportStatus).map((status) => [status, 0])) as Record<
      RawSupportStatus,
      number
    >;
    const formats = new Map<string, RawSupportFormatDto>();
    let total = 0;
    for (const group of groups) {
      const status = rawSupportStatus(group, embedded);
      counts[status] += group.count;
      total += group.count;
      const format = formats.get(group.extension) ?? {
        extension: group.extension,
        count: 0,
        ready: 0,
        attention: 0,
        tested: [...(RAW_TESTED_CAMERAS[group.extension] ?? [])],
      };
      format.count += group.count;
      if (status === RawSupportStatus.Ready) {
        format.ready += group.count;
      }
      if (ATTENTION.has(status)) {
        format.attention += group.count;
      }
      formats.set(group.extension, format);
    }
    return {
      ...engines,
      embeddedPreviews: embedded,
      fullResolution: config.image.fullsize.enabled,
      colorspace: config.image.colorspace === Colorspace.Srgb ? 'srgb' : 'p3',
      total,
      counts,
      formats: formats
        .values()
        .toArray()
        .sort((a, b) => b.count - a.count || a.extension.localeCompare(b.extension)),
      items: items.map((item) => ({
        assetId: item.assetId,
        fileName: item.fileName,
        extension: item.fileName.split('.').pop()?.toLowerCase() ?? '',
        make: item.make,
        model: item.model,
        width: item.width,
        height: item.height,
        status: rawSupportStatus(item, embedded),
        source: rawSupportSource(item, embedded),
        hasFullsize: item.hasFullsize,
        renderedAt: item.renderedAt ? new Date(item.renderedAt).toISOString() : null,
        pairedFileName: item.pairedFileName,
      })),
    };
  }

  private getEngines(): Promise<Engines> {
    const now = Date.now();
    if (!this.engines || now - this.engines.at > ENGINE_CACHE_MS) {
      this.engines = { at: now, value: this.probeEngines() };
    }
    return this.engines.value;
  }

  private async probeEngines(): Promise<Engines> {
    const [hasDecoder, developer, versions] = await Promise.all([
      this.rawSupportRepository.hasDecoder(),
      this.rawSupportRepository.getDeveloperVersion(),
      this.serverInfoRepository.getBuildVersions().catch(() => null),
    ]);
    let developerAvailable = false;
    if (developer) {
      try {
        // Development needs exactly the pinned engine (darktable-renderer.ts), not any darktable.
        verifyDarktableVersion(`${developer}\n`);
        developerAvailable = true;
      } catch {
        this.logger.debug(`RAW development engine not usable: ${developer}`);
      }
    }
    const libraw = versions?.libraw?.match(/LibRaw\s+[\w.-]+/)?.[0] ?? null;
    return {
      decoder: { available: hasDecoder, version: hasDecoder ? libraw : null },
      developer: { available: developerAvailable, version: developer },
    };
  }
}
