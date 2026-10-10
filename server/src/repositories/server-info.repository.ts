import { Injectable } from '@nestjs/common';
import { exiftool } from 'exiftool-vendored';
import { exec as execCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { ReleaseChannel } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  type FrameleafReleaseTag,
  GitHubRelease,
  isReleaseOffered,
  newestFrameleafRelease,
  parseFrameleafFeedRelease,
  parseReleaseBodyFlags,
  releaseFeedChannel,
} from 'src/utils/frameleaf-release.js';

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
   * The newest Frameleaf release on the channel that is offered to this server (FL-80 S-4 / O-8, FL-192,
   * FL-142). Only Frameleaf is asked; no Immich service is contacted, and no instance identifier is sent to
   * either source.
   *
   * The Frameleaf Cloud release feed (`versionCheck.url`, FC-70) is asked first with the channel
   * (`stable` or `beta`). If it fails or answers with something that is not a release, Frameleaf's
   * GitHub releases (`versionCheck.fallbackUrl`) are asked instead. The version is returned with a
   * leading "v".
   *
   * Kill switch and staged rollout (FL-142): a release marked withdrawn, or staged to a share of servers this
   * one is not in (`rolloutSeed` places it, and never leaves the server), is not offered. When the feed's
   * release is not offered, its `fallback` (the newest earlier fully rolled-out release) is offered instead;
   * `fallback: null` means the feed has nothing to offer. A feed without the field sends the check to GitHub
   * releases for the newest earlier offered release, never the same version again. An invalid `fallback`
   * makes the whole feed answer invalid, so GitHub is asked as for any other bad answer. `null` means no
   * release is offered to this server now.
   */
  async getLatestRelease(channel: ReleaseChannel, rolloutSeed: string): Promise<VersionResponse | null> {
    const { versionCheck } = this.configRepository.getEnv();
    let excluded: string | undefined;
    try {
      const release = await this.getFeedRelease(versionCheck.url, channel);
      if (isReleaseOffered(release, rolloutSeed, release.version)) {
        return { version: `v${release.version}`, published_at: release.publishedAt };
      }
      const reason = release.withdrawn ? 'withdrawn' : 'not yet offered to this server';
      // FL-142: the feed names the newest earlier release that is fully rolled out; null means there is none
      if (release.fallback) {
        if (isReleaseOffered(release.fallback, rolloutSeed, release.fallback.version)) {
          this.logger.log(`Frameleaf release ${release.version} is ${reason}; offering ${release.fallback.version}`);
          return { version: `v${release.fallback.version}`, published_at: release.fallback.publishedAt };
        }
        return null;
      }
      if (release.fallback === null) {
        this.logger.log(`Frameleaf release ${release.version} is ${reason}, and there is no earlier release to offer`);
        return null;
      }
      // a feed that predates `fallback`: look for the earlier release on GitHub, never this version again
      excluded = release.version;
      this.logger.log(`Frameleaf release ${release.version} is ${reason}; looking for an earlier release`);
    } catch (error) {
      this.logger.warn(
        `Frameleaf release feed unavailable, asking GitHub releases instead: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      return await this.getGitHubRelease(versionCheck.fallbackUrl, channel, rolloutSeed, excluded);
    } catch (error) {
      if (excluded) {
        // the feed answered: its release is not offered here, and nothing earlier could be found
        return null;
      }
      throw new Error('Failed to fetch latest release', { cause: error });
    }
  }

  private async getFeedRelease(url: string, channel: ReleaseChannel) {
    const feedUrl = new URL(url);
    feedUrl.searchParams.set('channel', releaseFeedChannel(channel));
    const body = await this.fetchJson(feedUrl.href, { Accept: 'application/json' });
    const release = parseFrameleafFeedRelease(body, channel);
    if (!release) {
      throw new Error('Release feed returned no release');
    }
    return release;
  }

  /**
   * Stable reads the latest published GitHub release; Release candidate reads the recent releases and
   * includes prereleases. The version is parsed from the `frameleaf-v<semver>-<n>` tag.
   *
   * Our release script never marks a GitHub release as a prerelease, so `/releases/latest` can be a
   * release-candidate tag; Stable then falls back to the release list and its newest stable tag. A withdrawn
   * release is marked a prerelease as well as withdrawn, so Stable skips it either way. Releases whose body
   * withdraws them or stages them past this server, and the `excluded` version, are skipped; when Frameleaf
   * releases exist but none is offered, the answer is `null`.
   */
  private async getGitHubRelease(
    url: string,
    channel: ReleaseChannel,
    rolloutSeed: string,
    excluded?: string,
  ): Promise<VersionResponse | null> {
    const includePrerelease = channel === ReleaseChannel.ReleaseCandidate;
    const offered = (release: GitHubRelease, tag: FrameleafReleaseTag) =>
      tag.version !== excluded && isReleaseOffered(parseReleaseBodyFlags(release.body), rolloutSeed, tag.version);
    let newest = includePrerelease
      ? undefined
      : newestFrameleafRelease([(await this.fetchReleases(`${url}/latest`)) as GitHubRelease], false, offered);
    if (!newest) {
      const releases = await this.fetchReleases(`${url}?per_page=30`);
      const list = Array.isArray(releases) ? releases : [releases];
      newest = newestFrameleafRelease(list, includePrerelease, offered);
      if (!newest && newestFrameleafRelease(list, true)) {
        return null;
      }
    }
    if (!newest) {
      throw new Error('No Frameleaf release tag found');
    }
    return { version: `v${newest.tag.version}`, published_at: newest.release.published_at ?? '' };
  }

  private fetchReleases(url: string) {
    return this.fetchJson(url, {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }) as Promise<GitHubRelease | GitHubRelease[]>;
  }

  /**
   * One release lookup. Every request gives up after 10 seconds, sends only a generic user agent, and a
   * failure names the HTTP status and any rate-limit reset or Retry-After.
   */
  private async fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
    const response = await fetch(url, {
      headers: { ...headers, 'User-Agent': 'Frameleaf-Server' },
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
    return response.json();
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
