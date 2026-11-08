import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ColorMatrix, ColorPrimaries, ColorTransfer } from 'src/enum.js';
import {
  APPLE_LOG_2_TAG,
  APPLE_LOG_TAG,
  LOG_CURVES,
  LOG_GAMUTS,
  LOG_LUT_SIZE,
  LogCurveId,
  LogProfile,
  LogVideoEvidence,
  VENDORED_LUTS,
  bt709Oetf,
  buildLogLut,
  convertLogToRec709,
  detectLogVideo,
  getGamutToRec709Matrix,
  getLogInputForLinear,
  getLogLutFileName,
  getVendoredLutPath,
  readVendoredLut,
  softClip,
} from 'src/utils/log-video.js';

const MIDDLE_GREY_709 = bt709Oetf(0.18);

const PROFILES: LogProfile[] = [
  { curve: 'apple-log', gamut: 'rec2020' },
  { curve: 's-log3', gamut: 's-gamut3-cine' },
  { curve: 's-log3', gamut: 's-gamut3' },
  { curve: 'v-log', gamut: 'v-gamut' },
  { curve: 'canon-log', gamut: 'cinema-gamut' },
  { curve: 'canon-log2', gamut: 'cinema-gamut' },
  { curve: 'canon-log3', gamut: 'cinema-gamut' },
  { curve: 'f-log', gamut: 'rec2020' },
  { curve: 'f-log2', gamut: 'rec2020' },
  { curve: 'n-log', gamut: 'rec2020' },
  { curve: 'd-log', gamut: 'd-gamut' },
];

const parseLut = (text: string) => {
  const lines = text.trim().split('\n');
  const size = Number(lines.find((line) => line.startsWith('LUT_3D_SIZE'))!.split(' ', 2)[1]);
  const values = lines.filter((line) => /^[\d.]+ [\d.]+ [\d.]+$/.test(line)).map((line) => line.split(' ').map(Number));
  return { size, values, at: (r: number, g: number, b: number) => values[r + g * size + b * size * size] };
};

/** What tetrahedral interpolation (ffmpeg's lut3d default) gives on the neutral axis: the diagonal is an edge of every tetrahedron. */
const sampleNeutral = (lut: ReturnType<typeof parseLut>, input: number) => {
  const position = input * (lut.size - 1);
  const i = Math.min(lut.size - 2, Math.floor(position));
  const t = position - i;
  const [a, b] = [lut.at(i, i, i), lut.at(i + 1, i + 1, i + 1)];
  return a.map((v, channel) => v + (b[channel] - v) * t);
};

const evidence = (overrides: Partial<LogVideoEvidence> = {}): LogVideoEvidence => ({
  colorPrimaries: ColorPrimaries.Bt709,
  colorTransfer: ColorTransfer.Bt709,
  colorMatrix: ColorMatrix.Bt709,
  ...overrides,
});

