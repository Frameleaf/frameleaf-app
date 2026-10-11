import type {
  AdminConfigDto,
  QueueResponseDto,
  ServerAboutResponseDto,
  ServerFeaturesDto,
  ServerStorageResponseDto,
  ServerVersionResponseDto,
} from '@frameleaf/sdk';
import { set } from 'lodash-es';
import { withoutCredentialValues } from '$lib/frameleaf/credentials';
import { cloneConfig, configLeaves, stripUrlCredentials } from '$lib/frameleaf/system-config-draft';

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
  settings: reportSettings(config),
});

/**
 * Settings that say who the household is or how to reach its mail account (FL-368): the report
 * promises no names, so these are emptied as well as the credentials.
 */
const REPORT_PRIVATE_PATHS = [
  'notifications.smtp.transport.host',
  'notifications.smtp.transport.username',
  'notifications.smtp.from',
  'notifications.smtp.replyTo',
];

/** The settings as the report carries them: no credential, no sign-in inside an address, no mail account. */
const reportSettings = (config: AdminConfigDto) => {
  const settings = cloneConfig(withoutCredentialValues(config));
  for (const [path, value] of configLeaves(settings)) {
    if (typeof value === 'string') {
      set(settings, path, REPORT_PRIVATE_PATHS.includes(path) ? '' : stripUrlCredentials(value));
    } else if (Array.isArray(value)) {
      set(
        settings,
        path,
        value.map((item) => (typeof item === 'string' ? stripUrlCredentials(item) : item)),
      );
    }
  }
  return settings;
};

export const diagnosticsFileName = (generatedAt: Date) =>
  `frameleaf-diagnostics-${generatedAt.toISOString().slice(0, 19).replaceAll(':', '-')}.json`;
