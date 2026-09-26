import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { MediaRepository } from 'src/repositories/media.repository.js';

export const newMediaRepositoryMock = (): Mocked<RepositoryInterface<MediaRepository>> => {
  return {
    generateThumbnail: vitest.fn().mockImplementation(() => Promise.resolve()),
    writeExif: vitest.fn().mockImplementation(() => Promise.resolve()),
    removeLocation: vitest.fn().mockResolvedValue(true),
    copyTagGroup: vitest.fn().mockImplementation(() => Promise.resolve()),
    generateThumbhash: vitest.fn().mockResolvedValue(Buffer.from('')),
    decodeImage: vitest.fn().mockResolvedValue({ data: Buffer.from(''), info: {} }),
    extract: vitest.fn().mockResolvedValue(null),
    probe: vitest.fn(),
    probePackets: vitest.fn().mockResolvedValue({
      totalDuration: 0,
      packetCount: 0,
      outputFrames: 0,
      keyframePts: [],
      keyframeAccDuration: [],
      keyframeOwnDuration: [],
    }),
    transcode: vitest.fn(),
    getImageMetadata: vitest.fn(),
    getOrientedSize: vitest.fn().mockResolvedValue({ width: 0, height: 0 }),
    scoreThumbnailCandidate: vitest.fn().mockResolvedValue(0),
    composeImageGrid: vitest.fn().mockImplementation(() => Promise.resolve()),
    writeCloudUpload: vitest.fn().mockImplementation(() => Promise.resolve()),
    renderDevelopGeometry: vitest
      .fn()
      .mockImplementation((data: Buffer, info: unknown) => Promise.resolve({ data, info })),
    encodeDevelopOutput: vitest.fn().mockResolvedValue(Buffer.from('')),
  };
};