describe('Log curves (published white-paper values)', () => {
  it.each<[LogCurveId, number, number, number]>([
    // Sony S-Log3 technical summary: 0% black = 95, 18% grey = 420, 90% white = 598 (10-bit code values)
    ['s-log3', 0, 95, 0.5],
    ['s-log3', 0.18, 420, 0.01],
    ['s-log3', 0.9, 598, 0.5],
    // Panasonic V-Log reference manual: 0% = 128, 18% = 433, 90% = 602
    ['v-log', 0, 128, 0.5],
    ['v-log', 0.18, 433, 0.5],
    ['v-log', 0.9, 602, 0.5],
    // Fujifilm F-Log data sheet: 0% = 95, 18% = 470, 90% = 705
    ['f-log', 0, 95, 0.5],
    ['f-log', 0.18, 470, 0.5],
    ['f-log', 0.9, 705, 0.5],
    // Fujifilm F-Log2 data sheet: 0% = 95
    ['f-log2', 0, 95, 0.5],
    // DJI D-Log white paper: black encodes to 0.0929 (code 95)
    ['d-log', 0, 95, 0.1],
    // Nikon N-Log specification: 650 * (0.18 + 0.0075)^(1/3) = 372
    ['n-log', 0.18, 372, 0.5],
  ])('%s encodes %f linear to 10-bit code %f', (curve, linear, code, tolerance) => {
    expect(Math.abs(LOG_CURVES[curve].encode(linear) * 1023 - code)).toBeLessThanOrEqual(tolerance);
  });

  it.each<[LogCurveId, number, number]>([
    // Apple Log Profile white paper: 18% grey encodes to P = 0.4882724; black (R = 0) to sigma * R0^2
    ['apple-log', 0.18, 0.4882724],
    ['apple-log', 0, 47.28711236 * 0.05641088 ** 2],
    // Canon white papers (IRE): Canon Log and Canon Log 3 put 18% grey at 34.34%, Canon Log 2 at 39.83%
    ['canon-log', 0.18, 0.343389],
    ['canon-log3', 0.18, 0.343389],
    ['canon-log2', 0.18, 0.398254],
    // DJI D-Log white paper: log10(0.18 * 0.9892 + 0.0108) * 0.256663 + 0.584555
    ['d-log', 0.18, 0.39876],
    // Canon Log 3 black sits on its linear segment at 12.51%
    ['canon-log3', 0, 0.12512219],
  ])('%s encodes %f linear to signal %f', (curve, linear, signal) => {
    expect(LOG_CURVES[curve].encode(linear)).toBeCloseTo(signal, 5);
  });

  it.each(Object.keys(LOG_CURVES) as LogCurveId[])('%s decodes what it encodes, across every segment', (curve) => {
    for (const linear of [-0.01, 0, 0.0005, 0.005, 0.012, 0.05, 0.18, 0.5, 0.9, 2, 8, 16]) {
      const { encode, decode } = LOG_CURVES[curve];
      // Apple Log clamps below its toe, which cannot round-trip
      if (curve === 'apple-log' && linear < -0.0564) {
        continue;
      }
      expect(decode(encode(linear))).toBeCloseTo(linear, 6);
    }
  });

  it.each(Object.keys(LOG_CURVES) as LogCurveId[])('%s decodes monotonically', (curve) => {
    let previous = -Infinity;
    for (let signal = 0; signal <= 1; signal += 1 / 1023) {
      const linear = LOG_CURVES[curve].decode(signal);
      expect(linear).toBeGreaterThanOrEqual(previous);
      previous = linear;
    }
  });
});

describe('gamut matrices', () => {
  it('is the identity for Rec.709', () => {
    const matrix = getGamutToRec709Matrix('rec709');
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(matrix[i][j]).toBeCloseTo(i === j ? 1 : 0, 9);
      }
    }
  });

  it('matches the published BT.2020 to BT.709 matrix (ITU-R BT.2087)', () => {
    const matrix = getGamutToRec709Matrix('rec2020');
    const published = [
      [1.6605, -0.5876, -0.0728],
      [-0.1246, 1.1329, -0.0083],
      [-0.0182, -0.1006, 1.1187],
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(matrix[i][j]).toBeCloseTo(published[i][j], 3);
      }
    }
  });

  it.each(Object.keys(LOG_GAMUTS) as Array<keyof typeof LOG_GAMUTS>)(
    'keeps neutral colours neutral for %s',
    (gamut) => {
      for (const row of getGamutToRec709Matrix(gamut)) {
        expect(row[0] + row[1] + row[2]).toBeCloseTo(1, 9);
      }
    },
  );
});

