import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from 'src/dtos/config.dto.js';
import { TranscodeHardwareAcceleration, TranscodeTarget, VideoCodec } from 'src/enum.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { BaseConfig, ThumbnailConfig } from 'src/utils/media.js';
import {
  STITCHED_VIDEO_LABEL,
  VideoProjection,
  detectVideoProjection,
  getDualFisheyeLensFov,
  getStitchGraph,
  getStitchedSize,
  isStitchedVideoProjection,
  planVideoStitch,
  toFilterComplex,
  toStitchedStream,
} from 'src/utils/video-360.js';
import { probeStub } from 'test/fixtures/media.stub.js';

/** What each camera's raw recording looks like to ffprobe (FL-968 research; no customer files). */
const fixtures = {
  // Insta360 X3/X4 at most resolutions: both lenses side by side in one HEVC track, 2:1
  insta360SideBySide: {
    fileName: 'VID_20250101_120000_00_001.insv',
    videoStreams: [{ index: 0, width: 5760, height: 2880 }],
  },
  // Insta360 at its top resolutions (and DJI Osmo 360): one square track per lens
  insta360TwoTracks: {
    fileName: 'VID_20250101_120000_00_002.insv',
    videoStreams: [
      { index: 0, width: 3840, height: 3840 },
      { index: 1, width: 3840, height: 3840 },
    ],
  },
  djiOsmo360: {
    fileName: 'CAM_20250801120000_0001_D.OSV',
    videoStreams: [
      { index: 0, width: 3840, height: 3840 },
      { index: 1, width: 3840, height: 3840 },
    ],
  },
  // Insta360 single-lens / 1-inch wide modules write a flat 16:9 picture into the same container
  insta360Flat: {
    fileName: 'VID_20250101_120000_00_003.insv',
    videoStreams: [{ index: 0, width: 3840, height: 2160 }],
  },
  // GoPro MAX 5.6K: tracks 0 and 5 at 4096×1344, GPMF telemetry as a `gpmd` data track
  goProMax: {
    fileName: 'GS010001.360',
    videoStreams: [
      { index: 0, width: 4096, height: 1344 },
      { index: 5, width: 4096, height: 1344 },
    ],
    dataStreams: [
      { handlerName: 'GoPro TCD', codecTag: 'tmcd' },
      { handlerName: 'GoPro MET', codecTag: 'gpmd' },
    ],
  },
  // A GoPro HERO clip: telemetry too, but one ordinary track
  goProHero: {
    fileName: 'GX010001.MP4',
    videoStreams: [{ index: 0, width: 3840, height: 2160 }],
    dataStreams: [{ handlerName: 'GoPro MET', codecTag: 'gpmd' }],
  },
  ordinary: { fileName: 'IMG_0001.MP4', videoStreams: [{ index: 0, width: 1920, height: 1080 }] },
};

describe('360° video detection (FL-968)', () => {
  it.each([
    ['an Insta360 side-by-side .insv', fixtures.insta360SideBySide, VideoProjection.DualFisheye],
    ['an Insta360 two-track .insv', fixtures.insta360TwoTracks, VideoProjection.DualFisheye],
    ['a DJI Osmo 360 .osv', fixtures.djiOsmo360, VideoProjection.DualFisheye],
    ['a GoPro MAX .360', fixtures.goProMax, VideoProjection.EquiangularCubemap],
    [
      'a GoPro MAX recording renamed to .mp4 (telemetry track)',
      { ...fixtures.goProMax, fileName: 'GS010001.MP4' },
      VideoProjection.EquiangularCubemap,
    ],
    ['a flat Insta360 single-lens recording', fixtures.insta360Flat, null],
    ['a GoPro HERO clip', fixtures.goProHero, null],
    ['an ordinary MP4', fixtures.ordinary, null],
    ['a side-by-side picture in an ordinary MP4', { ...fixtures.insta360SideBySide, fileName: 'export.mp4' }, null],
    [
      'a .360 file whose tracks are not a cubemap',
      { ...fixtures.goProMax, videoStreams: fixtures.ordinary.videoStreams },
      null,
    ],
  ])('reads %s', (_, signals, expected) => {
    expect(detectVideoProjection(signals)).toBe(expected);
  });

  it('labels a video with an equirectangular sv3d box', () => {
    expect(detectVideoProjection({ ...fixtures.ordinary, containerProjection: 'equirectangular' })).toBe(
      VideoProjection.Equirectangular,
    );
    expect(detectVideoProjection({ ...fixtures.ordinary, containerProjection: 'cubemap' })).toBeNull();
  });

  it('only treats the raw layouts as needing a stitch', () => {
    expect(isStitchedVideoProjection(VideoProjection.DualFisheye)).toBe(true);
    expect(isStitchedVideoProjection(VideoProjection.EquiangularCubemap)).toBe(true);
    expect(isStitchedVideoProjection(VideoProjection.Equirectangular)).toBe(false);
    expect(isStitchedVideoProjection(null)).toBe(false);
  });

  it.each([
    ['DJI', 'Osmo360', 190],
    ['Insta360', 'Insta360 ONE X2', 193],
    ['Insta360', 'Insta360 X3', 200],
    ['Insta360', 'Insta360 X4', 200],
    [null, null, 195],
  ])('uses the lens field of view for %s %s', (make, model, fov) => {
    expect(getDualFisheyeLensFov(make, model)).toBe(fov);
  });
});

