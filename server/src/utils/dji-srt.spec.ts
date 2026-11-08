import { getDjiSrtCandidates, parseDjiSrtLocation } from 'src/utils/dji-srt.js';

describe('DJI telemetry subtitles (FL-968)', () => {
  it('looks for the .SRT next to the video, as .xmp sidecars are found', () => {
    expect(getDjiSrtCandidates('/library/DJI_0001.MP4')).toEqual(['/library/DJI_0001.SRT', '/library/DJI_0001.srt']);
  });

  it('reads the bracketed layout of current drones', () => {
    const srt = [
      '1',
      '00:00:00,000 --> 00:00:00,033',
      '<font size="28">FrameCnt: 1, DiffTime: 33ms',
      '2024-05-01 12:34:56.789',
      '[iso: 100] [shutter: 1/500.0] [fnum: 2.8] [ev: 0] [color_md: default] [focal_len: 24.00] [latitude: 47.376887] [longitude: 8.541694] [rel_alt: 1.200 abs_alt: 450.123] </font>',
      '',
    ].join('\n');
    expect(parseDjiSrtLocation(srt)).toEqual({ latitude: 47.376887, longitude: 8.541694 });
  });

  it("reads the Mavic Air 2's misspelt longitude and spaced colons", () => {
    expect(parseDjiSrtLocation('[latitude : -33.856784] [longtitude : 151.215297] [altitude: 12.3]')).toEqual({
      latitude: -33.856784,
      longitude: 151.215297,
    });
  });

  it('reads the GPS(longitude, latitude, altitude) layout of older drones', () => {
    expect(
      parseDjiSrtLocation('HOME(8.5400,47.3700) 2017.08.05 14:12:22\nGPS(8.541694,47.376887,19) BAROMETER:20.3'),
    ).toEqual({
      latitude: 47.376887,
      longitude: 8.541694,
    });
  });

  it('skips entries recorded before the satellite fix', () => {
    const srt = '[latitude: 0.000000] [longitude: 0.000000]\n\n[latitude: 51.500729] [longitude: -0.124625]';
    expect(parseDjiSrtLocation(srt)).toEqual({ latitude: 51.500729, longitude: -0.124625 });
  });

  it('returns null for an ordinary subtitle file or impossible values', () => {
    expect(parseDjiSrtLocation('1\n00:00:01,000 --> 00:00:02,000\nHello there\n')).toBeNull();
    expect(parseDjiSrtLocation('[latitude: 123.0] [longitude: 8.0]')).toBeNull();
    expect(parseDjiSrtLocation('')).toBeNull();
  });
});
