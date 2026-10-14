import { Kysely } from 'kysely';
import { AssetType } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { VideoStreamRepository } from 'src/repositories/video-stream.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let sut: VideoStreamRepository;

beforeAll(async () => {
  db = await getKyselyDB();
  sut = new VideoStreamRepository(db);
});

afterAll(async () => db?.destroy());

const videoStream = {
  index: 0,
  codecName: 'h264',
  profile: null,
  level: null,
  bitrate: 200_000,
  width: 1920,
  height: 1080,
  pixelFormat: 'yuv420p',
  frameCount: 300,
  frameRate: 30,
  timeBase: 1000,
  rotation: 0,
  colorPrimaries: 1,
  colorMatrix: 1,
  colorTransfer: 1,
  dvProfile: null,
  dvLevel: null,
  dvBlSignalCompatibilityId: null,
};
const packets = {
  keyframePts: [0, 1000],
  keyframeAccDuration: [1000, 2000],
  keyframeOwnDuration: [1000, 1000],
  totalDuration: 2000,
  packetCount: 60,
  outputFrames: 60,
};
const audioStream = {
  index: 1,
  codecName: 'aac',
  profile: null,
  bitrate: 100_000,
  channels: 2,
  channelLayout: 'stereo',
  sampleRate: 48_000,
};
const format = { formatName: 'mov', formatLongName: 'QuickTime', duration: 2000, bitrate: 200_000 };

async function seed({ audio = true, orientation = '1' } = {}) {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, duration: 2000 });
  await ctx.newExif({ assetId: asset.id, exifImageWidth: 1920, exifImageHeight: 1080, fps: 30, orientation });
  const { width: _width, height: _height, frameRate: _frameRate, rotation: _rotation, ...video } = videoStream;
  await db
    .insertInto('asset_video')
    .values({ assetId: asset.id, ...video, formatName: format.formatName, formatLongName: format.formatLongName })
    .execute();
  await db
    .insertInto('asset_keyframe')
    .values({
      assetId: asset.id,
      pts: packets.keyframePts,
      accDuration: packets.keyframeAccDuration,
      ownDuration: packets.keyframeOwnDuration,
      totalDuration: packets.totalDuration,
      packetCount: packets.packetCount,
      outputFrames: packets.outputFrames,
    })
    .execute();
  if (audio) {
    await db
      .insertInto('asset_audio')
      .values({ assetId: asset.id, ...audioStream })
      .execute();
  }
  const { id: sessionId } = await sut.createSession({ assetId: asset.id, expiresAt: new Date(Date.now() + 60_000) });
  return { asset, sessionId };
}

describe('video streaming query contracts', () => {
  it.each([
    ['1', 0],
    ['6', -90],
    ['8', 90],
    ['3', 180],
  ] as const)('preserves all playlist and transcoding fields for orientation %s', async (orientation, rotation) => {
    const { asset, sessionId } = await seed({ orientation });
    const playlist = { videoStream: { ...videoStream, rotation }, packets };
    expect(await sut.getForMainPlaylist(asset.id)).toEqual(playlist);
    expect(await sut.getForMediaPlaylist(asset.id, sessionId)).toEqual(playlist);
    expect(await sut.getForTranscoding(asset.id)).toEqual({
      ...playlist,
      audioStream,
      format,
      originalPath: asset.originalPath,
    });
  });

  it('retains videos without audio and exposes a null audio stream', async () => {
    const { asset, sessionId } = await seed({ audio: false });
    expect(await sut.getForMainPlaylist(asset.id)).toEqual({ videoStream, packets });
    expect(await sut.getForMediaPlaylist(asset.id, sessionId)).toEqual({ videoStream, packets });
    expect(await sut.getForTranscoding(asset.id)).toEqual({
      videoStream,
      packets,
      audioStream: null,
      format,
      originalPath: asset.originalPath,
    });
  });

  it.each(['asset_exif', 'asset_video', 'asset_keyframe'] as const)(
    'requires %s metadata for all three queries',
    async (table) => {
      const { asset, sessionId } = await seed();
      await db.deleteFrom(table).where('assetId', '=', asset.id).execute();
      expect(await sut.getForMainPlaylist(asset.id)).toBeUndefined();
      expect(await sut.getForMediaPlaylist(asset.id, sessionId)).toBeUndefined();
      expect(await sut.getForTranscoding(asset.id)).toBeUndefined();
    },
  );

  it('binds media playlists to the requested asset and an unexpired session', async () => {
    const first = await seed();
    const second = await seed();
    expect(await sut.getForMediaPlaylist(first.asset.id, second.sessionId)).toBeUndefined();
    await sut.extendSession(first.sessionId, new Date(0));
    expect(await sut.getForMediaPlaylist(first.asset.id, first.sessionId)).toBeUndefined();
    expect(await sut.getForMainPlaylist(first.asset.id)).toEqual({ videoStream, packets });
    expect(await sut.getForMediaPlaylist(second.asset.id, second.sessionId)).toEqual({ videoStream, packets });
    await sut.deleteSession(second.sessionId);
    expect(await sut.getForMediaPlaylist(second.asset.id, second.sessionId)).toBeUndefined();
  });
});