describe('360° stitch plans and commands (FL-968)', () => {
  const plan = (
    projectionType: string,
    signals: { videoStreams: Array<{ index: number; width: number; height: number }> },
    model?: string,
  ) => planVideoStitch({ projectionType, make: null, model, videoStreams: signals.videoStreams })!;

  it('plans each layout at its full equirectangular size', () => {
    expect(plan(VideoProjection.DualFisheye, fixtures.insta360SideBySide)).toMatchObject({
      layout: 'side-by-side',
      width: 5760,
      height: 2880,
    });
    expect(plan(VideoProjection.DualFisheye, fixtures.djiOsmo360)).toMatchObject({
      layout: 'two-streams',
      width: 7680,
      height: 3840,
    });
    expect(plan(VideoProjection.EquiangularCubemap, fixtures.goProMax)).toMatchObject({
      face: 1344,
      overlap: 32,
      width: 5376,
      height: 2688,
    });
  });

  it('refuses a plan when the tracks no longer fit the stored layout', () => {
    expect(
      planVideoStitch({ projectionType: VideoProjection.DualFisheye, videoStreams: fixtures.ordinary.videoStreams }),
    ).toBeNull();
    expect(
      planVideoStitch({
        projectionType: VideoProjection.EquiangularCubemap,
        videoStreams: fixtures.insta360SideBySide.videoStreams,
      }),
    ).toBeNull();
    expect(
      planVideoStitch({
        projectionType: VideoProjection.Equirectangular,
        videoStreams: fixtures.insta360SideBySide.videoStreams,
      }),
    ).toBeNull();
  });

  it('caps the stitched size and keeps it 2:1 and even', () => {
    const goPro = plan(VideoProjection.EquiangularCubemap, fixtures.goProMax);
    expect(getStitchedSize(goPro, 1920)).toEqual({ width: 3840, height: 1920 });
    expect(getStitchedSize(goPro)).toEqual({ width: 5376, height: 2688 });
    expect(getStitchedSize({ height: 1001 }, 4000)).toEqual({ width: 2000, height: 1000 });
  });

  it('builds the dual-fisheye graph for one side-by-side track', () => {
    const graph = getStitchGraph(plan(VideoProjection.DualFisheye, fixtures.insta360SideBySide, 'Insta360 X3'), {
      width: 3840,
      height: 1920,
    });
    expect(toFilterComplex(graph, [graph.projection, 'format=yuv420p'])).toBe(
      '[0:0]v360=input=dfisheye:output=equirect:ih_fov=200:iv_fov=200:w=3840:h=1920:interp=cubic,format=yuv420p[stitched]',
    );
  });

  it('puts two lens tracks side by side before projecting', () => {
    const graph = getStitchGraph(plan(VideoProjection.DualFisheye, fixtures.djiOsmo360, 'Osmo360'), {
      width: 3840,
      height: 1920,
    });
    expect(toFilterComplex(graph, [graph.projection])).toBe(
      '[0:0][0:1]hstack=inputs=2,v360=input=dfisheye:output=equirect:ih_fov=190:iv_fov=190:w=3840:h=1920:interp=cubic[stitched]',
    );
  });

  it('crops the GoPro blending bands and stacks the two tracks into an EAC picture', () => {
    const graph = getStitchGraph(plan(VideoProjection.EquiangularCubemap, fixtures.goProMax), {
      width: 3840,
      height: 1920,
    });
    const value = toFilterComplex(graph, [graph.projection]);
    expect(value).toContain('[0:0]split=3[gta][gtb][gtc];');
    expect(value).toContain(
      '[gta]crop=1344:1344:0:0[gtl];[gtb]crop=1344:1344:1376:0[gtf];[gtc]crop=1344:1344:2752:0[gtr]',
    );
    expect(value).toContain('[0:5]split=3[gba][gbb][gbc];');
    expect(value).toMatch(
      /\[gt\]\[gb\]vstack=inputs=2,v360=input=eac:output=equirect:w=3840:h=1920:interp=cubic\[stitched\]$/,
    );
  });

  it('stacks GoPro tracks directly when they carry no blending band', () => {
    const graph = getStitchGraph(
      plan(VideoProjection.EquiangularCubemap, {
        videoStreams: [
          { index: 0, width: 300, height: 100 },
          { index: 1, width: 300, height: 100 },
        ],
      }),
      { width: 400, height: 200 },
    );
    expect(toFilterComplex(graph, [graph.projection])).toBe(
      '[0:0][0:1]vstack=inputs=2,v360=input=eac:output=equirect:w=400:h=200:interp=cubic[stitched]',
    );
  });

  describe('encoder commands', () => {
    const video = probeStub.videoStreamH264.videoStream;
    const sideBySide = plan(VideoProjection.DualFisheye, fixtures.insta360SideBySide);
    const size = getStitchedSize(sideBySide, 1920);
    const stitchedStream = toStitchedStream(video, sideBySide, size);

    it('maps the stitched picture, in software, for a playback copy', () => {
      const command = BaseConfig.createStitched(
        { ...defaults.ffmpeg, accel: TranscodeHardwareAcceleration.Nvenc, targetResolution: 'original' },
        getStitchGraph(sideBySide, size),
      ).getCommand(TranscodeTarget.All, stitchedStream, probeStub.audioStreamAac.audioStream);
      const options = command.outputOptions;
      expect(options[options.indexOf('-c:v') + 1]).toBe('libx264');
      expect(options[options.indexOf('-map') + 1]).toBe(STITCHED_VIDEO_LABEL);
      expect(options).not.toContain('-vf');
      expect(options[options.indexOf('-filter_complex') + 1]).toBe(
        '[0:0]v360=input=dfisheye:output=equirect:ih_fov=195:iv_fov=195:w=3840:h=1920:interp=cubic[stitched]',
      );
      expect(stitchedStream).toMatchObject({ index: 0, width: 3840, height: 1920, rotation: 0 });
    });

    it('leaves an ordinary command unchanged', () => {
      const command = BaseConfig.create(
        { ...defaults.ffmpeg, targetVideoCodec: VideoCodec.H264 },
        { dri: [], mali: false },
      ).getCommand(TranscodeTarget.All, video);
      expect(command.outputOptions).not.toContain('-filter_complex');
      expect(command.outputOptions[command.outputOptions.indexOf('-map') + 1]).toBe(`0:${video.index}`);
    });

    it('selects the thumbnail frame before projecting, then scales', () => {
      const command = new ThumbnailConfig(
        { ...defaults.ffmpeg, targetResolution: '250' },
        0,
        getStitchGraph(sideBySide, size),
      ).getCommand(TranscodeTarget.Video, stitchedStream);
      const options = command.outputOptions;
      expect(options.slice(0, 2)).toEqual(['-map', STITCHED_VIDEO_LABEL]);
      const graph = options[options.indexOf('-filter_complex') + 1];
      expect(graph.startsWith('[0:0]fps=12')).toBe(true);
      expect(graph.indexOf('reverse')).toBeLessThan(graph.indexOf('v360='));
      expect(graph.indexOf('v360=')).toBeLessThan(graph.indexOf('scale=-2:250'));
      expect(graph.endsWith(STITCHED_VIDEO_LABEL)).toBe(true);
    });
  });
});

