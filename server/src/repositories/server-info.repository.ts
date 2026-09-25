import { Injectable } from '@nestjs/common';
import { exiftool } from 'exiftool-vendored';
import { exec as execCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { ReleaseChannel } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { GitHubRelease, newestFrameleafRelease } from 'src/utils/frameleaf-release.js';

export interface VersionResponse {
  version: string;
  published_at: string;
}

export interface ServerBuildVersions {
  nodejs: string;
  ffmpeg: string;
  libvips: string;
  libraw: string;
  exiftool: string;
  imagemagick: string;
}

const exec = promisify(execCallback);
const maybeFirstLine = async (command: string): Promise<string> => {
  try {
    const { stdout } = await exec(command);
    return stdout.trim().split('\n', 1)[0] || '';
  } catch {
    return '';
  }
};

type BuildLockfile = {
  sources: Array<{ name: string; version: string }>;
  packages: Array<{ name: string; version: string }>;
};

const getLockfileVersion = (name: string, lockfile?: BuildLockfile) => {
  if (!lockfile) {
    return;
  }

  const items = [...(lockfile.sources || []), ...(lockfile?.packages || [])];
  const item = items.find((item) => item.name === name);
  return item?.version;
};

@Injectable()
export class ServerInfoRepository {
  constructor(
    private configRepository: ConfigRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(ServerInfoRepository.name);
  }

  /**
   * The newest Frameleaf release on the channel (FL-80 S-4 / O-8). Only Frameleaf's GitHub releases
   * are asked (`versionCheck.url`); no Immich service is contacted. Stable reads the latest published
   * release; Release candidate reads the recent releases and includes prereleases. The version is
   * parsed from the `frameleaf-v<semver>-<n>` tag and returned with a leading "v".
   *
   * Our release script never marks a GitHub release as a prerelease, so `/releases/latest` can be a
   * release-candidate tag; Stable then falls back to the release list and its newest stable tag.
   * Every request gives up after 10 seconds, and a failure names the HTTP status and any rate-limit
   * reset or Retry-After.
   */
  async getLatestRelease(channel: ReleaseChannel): Promise<VersionResponse> {
    try {
      const { versionCheck } = this.configRepository.getEnv();
      const includePrerelease = channel === ReleaseChannel.ReleaseCandidate;
      let newest = includePrerelease
        ? undefined
        : newestFrameleafRelease([(await this.fetchReleases(`${versionCheck.url}/latest`)) as GitHubRelease], false);
      if (!newest) {
        const releases = await this.fetchReleases(`${versionCheck.url}?per_page=30`);
        newest = newestFrameleafRelease(Array.isArray(releases) ? releases : [releases], includePrerelease);
      }
      if (!newest) {
        throw new Error('No Frameleaf release tag found');
      }
      return { version: `v${newest.tag.version}`, published_at: newest.release.published_at ?? '' };
    } catch (error) {
      throw new Error('Failed to fetch latest release', { cause: error });
    }
  }

  private async fetchReleases(url: string): Promise<GitHubRelease | GitHubRelease[]> {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Frameleaf-Server',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const details = [`status ${response.status}`];
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        details.push(`Retry-After ${retryAfter}s`);
      }
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0) {
        details.push(`rate limit resets at ${new Date(reset * 1000).toISOString()}`);
      }
      throw new Error(`Release lookup failed with ${details.join(', ')}`);
    }
    return (await response.json()) as GitHubRelease | GitHubRelease[];
  }

  buildVersions?: ServerBuildVersions;

  private async retrieveVersionFallback(
    command: string,
    commandTransform?: (output: string) => string,
    version?: string,
  ): Promise<string> {
    if (!version) {
      const output = await maybeFirstLine(command);
      version = commandTransform ? commandTransform(output) : output;
    }
    return version;
  }

  async getBuildVersions(): Promise<ServerBuildVersions> {
    if (!this.buildVersions) {
      const { nodeVersion, resourcePaths } = this.configRepository.getEnv();

      const lockfile: BuildLockfile | undefined = await readFile(resourcePaths.lockFile)
        .then((buffer) => JSON.parse(buffer.toString()))

        .catch(() => this.logger.warn(`Failed to read ${resourcePaths.lockFile}`));

      const [nodejsVersion, ffmpegVersion, magickVersion, librawVersion, exiftoolVersion] = await Promise.all([
        this.retrieveVersionFallback('node --version', undefined, nodeVersion),
        this.retrieveVersionFallback(
          'ffmpeg -version',
          (output) => output.replaceAll('ffmpeg version ', ''),
          getLockfileVersion('ffmpeg', lockfile),
        ),
        this.retrieveVersionFallback(
          'magick --version',
          (output) => output.replaceAll('Version: ImageMagick ', ''),
          getLockfileVersion('imagemagick', lockfile),
        ),
        this.retrieveVersionFallback('dcraw_emu -v 2>&1'),
        exiftool.version(),
      ]);

      // eslint-disable-next-line import-x/no-named-as-default-member
      const libvipsVersion = getLockfileVersion('libvips', lockfile) || sharp.versions.vips;

      this.buildVersions = {
        nodejs: nodejsVersion,
        exiftool: exiftoolVersion,
        ffmpeg: ffmpegVersion,
        libvips: libvipsVersion,
        libraw: librawVersion,
        imagemagick: magickVersion,
      };
    }

    return this.buildVersions;
  }
}
