import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ColorPrimaries, ColorTransfer } from 'src/enum.js';
import { getStudioHdrProxyCommand, planStudioHdrProxy } from 'src/utils/studio-hdr-proxy.js';

const stream = (overrides: Partial<Parameters<typeof planStudioHdrProxy>[0]> = {}) => ({
  index: 0,
  colorPrimaries: ColorPrimaries.Bt2020,
  colorTransfer: ColorTransfer.Smpte2084,
  frameCount: 48,
  frameRate: 23.976,
  ...overrides,
});

describe('Studio HDR intermediate (FL-97)', () => {
  it('is made for BT.2020 PQ and HLG videos only', () => {
    expect(planStudioHdrProxy(stream())).toEqual({ eligible: true, transfer: 'smpte2084' });
    expect(planStudioHdrProxy(stream({ colorTransfer: ColorTransfer.AribStdB67 }))).toEqual({
      eligible: true,
      transfer: 'arib-std-b67',
    });
    expect(planStudioHdrProxy(stream({ colorTransfer: ColorTransfer.Bt709 })).eligible).toBe(false);
    expect(planStudioHdrProxy(stream({ colorTransfer: null })).eligible).toBe(false);
    expect(planStudioHdrProxy(stream({ colorPrimaries: ColorPrimaries.Bt709 })).eligible).toBe(false);
  });

  it('carries the signal: explicit BT.2020 tags, source transfer, 10-bit AV1, no metadata, passthrough timing', () => {
    const { outputOptions, twoPass, progress } = getStudioHdrProxyCommand(stream({ index: 2 }), 'arib-std-b67');
    const args = outputOptions.join(' ');
    expect(twoPass).toBe(false);
    expect(progress.frameCount).toBe(48);
    expect(args).toContain('-map 0:2 -an -sn -dn -map_metadata -1 -map_chapters -1 -fps_mode passthrough');
    expect(args).toContain('-c:v libsvtav1');
    expect(args).toContain('-pix_fmt yuv420p10le');
    expect(args).toContain('-color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -color_range tv');
    expect(args).toContain('-g 24');
    // never upscales, and only its size changes
    expect(args).toMatch(/scale=w='trunc\(iw\*min\(1,min\(3840\/max\(iw,ih\),2160\/min\(iw,ih\)\)\)\/2\)\*2'/);
    expect(args).toContain('setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv');
    expect(args).toContain('color-primaries=9:transfer-characteristics=18:matrix-coefficients=9:color-range=0');
    expect(args).not.toMatch(/tonemap|zscale|out_color_matrix/);
  });

  const hasEncoder = (() => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    return (
      result.status === 0 && result.stdout.includes('libsvtav1') && spawnSync('ffprobe', ['-version']).status === 0
    );
  })();

  it.skipIf(!hasEncoder)('produces a 10-bit AV1 PQ file whose signal matches the source', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fl-studio-hdr-'));
    try {
      const source = path.join(dir, 'source.mov');
      const output = path.join(dir, 'proxy.mp4');
      // 1000 cd/m² PQ grey (signal 0.7518 → Y' 723 of 1023 in limited range)
      const rgb = Buffer.alloc(64 * 32 * 6 * 12);
      for (let i = 0; i < rgb.length; i += 2) rgb.writeUInt16LE(Math.round(0.751827 * 65_535), i);
      writeFileSync(path.join(dir, 'in.rgb48'), rgb);
      const encode = spawnSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb48le',
        '-s',
        '64x32',
        '-r',
        '24',
        '-i',
        path.join(dir, 'in.rgb48'),
        '-vf',
        'scale=out_range=tv:out_color_matrix=bt2020,format=yuv422p10le',
        '-c:v',
        'prores_ks',
        '-color_primaries',
        'bt2020',
        '-color_trc',
        'smpte2084',
        '-colorspace',
        'bt2020nc',
        '-color_range',
        'tv',
        source,
      ]);
      expect(encode.status, encode.stderr?.toString()).toBe(0);
      const { outputOptions } = getStudioHdrProxyCommand(stream(), 'smpte2084');
      const proxy = spawnSync('ffmpeg', ['-v', 'error', '-i', source, ...outputOptions, output]);
      expect(proxy.status, proxy.stderr?.toString()).toBe(0);

      const probe = JSON.parse(
        spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' }).stdout,
      ).streams;
      expect(probe).toHaveLength(1);
      expect(probe[0]).toMatchObject({
        codec_name: 'av1',
        pix_fmt: 'yuv420p10le',
        color_primaries: 'bt2020',
        color_transfer: 'smpte2084',
        color_space: 'bt2020nc',
        color_range: 'tv',
        nb_frames: '12',
      });
      const luma = spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          output,
          '-frames:v',
          '1',
          '-vf',
          'extractplanes=y',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'gray10le',
          '-',
        ],
        { maxBuffer: 1 << 24 },
      ).stdout;
      const y = luma.readUInt16LE(2 * (16 * 64 + 32));
      expect(Math.abs(y - (64 + 0.751827 * 876))).toBeLessThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
