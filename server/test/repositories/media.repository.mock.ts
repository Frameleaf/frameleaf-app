import { Mocked, vitest } from 'vitest';
import type { RepositoryInterface } from 'src/types.js';
import { MediaRepository } from 'src/repositories/media.repository.js';

export const newMediaRepositoryMock = (): Mocked<RepositoryInterface<MediaRepository>> => {
  return {
    getHdrCodecCapabilities: vitest.fn().mockResolvedValue(null),
    hasLibplacebo: vitest.fn().mockResolvedValue(false),
    inspectImageEncoding: vitest.fn().mockResolvedValue({
      dynamicRange: 'unknown',
      gainMap: 'none',
      referenceWhite: 203,
      reconstructionAvailable: false,
    }),
    decodeHdrImage: vitest.fn(),
    encodeHdrImage: vitest.fn(),
    exportPhotoStill: vitest.fn(),
    generateHdrRenditions: vitest.fn(),
    onModuleInit: vitest.fn(),
    onModuleDestroy: vitest.fn().mockResolvedValue(undefined),
    generateThumbnail: vitest.fn().mockImplementation(() => Promise.resolve()),
    generateImageThumbnails: vitest.fn().mockResolvedValue({
      info: { width: 0, height: 0, channels: 3 },
      thumbhash: Buffer.from(''),
      isTransparent: false,
    }),
    writeExif: vitest.fn().mockImplementation(() => Promise.resolve()),
    removeLocation: vitest.fn().mockResolvedValue(true),
    copyTagGroup: vitest.fn().mockImplementation(() => Promise.resolve()),
    generateThumbhash: vitest.fn().mockResolvedValue(Buffer.from('')),
    renderFontSpecimen: vitest.fn().mockResolvedValue(Buffer.from('')),
    readFontFacts: vitest.fn(),
    extractAssetPalette: vitest.fn().mockResolvedValue({ swatches: [], hasTransparency: false }),
    decodeImage: vitest.fn().mockResolvedValue({ data: Buffer.from(''), info: {} }),
    extract: vitest.fn().mockResolvedValue(null),
    renderRaw: vitest.fn(),
    probe: vitest.fn(),
    readContainerLogSignals: vitest
      .fn()
      .mockResolvedValue({ sampleEntryLogTag: null, sonyCaptureGamma: null, sonyCaptureGamut: null }),
    ensureColorLut: vitest
      .fn()
      .mockImplementation((fileName: string) => Promise.resolve(`/tmp/frameleaf-color-luts/${fileName}`)),
    probeEmbeddedSubtitles: vitest.fn(),
    probeHdrMastering: vitest.fn().mockResolvedValue([]),
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
    composeFilmstrip: vitest.fn().mockImplementation(() => Promise.resolve()),
    filmstripFrameGrids: vitest.fn().mockResolvedValue([]),
    writeCloudUpload: vitest.fn().mockImplementation(() => Promise.resolve()),
    writeStrippedStill: vitest.fn().mockImplementation(() => Promise.resolve()),
    repairJpeg: vitest.fn(),
    pictureSaved: vitest.fn().mockResolvedValue(100),
    renderDevelopGeometry: vitest
      .fn()
      .mockImplementation((data: Buffer, info: unknown) => Promise.resolve({ data, info })),
    encodeDevelopOutput: vitest.fn().mockResolvedValue(Buffer.from('')),
    normalizeDevelopArtifact: vitest.fn(),
    decodeDevelopArtifact: vitest.fn(),
  };
};
