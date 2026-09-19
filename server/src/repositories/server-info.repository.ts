import { Injectable } from '@nestjs/common';
import { exiftool } from 'exiftool-vendored';
import { exec as execCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { ReleaseChannel } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

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

  getLatestRelease(_channel: ReleaseChannel): Promise<VersionResponse> {
    return Promise.reject(new Error('External version checks are disabled in this fork'));
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