const hasFfmpeg = (() => {
  try {
    return execFileSync('ffmpeg', ['-hide_banner', '-filters'], { stdio: 'pipe' }).toString().includes(' v360 ');
  } catch {
    if (process.env.CI) {
      throw new Error('[video-360.spec] ffmpeg is not installed on CI; the stitch commands must run');
    }
    return false;
  }
})();

describe.runIf(hasFfmpeg)('360° stitch commands run in ffmpeg (FL-968)', () => {
  let dir: string;
  const media = new MediaRepository({ setContext: vi.fn() } as never);
  const synth = (name: string, inputs: string[]) => {
    const file = join(dir, name);
    const args = ['-v', 'error', '-y'];
    for (const input of inputs) {
      args.push('-f', 'lavfi', '-i', `${input}:d=0.5:r=10`);
    }
    for (const index of inputs.keys()) {
      args.push('-map', String(index));
    }
    execFileSync('ffmpeg', [...args, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mp4', file], { stdio: 'pipe' });
    return file;
  };
  const dimensions = (file: string) => {
    const [width, height] = execFileSync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      file,
    ])
      .toString()
      .trim()
      .split(',')
      .map(Number);
    return { width, height };
  };
  const run = async (input: string, fileName: string, thumbnail = false) => {
    const { videoStreams } = await media.probe(input);
    const projectionType = detectVideoProjection({ fileName, videoStreams });
    const stitch = planVideoStitch({ projectionType, videoStreams });
    expect(stitch).not.toBeNull();
    const size = getStitchedSize(stitch!, 64);
    const stream = toStitchedStream(videoStreams[0], stitch!, size);
    const graph = getStitchGraph(stitch!, size);
    const command = thumbnail
      ? new ThumbnailConfig({ ...defaults.ffmpeg, targetResolution: '32' }, 0, graph).getCommand(
          TranscodeTarget.Video,
          stream,
        )
      : BaseConfig.createStitched(
          { ...defaults.ffmpeg, targetResolution: 'original', preset: 'ultrafast' },
          graph,
        ).getCommand(TranscodeTarget.Video, stream);
    const output = join(dir, thumbnail ? `${fileName}.jpg` : `${fileName}.mp4`);
    execFileSync('ffmpeg', ['-y', ...command.inputOptions, '-i', input, ...command.outputOptions, output], {
      stdio: 'pipe',
    });
    return { projectionType, output };
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'frameleaf-video-360-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stitches a side-by-side dual-fisheye recording', async () => {
    const input = synth('side.insv', ['testsrc=size=128x64']);
    const { projectionType, output } = await run(input, 'side.insv');
    expect(projectionType).toBe(VideoProjection.DualFisheye);
    expect(dimensions(output)).toEqual({ width: 128, height: 64 });
  });

  it('stitches a two-track dual-fisheye recording', async () => {
    const input = synth('two.osv', ['testsrc=size=64x64', 'testsrc2=size=64x64']);
    const { projectionType, output } = await run(input, 'two.osv');
    expect(projectionType).toBe(VideoProjection.DualFisheye);
    expect(dimensions(output)).toEqual({ width: 128, height: 64 });
  });

  it('stitches a GoPro-style two-track cubemap recording, and thumbnails it', async () => {
    // 3 faces of 32 px plus a 2×4 px blending band, like 4096×1344 scaled down
    const input = synth('max.360', ['testsrc=size=104x32', 'testsrc2=size=104x32']);
    const { projectionType, output } = await run(input, 'max.360');
    expect(projectionType).toBe(VideoProjection.EquiangularCubemap);
    expect(dimensions(output)).toEqual({ width: 128, height: 64 });

    const thumbnail = await run(input, 'max.360', true);
    expect(dimensions(thumbnail.output)).toEqual({ width: 64, height: 32 });
  });
});
