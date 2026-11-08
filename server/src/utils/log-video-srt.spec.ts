import { getDjiSrtCandidates, parseDjiSrtColorMode } from 'src/utils/log-video-srt.js';

const caption = (colorMode: string) => `1
00:00:00,000 --> 00:00:00,033
<font size="28">FrameCnt: 1, DiffTime: 33ms
2024-05-01 10:00:00.000
[iso : 100] [shutter : 1/200.0] [fnum : 1.7] [ev : 0] [color_md : ${colorMode}] [focal_len : 24.00] [latitude: 51.500000] [longitude: -0.120000] [rel_alt: 30.000 abs_alt: 80.000] [ct : 5500] </font>

2
00:00:00,033 --> 00:00:00,066
<font size="28">FrameCnt: 2, DiffTime: 33ms
[iso : 100] [shutter : 1/200.0] [fnum : 1.7] [ev : 0] [color_md : ${colorMode}] [focal_len : 24.00] </font>
`;

describe('parseDjiSrtColorMode', () => {
  it.each(['dlog_m', 'd_log', 'default', 'hlg'])('reads color_md %s', (mode) => {
    expect(parseDjiSrtColorMode(caption(mode))).toBe(mode);
  });

  it('tolerates spacing and case', () => {
    expect(parseDjiSrtColorMode('[Color_MD:D-Log]')).toBe('d-log');
  });

  it('returns null for an SRT without a colour mode or for other text', () => {
    expect(parseDjiSrtColorMode('1\n00:00:00,000 --> 00:00:01,000\nHello\n')).toBeNull();
    expect(parseDjiSrtColorMode('')).toBeNull();
  });
});

describe('getDjiSrtCandidates', () => {
  it('looks for DJI_0001.SRT and DJI_0001.srt beside the clip', () => {
    expect(getDjiSrtCandidates('/library/drone/DJI_0001.MP4')).toEqual([
      '/library/drone/DJI_0001.SRT',
      '/library/drone/DJI_0001.srt',
    ]);
  });
});