describe('tone curve', () => {
  it('leaves mid tones alone and rolls highlights off below white', () => {
    expect(softClip(0.18)).toBe(0.18);
    expect(softClip(0.6)).toBe(0.6);
    expect(softClip(1)).toBeGreaterThan(0.75);
    expect(softClip(1)).toBeLessThan(1);
    expect(softClip(16)).toBeLessThan(1);
    expect(softClip(-0.1)).toBe(0);
  });

  it('puts 18% grey at the Rec.709 middle grey code (about 41%)', () => {
    expect(MIDDLE_GREY_709).toBeCloseTo(0.409, 3);
  });
});

describe('convertLogToRec709', () => {
  it.each(PROFILES)('lands 18% grey on Rec.709 middle grey for $curve / $gamut', (profile) => {
    for (const range of ['tv', 'pc'] as const) {
      const input = getLogInputForLinear(0.18, profile, range);
      const out = convertLogToRec709([input, input, input], profile, range);
      for (const channel of out) {
        expect(channel).toBeCloseTo(MIDDLE_GREY_709, 6);
      }
    }
  });

  it('reads code-value curves through the limited-range expansion', () => {
    // S-Log3 18% grey is code 420; ffmpeg hands lut3d (420 - 64) / 876 for a limited-range stream
    expect(getLogInputForLinear(0.18, { curve: 's-log3', gamut: 's-gamut3-cine' }, 'tv')).toBeCloseTo(356 / 876, 6);
    expect(getLogInputForLinear(0.18, { curve: 's-log3', gamut: 's-gamut3-cine' }, 'pc')).toBeCloseTo(420 / 1023, 6);
    // Canon curves are video levels already
    expect(getLogInputForLinear(0.18, { curve: 'canon-log3', gamut: 'cinema-gamut' }, 'tv')).toBeCloseTo(0.343389, 5);
  });
});

