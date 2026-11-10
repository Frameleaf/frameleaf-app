import { stillConverters } from 'src/utils/still-converters.js';

describe('stillConverters (FL-1356)', () => {
  it.each([
    ['old.JPG', ['djpeg', 'ffmpeg']],
    ['old.jfi', ['djpeg', 'ffmpeg']],
    ['stereo.jps', ['djpeg', 'ffmpeg']],
    ['windows.wdp', ['jxrlib', 'ffmpeg']],
    ['scan.cin', ['magick', 'ffmpeg']],
    ['clip.PCT', ['magick', 'ffmpeg']],
    ['photo.png', ['ffmpeg']],
    ['photo.heic', ['ffmpeg']],
  ])('%s is offered to %j, in that order', (filename, rungs) => {
    expect(stillConverters(filename).map(({ rung }) => rung)).toEqual(rungs);
  });

  it('reports a decoder that is not installed as a failure of that rung only', async () => {
    vi.stubEnv('PATH', '/nonexistent');
    try {
      const [{ convert }] = stillConverters('photo.png');
      await expect(convert('/nonexistent/in.png', '/nonexistent/out.png')).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
