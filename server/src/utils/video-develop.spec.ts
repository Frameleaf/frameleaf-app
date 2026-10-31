import { VideoDevelopPreset } from 'src/dtos/editing.dto.js';
import { effectiveVideoDevelop, videoDevelopFilters } from 'src/utils/video-develop.js';

describe('video develop (FL-113)', () => {
  it('renders nothing for the untouched develop model', () => {
    expect(videoDevelopFilters({})).toEqual([]);
    expect(videoDevelopFilters({ preset: VideoDevelopPreset.Original })).toEqual([]);
  });

  it('scales a look by its strength, as the still renderer does', () => {
    const { params, look } = effectiveVideoDevelop({
      preset: VideoDevelopPreset.Noir,
      presetStrength: 50,
      contrast: 10,
    });
    expect(params.contrast).toBe(28);
    expect(params.vignette).toBe(20);
    expect(look).toEqual({ grayscale: 50, sepia: 0 });
  });

  it('knows the video-only B&W look', () => {
    const { params, look } = effectiveVideoDevelop({ preset: VideoDevelopPreset.BlackAndWhite });
    expect(params.contrast).toBe(24);
    expect(look.grayscale).toBe(100);
  });

  it('samples the tone curve with monotonic points that start at 0 and end at 1', () => {
    const [curves] = videoDevelopFilters({ exposure: 1 });
    const points = /r='([^']+)'/
      .exec(curves)![1]
      .split(' ')
      .map((point) => point.split('/').map(Number));
    expect(points).toHaveLength(17);
    expect(points[0][0]).toBe(0);
    expect(points.at(-1)![0]).toBe(1);
    // Brighter everywhere but black.
    expect(points[8][1]).toBeGreaterThan(0.5);
  });

  it('mixes grayscale and sepia in one exact matrix', () => {
    const filters = videoDevelopFilters({ preset: VideoDevelopPreset.Silvertone });
    const mixer = filters.find((filter) => filter.startsWith('colorchannelmixer='));
    expect(mixer).toBeDefined();
    // Silvertone is grayscale then 18% sepia: the rows are no longer equal.
    expect(mixer).not.toContain('rr=0.2126:rg=0.7152:rb=0.0722:gr=0.2126');
  });

  it('maps the detail and effect sliders to stock filters', () => {
    const filters = videoDevelopFilters({ noiseReduction: 50, sharpen: 40, clarity: 30, vignette: -40, grain: 50 });
    expect(filters).toEqual([
      'hqdn3d=3',
      'unsharp=5:5:0.6',
      'unsharp=13:13:0.24',
      expect.stringMatching(/^vignette=angle=[\d.]+:mode=backward$/),
      'noise=alls=15:allf=t',
    ]);
  });

  it('renders negative clarity as zero, like the still renderer', () => {
    expect(videoDevelopFilters({ clarity: -50 })).toEqual([]);
  });
});
