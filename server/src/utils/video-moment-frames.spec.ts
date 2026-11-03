import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from 'src/config.js';
import { withTemporaryFrames } from 'src/utils/video-moment-frames.js';
import { lockedFixture } from 'test/fixtures/locked.stub.js';

const OWNER = '00000000-0000-4000-8000-000000000001';

describe(withTemporaryFrames.name, () => {
  const deps = (originalPath: string) => ({
    moments: {
      getVideoSource: vi.fn().mockResolvedValue({
        originalPath,
        duration: null,
        format: {
          formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
          formatLongName: 'QuickTime / MOV',
          duration: 10_000,
          bitrate: 0,
        },
        videoStream: {
          index: 0,
          width: 640,
          height: 360,
          rotation: 0,
          codecName: 'h264',
          frameCount: 300,
          isHDR: false,
          bitrate: 0,
          pixelFormat: 'yuv420p',
          fps: 30,
        },
      }),
    },
    media: {
      transcode: vi.fn().mockImplementation((_input: string, output: string) => fs.writeFile(output, 'frame')),
      scoreThumbnailCandidate: vi.fn().mockResolvedValue(1),
      getImageMetadata: vi.fn().mockResolvedValue({ width: 640, height: 360 }),
    },
    storage: { mkdirSync: vi.fn(), unlink: vi.fn().mockResolvedValue(undefined) },
    logger: { warn: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn() },
  });
  const config = { ffmpeg: defaults.ffmpeg, image: defaults.image };
  const framesOf = async (video: string) => {
    const d = deps(video);
    const paths = await withTemporaryFrames(d as never, 'asset-1', config, (frames) =>
      Promise.resolve(frames.map(({ path }) => path)),
    );
    return { paths, warnings: d.logger.warn.mock.calls };
  };

  it('cuts the frames of an encrypted video inside the RAM-backed Locked folder (FL-721 M6)', async () => {
    const locked = await lockedFixture(OWNER);
    try {
      locked.loadKey();
      const video = await locked.seal('clip.mp4', 'plain video', 'video/mp4');

      const { paths, warnings } = await framesOf(video);

      expect(warnings).toEqual([]);
      expect(paths?.length).toBeGreaterThan(0);
      for (const path of paths!) {
        expect(path.startsWith(`${locked.tmp}/`)).toBe(true);
      }
      expect(await locked.copiesLeft()).toBe(0);
    } finally {
      await locked.cleanup();
    }
  });

  it('cuts the frames of a plain video in the OS temp folder', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'moment-frames-'));
    try {
      const video = join(dir, 'clip.mp4');
      await fs.writeFile(video, 'plain video');

      const { paths, warnings } = await framesOf(video);

      expect(warnings).toEqual([]);
      expect(paths?.[0].startsWith(join(tmpdir(), 'frameleaf-moment-preview-'))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
