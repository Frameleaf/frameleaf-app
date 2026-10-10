import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { StorageCore } from 'src/cores/storage.core.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioMediaService, getStudioMediaFolder } from 'src/services/studio-media.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newTestService } from 'test/utils.js';

/**
 * Studio timeline media against real ffmpeg, sharp and disk: a short clip with a tone on its left
 * channel and silence on its right is generated here, never committed, and everything made from it
 * lives in a temporary media location that is removed afterwards.
 */
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const assetId = '00000000-0000-4000-8000-0000000000f1';
const silentId = '00000000-0000-4000-8000-0000000000f2';
const ownerId = authStub.admin.user.id;

describe.skipIf(!hasFfmpeg)('StudioMediaService on real media', () => {
  let root: string;
  let clip: string;
  let silent: string;
  let sut: StudioMediaService;

  const ffmpeg = (...args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fl-studio-media-'));
    mkdirSync(join(root, 'encoded-video'));
    clip = join(root, 'encoded-video', 'clip.mp4');
    silent = join(root, 'encoded-video', 'silent.mp4');
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=25:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=4',
      '-filter_complex',
      '[1:a]pan=stereo|c0=c0|c1=0*c0[a]',
      '-map',
      '0:v',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      clip,
    );
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=180x320:rate=25:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      silent,
    );
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    clearConfigCache();
    const logger = LoggingRepository.create();
    const media = new MediaRepository(logger);
    const storage = new StorageRepository(logger);
    let mocks;
    ({ sut, mocks } = newTestService(StudioMediaService, { media, storage }));
    StorageCore.setMediaLocation(root);
    mocks.access.asset.checkOwnerAccess.mockImplementation((_userId, ids) => Promise.resolve(ids));
    mocks.asset.getForVideo.mockImplementation((id) =>
      Promise.resolve({
        ownerId,
        originalPath: '/nonexistent/original.mov',
        encodedVideoPath: id === assetId ? clip : silent,
        editedVideoPath: null,
      }),
    );
  });

  it('makes a sprite whose layout matches its index, and reuses it', async () => {
    const index = await sut.getFilmstrip(authStub.admin, assetId, { count: 6, height: 54, format: 'webp' });
    expect(index).toMatchObject({ frameWidth: 96, frameHeight: 54, columns: 6, rows: 1, spriteWidth: 576 });
    expect(index.durationMs).toBeGreaterThanOrEqual(3990);
    expect(index.durationMs).toBeLessThan(4100);
    expect(index.frames.map(({ timeMs }) => timeMs)).toEqual(
      [0, 1, 2, 3, 4, 5].map((slice) => Math.round((index.durationMs * (slice + 0.5)) / 6)),
    );

    const sprite = await sut.viewFilmstripSprite(authStub.admin, assetId, {
      count: 6,
      height: 54,
      format: 'webp',
      version: index.version,
    });
    const metadata = await sharp(sprite.path).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: index.spriteWidth, height: index.spriteHeight });

    const folder = getStudioMediaFolder(ownerId, assetId);
    expect(readdirSync(folder).toSorted()).toEqual([
      `filmstrip-${index.version}-6x54.webp`,
      `filmstrip-${index.version}-6x54.webp.json`,
    ]);
    await expect(sut.getFilmstrip(authStub.admin, assetId, { count: 6, height: 54, format: 'webp' })).resolves.toEqual(
      index,
    );
  });

  it('lays a portrait video out in narrow JPEG tiles', async () => {
    const index = await sut.getFilmstrip(authStub.admin, silentId, { count: 3, height: 64 });
    expect(index).toMatchObject({ frameWidth: 36, frameHeight: 64, mimeType: 'image/jpeg' });
    const sprite = await sut.viewFilmstripSprite(authStub.admin, silentId, { count: 3, height: 64 });
    expect(await sharp(sprite.path).metadata()).toMatchObject({ format: 'jpeg', width: 108, height: 64 });
  });

  it('measures the tone on the left channel and silence on the right', async () => {
    const result = await sut.getWaveform(authStub.admin, assetId, { buckets: 40, channels: 'all' });
    expect(result).toMatchObject({ hasAudio: true, bucketCount: 40 });
    expect(result.durationMs).toBeGreaterThan(3900);
    expect(result.durationMs).toBeLessThan(4200);
    const [left, right] = result.channels;
    expect(Math.max(...left.max.slice(2, 38))).toBeGreaterThan(0.1); // lavfi sine peaks at 1/8
    expect(Math.min(...left.min.slice(2, 38))).toBeLessThan(-0.1);
    expect(Math.max(...[...right.max, ...right.min].map((value) => Math.abs(value)))).toBeLessThan(0.01);

    const mono = await sut.getWaveform(authStub.admin, assetId, { buckets: 10 });
    expect(mono.channels).toHaveLength(1);
    expect(existsSync(join(getStudioMediaFolder(ownerId, assetId), `waveform-${mono.version}-mono.bin`))).toBe(true);
  });

  it('returns an empty waveform for a video without audio', async () => {
    await expect(sut.getWaveform(authStub.admin, silentId, {})).resolves.toMatchObject({
      hasAudio: false,
      channels: [],
    });
  });

  it('drops the cache when the video changes, and with the asset', async () => {
    const before = await sut.getWaveform(authStub.admin, silentId, {});
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=180x320:rate=25:duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      silent,
    );
    const after = await sut.getFilmstrip(authStub.admin, silentId, { count: 2 });
    expect(after.version).not.toBe(before.version);
    const folder = getStudioMediaFolder(ownerId, silentId);
    expect(readdirSync(folder).every((name) => name.includes(after.version))).toBe(true);

    await sut.onAssetDelete({ assetId: silentId, userId: ownerId });
    expect(existsSync(folder)).toBe(false);
  });
});
