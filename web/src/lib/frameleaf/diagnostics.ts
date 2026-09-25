import type {
  AdminConfigDto,
  QueueResponseDto,
  ServerAboutResponseDto,
  ServerFeaturesDto,
  ServerStorageResponseDto,
  ServerVersionResponseDto,
} from '@immich/sdk';
import { withoutCredentialValues } from '$lib/frameleaf/credentials';

/**
 * FL-71 "Download diagnostics" (the template's `diagnostics` section action, `settings-catalog.mjs`
 * "Logs & diagnostics"): a file an administrator can hand to whoever helps them troubleshoot. It is
 * built in the browser from what this administrator can already read and never leaves the device
 * on its own. It carries the build, enabled features, storage totals, queue counts and the settings
 * with every credential emptied; no photo, file name, path of a person's media, account name or
 * email is included (the settings' own values aside).
 */
export type DiagnosticsInput = {
  generatedAt: Date;
  about: ServerAboutResponseDto;
  version: ServerVersionResponseDto;
  features: ServerFeaturesDto;
  storage: ServerStorageResponseDto;
  queues: QueueResponseDto[];
  config: AdminConfigDto;
};

export const buildDiagnostics = ({
  generatedAt,
  about,
  version,
  features,
  storage,
  queues,
  config,
}: DiagnosticsInput) => ({
  kind: 'frameleaf-diagnostics',
  generatedAt: generatedAt.toISOString(),
  version: `${version.major}.${version.minor}.${version.patch}`,
  build: {
    version: about.version,
    build: about.build ?? null,
    sourceRef: about.sourceRef ?? null,
    sourceCommit: about.sourceCommit ?? null,
    nodejs: about.nodejs ?? null,
    ffmpeg: about.ffmpeg ?? null,
    imagemagick: about.imagemagick ?? null,
    libvips: about.libvips ?? null,
    exiftool: about.exiftool ?? null,
  },
  features,
  storage: {
    diskSizeRaw: storage.diskSizeRaw,
    diskUseRaw: storage.diskUseRaw,
    diskAvailableRaw: storage.diskAvailableRaw,
    diskUsagePercentage: storage.diskUsagePercentage,
  },
  queues: queues.map(({ name, isPaused, statistics }) => ({ name, isPaused, statistics })),
  settings: withoutCredentialValues(config),
});

export const diagnosticsFileName = (generatedAt: Date) =>
  `frameleaf-diagnostics-${generatedAt.toISOString().slice(0, 19).replaceAll(':', '-')}.json`;