describe('buildLogLut', () => {
  const profile: LogProfile = { curve: 's-log3', gamut: 's-gamut3-cine' };
  const text = buildLogLut(profile, 'tv');
  const lut = parseLut(text);

  it('writes a 33-point .cube file that ffmpeg lut3d reads', () => {
    expect(LOG_LUT_SIZE).toBe(33);
    expect(text).toContain('LUT_3D_SIZE 33\n');
    expect(text).toContain('DOMAIN_MIN 0.0 0.0 0.0\nDOMAIN_MAX 1.0 1.0 1.0\n');
    expect(text.startsWith('TITLE "Frameleaf S-Log3 / S-Gamut3.Cine to Rec.709"\n')).toBe(true);
    expect(lut.values).toHaveLength(33 ** 3);
    expect(lut.values.flat().every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it('orders entries with red changing fastest', () => {
    const expected = convertLogToRec709([1, 0, 0], profile, 'tv');
    expect(lut.at(32, 0, 0)).toEqual(expected.map((v) => Number(v.toFixed(6))));
    expect(lut.values[32]).toEqual(lut.at(32, 0, 0));
  });

  it.each(PROFILES)('is monotonic along the neutral axis and each channel for $curve / $gamut', (each) => {
    const table = parseLut(buildLogLut(each, 'tv', 17));
    for (let i = 1; i < table.size; i++) {
      for (let c = 0; c < 3; c++) {
        expect(table.at(i, i, i)[c]).toBeGreaterThanOrEqual(table.at(i - 1, i - 1, i - 1)[c]);
      }
      expect(table.at(i, 8, 8)[0]).toBeGreaterThanOrEqual(table.at(i - 1, 8, 8)[0]);
      expect(table.at(8, i, 8)[1]).toBeGreaterThanOrEqual(table.at(8, i - 1, 8)[1]);
      expect(table.at(8, 8, i)[2]).toBeGreaterThanOrEqual(table.at(8, 8, i - 1)[2]);
    }
  });

  it.each(PROFILES)('puts 18% grey near Rec.709 middle grey through the LUT for $curve / $gamut', (each) => {
    const table = each === profile ? lut : parseLut(buildLogLut(each, 'tv'));
    const out = sampleNeutral(table, getLogInputForLinear(0.18, each, 'tv'));
    for (const channel of out) {
      expect(Math.abs(channel - MIDDLE_GREY_709)).toBeLessThan(0.01);
    }
  });

  it('names the file after its profile, range, size and version', () => {
    expect(getLogLutFileName(profile, 'tv')).toBe('frameleaf-log-v1-s-log3-s-gamut3-cine-tv-33.cube');
  });
});

describe('detectLogVideo', () => {
  it('finds Apple Log from the sample entry logs box', () => {
    expect(
      detectLogVideo(
        evidence({
          colorPrimaries: ColorPrimaries.Bt2020,
          colorMatrix: ColorMatrix.Bt2020Nc,
          colorTransfer: ColorTransfer.Unknown,
          sampleEntryLogTag: APPLE_LOG_TAG,
        }),
      ),
    ).toEqual({
      profile: { curve: 'apple-log', gamut: 'rec2020' },
      signal: 'sample entry logs box',
      confidence: 'high',
    });
  });

  it('finds Apple Log from iPhone tagging when the box is not there', () => {
    expect(
      detectLogVideo(
        evidence({
          colorPrimaries: ColorPrimaries.Bt2020,
          colorMatrix: ColorMatrix.Bt2020Nc,
          colorTransfer: ColorTransfer.Unknown,
          tags: { Make: 'Apple', Model: 'iPhone 15 Pro' },
        }),
      ),
    ).toMatchObject({ profile: { curve: 'apple-log', gamut: 'rec2020' }, confidence: 'medium' });
  });

  it('leaves Apple Log 2 alone (Apple Wide Gamut is not converted)', () => {
    expect(
      detectLogVideo(
        evidence({
          colorMatrix: ColorMatrix.Bt2020Nc,
          colorPrimaries: ColorPrimaries.Unknown,
          colorTransfer: ColorTransfer.Unknown,
          sampleEntryLogTag: APPLE_LOG_2_TAG,
          tags: { Make: 'Apple' },
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ['s-log3-cine', 'S-Gamut3.Cine-SLog3', 's-gamut3-cine'],
    ['s-log3', 'S-Gamut3-SLog3', 's-gamut3'],
    ['s-log3-cine', null, 's-gamut3-cine'],
    ['s-log3', null, 's-gamut3'],
  ])('finds Sony S-Log3 from the XML (%s, %s)', (gamma, primaries, gamut) => {
    expect(detectLogVideo(evidence({ sonyCaptureGamma: gamma, sonyCaptureGamut: primaries }))).toEqual({
      profile: { curve: 's-log3', gamut },
      signal: 'Sony XML CaptureGammaEquation',
      confidence: 'high',
    });
  });

  it('does not treat Sony rec709 or HLG gammas as Log', () => {
    expect(detectLogVideo(evidence({ sonyCaptureGamma: 'rec709' }))).toBeNull();
    expect(detectLogVideo(evidence({ sonyCaptureGamma: 's-cinetone' }))).toBeNull();
  });

  it.each<[string, LogVideoEvidence['tags'], LogProfile]>([
    [
      'Sony picture profile',
      { Make: 'SONY', PictureProfile: 'Gamma S-Log3 (PP8 or PP9)' },
      { curve: 's-log3', gamut: 's-gamut3-cine' },
    ],
    [
      'Sony picture profile (numeric)',
      { Make: 'SONY', PictureProfile: 31 },
      { curve: 's-log3', gamut: 's-gamut3-cine' },
    ],
    ['Panasonic photo style', { Make: 'Panasonic', PhotoStyle: 'V-Log' }, { curve: 'v-log', gamut: 'v-gamut' }],
    ['Panasonic photo style (numeric)', { Make: 'Panasonic', PhotoStyle: 17 }, { curve: 'v-log', gamut: 'v-gamut' }],
    ['Fujifilm F-Log', { Make: 'FUJIFILM', VideoRecordingMode: 'F-log' }, { curve: 'f-log', gamut: 'rec2020' }],
    ['Fujifilm F-Log2', { Make: 'FUJIFILM', VideoRecordingMode: 'F-log2' }, { curve: 'f-log2', gamut: 'rec2020' }],
    ['Fujifilm F-Log2 (numeric)', { Make: 'FUJIFILM', VideoRecordingMode: 48 }, { curve: 'f-log2', gamut: 'rec2020' }],
    [
      'Canon Log 3 in Cinema Gamut',
      { Make: 'Canon', CanonLogVersion: 'CLogV3', ColorSpace2: 'CinemaGamut' },
      { curve: 'canon-log3', gamut: 'cinema-gamut' },
    ],
    [
      'Canon Log 3 in BT.709',
      { Make: 'Canon', CanonLogVersion: 'CLogV3', ColorSpace2: 'BT.709' },
      { curve: 'canon-log3', gamut: 'rec709' },
    ],
    [
      'Canon Log 2 in BT.2020',
      { Make: 'Canon', CanonLogVersion: 'CLogV2', ColorSpace2: 'BT.2020' },
      { curve: 'canon-log2', gamut: 'rec2020' },
    ],
    [
      'Canon Log without a colour space',
      { Make: 'Canon', CanonLogVersion: 'CLogV1' },
      { curve: 'canon-log', gamut: 'cinema-gamut' },
    ],
    ['Nikon N-Log', { Make: 'NIKON CORPORATION', MovieToneMap: 'N-Log' }, { curve: 'n-log', gamut: 'rec2020' }],
  ])('finds %s', (_, tags, profile) => {
    expect(detectLogVideo(evidence({ tags }))?.profile).toEqual(profile);
  });

  it.each<[string, LogVideoEvidence['tags']]>([
    ['Sony standard profile', { Make: 'SONY', PictureProfile: 'Gamma Movie (PP1)' }],
    ['Sony HLG profile', { Make: 'SONY', PictureProfile: 'Gamma HLG2 (PP10)' }],
    ['Panasonic Cinelike D2', { Make: 'Panasonic', PhotoStyle: 'Cinelike D2' }],
    ['Fujifilm normal recording', { Make: 'FUJIFILM', VideoRecordingMode: 'Normal' }],
    ['Fujifilm HLG', { Make: 'FUJIFILM', VideoRecordingMode: 'HLG' }],
    ['Canon Log off', { Make: 'Canon', CanonLogVersion: 'OFF' }],
    ['Nikon SDR', { Make: 'NIKON CORPORATION', MovieToneMap: 'SDR' }],
    ['a numeric value from another maker', { Make: 'GoPro', PhotoStyle: 17, PictureProfile: 31, MovieToneMap: 2 }],
    ['an ordinary iPhone clip', { Make: 'Apple', Model: 'iPhone 15 Pro' }],
    ['no tags at all', {}],
  ])('ignores %s', (_, tags) => {
    expect(detectLogVideo(evidence({ tags }))).toBeNull();
  });

  it.each(['d_log', 'dlog', 'D-Log'])('finds DJI D-Log from the SRT colour mode %s', (djiColorMode) => {
    expect(detectLogVideo(evidence({ djiColorMode }))).toEqual({
      profile: { curve: 'd-log', gamut: 'd-gamut' },
      signal: 'DJI SRT color_md',
      confidence: 'low',
    });
  });

  it.each(['default', 'hlg', null])('does not convert DJI colour mode %s', (djiColorMode) => {
    expect(detectLogVideo(evidence({ djiColorMode }))).toBeNull();
  });

  it.each(['dlog_m', 'd_log_m', 'D-Log-M'])("converts DJI D-Log M (%s) with DJI's own LUT", (djiColorMode) => {
    expect(detectLogVideo(evidence({ djiColorMode }))).toEqual({
      profile: { curve: 'd-log', gamut: 'd-gamut' },
      vendoredLut: 'dji-d-log-m',
      signal: 'DJI SRT color_md',
      confidence: 'low',
    });
    expect(detectLogVideo(evidence({ djiColorMode, tags: { Make: 'Sony' } }))).toBeNull();
  });

  it("ships DJI's D-Log M LUT unchanged, as a complete 33³ cube within 0–1", () => {
    const raw = readFileSync(getVendoredLutPath('dji-d-log-m'));
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VENDORED_LUTS['dji-d-log-m'].sha256);
    const readme = readFileSync(join(dirname(getVendoredLutPath('dji-d-log-m')), 'README.md'), 'utf8');
    expect(readme).toContain(VENDORED_LUTS['dji-d-log-m'].sha256);

    const text = readVendoredLut('dji-d-log-m');
    expect(text).not.toContain('\r');
    expect(text).toMatch(/^LUT_3D_SIZE\s+33$/m);
    const rows = text.split('\n').filter((line) => /^\s*[\d.-]/.test(line));
    expect(rows).toHaveLength(33 ** 3);
    const values = rows.flatMap((line) => line.trim().split(/\s+/).map(Number));
    expect(values).toHaveLength(3 * 33 ** 3);
    expect(values.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('takes D-Log from the SRT when the file names DJI', () => {
    expect(detectLogVideo(evidence({ djiColorMode: 'd_log', tags: { Make: 'DJI' } }))?.profile).toEqual({
      curve: 'd-log',
      gamut: 'd-gamut',
    });
  });

  it('ignores the SRT when the file names another maker', () => {
    expect(detectLogVideo(evidence({ djiColorMode: 'd_log', tags: { Make: 'Panasonic' } }))).toBeNull();
    expect(
      detectLogVideo(evidence({ djiColorMode: 'd_log', tags: { Make: 'Apple', Model: 'iPhone 15 Pro' } })),
    ).toBeNull();
  });

  it.each(['d_log', 'dlog_m'])('lets Log markers inside the file win over an SRT saying %s', (djiColorMode) => {
    expect(
      detectLogVideo(evidence({ djiColorMode, tags: { Make: 'SONY', PictureProfile: 'Gamma S-Log3 (PP8 or PP9)' } }))
        ?.profile,
    ).toEqual({ curve: 's-log3', gamut: 's-gamut3-cine' });
    expect(detectLogVideo(evidence({ djiColorMode, sonyCaptureGamma: 's-log3' }))?.profile).toEqual({
      curve: 's-log3',
      gamut: 's-gamut3',
    });
  });

  it('never takes a DJI HLG clip for D-Log, whatever the SRT says', () => {
    expect(detectLogVideo(evidence({ colorTransfer: ColorTransfer.AribStdB67, djiColorMode: 'd_log' }))).toBeNull();
  });

  it.each([ColorTransfer.Smpte2084, ColorTransfer.AribStdB67])('never calls HDR (transfer %s) Log', (colorTransfer) => {
    expect(
      detectLogVideo(
        evidence({
          colorPrimaries: ColorPrimaries.Bt2020,
          colorMatrix: ColorMatrix.Bt2020Nc,
          colorTransfer,
          sampleEntryLogTag: APPLE_LOG_TAG,
          sonyCaptureGamma: 's-log3',
          tags: { Make: 'Apple', PictureProfile: 'Gamma S-Log3 (PP8 or PP9)' },
        }),
      ),
    ).toBeNull();
  });

  it('does not take an iPhone HLG clip for Apple Log', () => {
    expect(
      detectLogVideo(
        evidence({
          colorPrimaries: ColorPrimaries.Bt2020,
          colorMatrix: ColorMatrix.Bt2020Nc,
          colorTransfer: ColorTransfer.AribStdB67,
          tags: { Make: 'Apple' },
        }),
      ),
    ).toBeNull();
  });
});
