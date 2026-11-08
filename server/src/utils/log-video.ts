import { ColorMatrix, ColorPrimaries, ColorTransfer } from 'src/enum.js';

/**
 * FL-1285: Log video in normal colour.
 *
 * Cameras that record "Log" store a flat, low-contrast picture: a logarithmic curve keeps the
 * sensor's whole range, and a wide camera gamut keeps its colours. Shown as-is, that picture looks
 * grey. Frameleaf converts it to ordinary Rec.709 (BT.709, SDR) for the playback copy and the video
 * thumbnails and previews only. The original file is never touched.
 *
 * The conversion is computed here from the manufacturers' published curve formulas and gamut
 * primaries (no third-party .cube files are shipped), baked into a 3D LUT, and applied with
 * ffmpeg's `lut3d` filter:
 *
 *   signal -> curve decode (scene linear, 0.18 = 18% grey) -> camera gamut to Rec.709 (D65 to D65,
 *   so no white-point adaptation) -> gentle highlight shoulder -> BT.709 OETF
 *
 * Detection never guesses from how the picture looks. It reads only what the camera wrote into the
 * file; see {@link detectLogVideo} for each signal and how far it can be trusted.
 */

/** Which signal convention a curve's published formula uses for its encoded value. */
type SignalConvention =
  /**
   * The formula gives a 10-bit code value divided by 1023 (Sony, Panasonic, Fujifilm, Nikon state
   * their curves in code values: S-Log3 18% grey is code 420, V-Log 433, F-Log 470).
   */
  | 'code-value'
  /**
   * The formula gives a video-level fraction (IRE): 0 is video black, 1 is video white (Canon states
   * its curves this way; Apple's normalised P is taken the same way, see the Apple Log note below).
   */
  | 'video-level';

export type LogCurveId =
  'apple-log' | 's-log3' | 'v-log' | 'canon-log' | 'canon-log2' | 'canon-log3' | 'f-log' | 'f-log2' | 'n-log' | 'd-log';

export type LogGamutId = 'rec709' | 'rec2020' | 's-gamut3' | 's-gamut3-cine' | 'v-gamut' | 'cinema-gamut' | 'd-gamut';

export interface LogProfile {
  curve: LogCurveId;
  gamut: LogGamutId;
}

interface LogCurve {
  label: string;
  convention: SignalConvention;
  /** Scene-linear reflectance (0.18 = 18% grey) to the normalised encoded signal. */
  encode: (linear: number) => number;
  /** The normalised encoded signal back to scene-linear reflectance. */
  decode: (signal: number) => number;
}

// Apple Log (Apple, "Apple Log Profile" white paper, 2023). The paper's P is a normalised value; it
// is read here as a video-level fraction, which matches how Apple's video stack and its own LUT treat
// it (the ProRes files are video range). Apple Log 2 uses the same curve with Apple Wide Gamut
// primaries, which are not converted here (see detectLogVideo).
const APPLE = {
  r0: -0.05641088,
  rt: 0.01,
  sigma: 47.28711236,
  beta: 0.00964052,
  gamma: 0.08550479,
  delta: 0.69336945,
};
const APPLE_PT = APPLE.sigma * (APPLE.rt - APPLE.r0) ** 2;

// S-Log3 (Sony, "Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3").
const SLOG3_CUT_CODE = 171.2102946929;

// V-Log (Panasonic, "V-Log/V-Gamut Reference Manual").
const VLOG = { cut1: 0.01, cut2: 0.181, b: 0.00873, c: 0.241514, d: 0.598206 };

// F-Log and F-Log2 (Fujifilm, "F-Log Data Sheet" and "F-Log2 Data Sheet").
const FLOG = { a: 0.555556, b: 0.009468, c: 0.344676, d: 0.790453, e: 8.735631, f: 0.092864, cut1: 0.00089 };
const FLOG2 = { a: 5.555556, b: 0.064829, c: 0.245281, d: 0.384316, e: 8.799461, f: 0.092864, cut1: 0.000889 };

// N-Log (Nikon, "N-Log Specification Document"): stated in 10-bit code values.
const NLOG_CUT_LINEAR = 0.328;
const NLOG_CUT_CODE = 452;

// D-Log (DJI, "White Paper on D-Log and D-Gamut of DJI Cinema Color System", 2017). Black encodes to
// 0.0929 = 95/1023, the same code value as S-Log3 and F-Log, so the formula is read in code values.
const DLOG = { cut1: 0.0078, slope: 6.025, offset: 0.0929, a: 0.9892, b: 0.0108, c: 0.256663, d: 0.584555 };
const DLOG_CUT2 = DLOG.slope * DLOG.cut1 + DLOG.offset;

/** Canon's formulas take linear divided by 0.9 (the "reflection" input of the Canon Log white papers). */
const CANON_REFLECTION = 0.9;

const fFlog = (k: typeof FLOG): LogCurve['encode'] => {
  return (x) => (x >= k.cut1 ? k.c * Math.log10(k.a * x + k.b) + k.d : k.e * x + k.f);
};
const fFlogInverse = (k: typeof FLOG): LogCurve['decode'] => {
  const cut2 = k.e * k.cut1 + k.f;
  return (y) => (y >= cut2 ? (10 ** ((y - k.d) / k.c) - k.b) / k.a : (y - k.f) / k.e);
};

/** Canon Log v1, Canon Log 2 and Canon Log 3 (Canon white papers, v1.2 formulas). */
const canonCurve = (
  label: string,
  segments: { slope: number; offset: number; scale: number; mid?: [number, number]; neg?: number; pos?: number },
): LogCurve => {
  const { slope, scale } = segments;
  const negOffset = segments.neg ?? segments.offset;
  const posOffset = segments.pos ?? segments.offset;
  const mid = segments.mid;
  const encodeX = (x: number) => {
    if (mid && Math.abs(x) <= mid[0]) {
      return mid[1] * x + segments.offset;
    }
    return x < 0 ? -slope * Math.log10(-x * scale + 1) + negOffset : slope * Math.log10(x * scale + 1) + posOffset;
  };
  const lowCut = mid ? encodeX(-mid[0]) : encodeX(0);
  const highCut = mid ? encodeX(mid[0]) : encodeX(0);
  return {
    label,
    convention: 'video-level',
    encode: (linear) => encodeX(linear / CANON_REFLECTION),
    decode: (y) => {
      let x: number;
      if (y < lowCut) {
        x = -(10 ** ((negOffset - y) / slope) - 1) / scale;
      } else if (mid && y <= highCut) {
        x = (y - segments.offset) / mid[1];
      } else {
        x = (10 ** ((y - posOffset) / slope) - 1) / scale;
      }
      return x * CANON_REFLECTION;
    },
  };
};

export const LOG_CURVES: Record<LogCurveId, LogCurve> = {
  'apple-log': {
    label: 'Apple Log',
    convention: 'video-level',
    encode: (r) => {
      if (r >= APPLE.rt) {
        return APPLE.gamma * Math.log2(r + APPLE.beta) + APPLE.delta;
      }
      return r >= APPLE.r0 ? APPLE.sigma * (r - APPLE.r0) ** 2 : 0;
    },
    decode: (p) => {
      if (p >= APPLE_PT) {
        return 2 ** ((p - APPLE.delta) / APPLE.gamma) - APPLE.beta;
      }
      return p >= 0 ? Math.sqrt(p / APPLE.sigma) + APPLE.r0 : APPLE.r0;
    },
  },
  's-log3': {
    label: 'S-Log3',
    convention: 'code-value',
    encode: (x) =>
      x >= 0.01125
        ? (420 + Math.log10((x + 0.01) / (0.18 + 0.01)) * 261.5) / 1023
        : (x * (SLOG3_CUT_CODE - 95)) / 0.01125 / 1023 + 95 / 1023,
    decode: (y) =>
      y >= SLOG3_CUT_CODE / 1023
        ? 10 ** ((y * 1023 - 420) / 261.5) * (0.18 + 0.01) - 0.01
        : ((y * 1023 - 95) * 0.01125) / (SLOG3_CUT_CODE - 95),
  },
  'v-log': {
    label: 'V-Log',
    convention: 'code-value',
    encode: (x) => (x < VLOG.cut1 ? 5.6 * x + 0.125 : VLOG.c * Math.log10(x + VLOG.b) + VLOG.d),
    decode: (y) => (y < VLOG.cut2 ? (y - 0.125) / 5.6 : 10 ** ((y - VLOG.d) / VLOG.c) - VLOG.b),
  },
  'canon-log': canonCurve('Canon Log', { slope: 0.45310179, scale: 10.1596, offset: 0.12512248 }),
  'canon-log2': canonCurve('Canon Log 2', { slope: 0.24136077, scale: 87.09937546, offset: 0.092864125 }),
  'canon-log3': canonCurve('Canon Log 3', {
    slope: 0.36726845,
    scale: 14.98325,
    offset: 0.12512219,
    mid: [0.014, 1.9754798],
    neg: 0.12783901,
    pos: 0.12240537,
  }),
  'f-log': { label: 'F-Log', convention: 'code-value', encode: fFlog(FLOG), decode: fFlogInverse(FLOG) },
  'f-log2': { label: 'F-Log2', convention: 'code-value', encode: fFlog(FLOG2), decode: fFlogInverse(FLOG2) },
  'd-log': {
    label: 'D-Log',
    convention: 'code-value',
    encode: (x) => (x <= DLOG.cut1 ? DLOG.slope * x + DLOG.offset : DLOG.c * Math.log10(DLOG.a * x + DLOG.b) + DLOG.d),
    decode: (y) =>
      y <= DLOG_CUT2 ? (y - DLOG.offset) / DLOG.slope : (10 ** ((y - DLOG.d) / DLOG.c) - DLOG.b) / DLOG.a,
  },
  'n-log': {
    label: 'N-Log',
    convention: 'code-value',
    encode: (y) => (y < NLOG_CUT_LINEAR ? 650 * Math.cbrt(y + 0.0075) : 150 * Math.log(y) + 619) / 1023,
    decode: (v) => {
      const code = v * 1023;
      return code < NLOG_CUT_CODE ? (code / 650) ** 3 - 0.0075 : Math.exp((code - 619) / 150);
    },
  },
};

type Chromaticity = [number, number];
interface Gamut {
  label: string;
  red: Chromaticity;
  green: Chromaticity;
  blue: Chromaticity;
}

/** Every gamut here uses the D65 white point. */
const D65: Chromaticity = [0.3127, 0.329];

export const LOG_GAMUTS: Record<LogGamutId, Gamut> = {
  rec709: { label: 'Rec.709', red: [0.64, 0.33], green: [0.3, 0.6], blue: [0.15, 0.06] },
  // Also Fujifilm F-Gamut, Nikon N-Gamut and Apple Log's primaries, which their makers define as BT.2020.
  rec2020: { label: 'Rec.2020', red: [0.708, 0.292], green: [0.17, 0.797], blue: [0.131, 0.046] },
  's-gamut3': { label: 'S-Gamut3', red: [0.73, 0.28], green: [0.14, 0.855], blue: [0.1, -0.05] },
  's-gamut3-cine': { label: 'S-Gamut3.Cine', red: [0.766, 0.275], green: [0.225, 0.8], blue: [0.089, -0.087] },
  'v-gamut': { label: 'V-Gamut', red: [0.73, 0.28], green: [0.165, 0.84], blue: [0.1, -0.03] },
  'cinema-gamut': { label: 'Cinema Gamut', red: [0.74, 0.27], green: [0.17, 1.14], blue: [0.08, -0.1] },
  'd-gamut': { label: 'D-Gamut', red: [0.71, 0.31], green: [0.21, 0.88], blue: [0.09, -0.08] },
};

type Matrix3 = [[number, number, number], [number, number, number], [number, number, number]];
type Vector3 = [number, number, number];

const multiply = (a: Matrix3, b: Matrix3): Matrix3 =>
  a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j])) as Matrix3;

const apply = (m: Matrix3, v: Vector3): Vector3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

const invert = (m: Matrix3): Matrix3 => {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
};

const toXyz = ([x, y]: Chromaticity): Vector3 => [x / y, 1, (1 - x - y) / y];

/** The normalised primary matrix (RGB to CIE XYZ) of a gamut, as in SMPTE RP 177. */
const rgbToXyz = ({ red, green, blue }: Gamut): Matrix3 => {
  const [r, g, b] = [toXyz(red), toXyz(green), toXyz(blue)];
  const primaries: Matrix3 = [
    [r[0], g[0], b[0]],
    [r[1], g[1], b[1]],
    [r[2], g[2], b[2]],
  ];
  const [sr, sg, sb] = apply(invert(primaries), toXyz(D65));
  return primaries.map((row) => [row[0] * sr, row[1] * sg, row[2] * sb]) as Matrix3;
};

/** Linear camera-gamut RGB to linear Rec.709 RGB. */
export const getGamutToRec709Matrix = (gamut: LogGamutId): Matrix3 =>
  multiply(invert(rgbToXyz(LOG_GAMUTS.rec709)), rgbToXyz(LOG_GAMUTS[gamut]));

/** Scene linear at and below this level passes through unchanged; above it highlights roll off. */
const SHOULDER_KNEE = 0.6;

/**
 * A gentle filmic shoulder: identity up to the knee (so 18% grey and every mid tone keep their
 * level), then a rational roll-off with slope 1 at the knee that approaches display white without
 * clipping hard. Log keeps several stops above white; this keeps some of that detail instead of
 * cutting it off.
 */
export const softClip = (linear: number): number => {
  if (linear <= SHOULDER_KNEE) {
    return Math.max(0, linear);
  }
  const over = linear - SHOULDER_KNEE;
  return SHOULDER_KNEE + over / (1 + over / (1 - SHOULDER_KNEE));
};

/** The BT.709 OETF (ITU-R BT.709-6, 1.2), which BT.1886 displays decode. */
export const bt709Oetf = (linear: number): number => (linear < 0.018 ? 4.5 * linear : 1.099 * linear ** 0.45 - 0.099);

export type LogSignalRange = 'tv' | 'pc';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * One colour through the whole conversion. `input` is what ffmpeg hands `lut3d`: full-scale RGB
 * after its Y'CbCr to RGB step, which has already expanded a limited-range (`tv`) stream so that
 * video black is 0 and video white is 1.
 */
export const convertLogToRec709 = (input: Vector3, profile: LogProfile, range: LogSignalRange): Vector3 => {
  const curve = LOG_CURVES[profile.curve];
  // A code-value curve on a limited-range stream: undo ffmpeg's range expansion to get code/1023.
  const toSignal =
    curve.convention === 'code-value' && range === 'tv' ? (v: number) => (v * 876 + 64) / 1023 : (v: number) => v;
  const linear = input.map((v) => curve.decode(toSignal(v))) as Vector3;
  const rec709 = apply(getGamutToRec709Matrix(profile.gamut), linear);
  return rec709.map((v) => clamp01(bt709Oetf(softClip(v)))) as Vector3;
};

/** Where on the input axis (what `lut3d` sees) a scene-linear level lands for a profile. */
export const getLogInputForLinear = (linear: number, profile: LogProfile, range: LogSignalRange): number => {
  const curve = LOG_CURVES[profile.curve];
  const signal = curve.encode(linear);
  return curve.convention === 'code-value' && range === 'tv' ? (signal * 1023 - 64) / 876 : signal;
};

export const LOG_LUT_SIZE = 33;
/** Bump when the maths changes, so a cached LUT from an older build is never reused. */
export const LOG_LUT_VERSION = 1;

export const getLogProfileLabel = ({ curve, gamut }: LogProfile) =>
  `${LOG_CURVES[curve].label} / ${LOG_GAMUTS[gamut].label}`;

/** A stable file name for a profile's LUT; the server keeps one file per profile and range. */
export const getLogLutFileName = ({ curve, gamut }: LogProfile, range: LogSignalRange) =>
  `frameleaf-log-v${LOG_LUT_VERSION}-${curve}-${gamut}-${range}-${LOG_LUT_SIZE}.cube`;

/** The conversion as an Adobe/Resolve `.cube` 3D LUT (red changes fastest), which `lut3d` reads. */
export const buildLogLut = (profile: LogProfile, range: LogSignalRange, size = LOG_LUT_SIZE): string => {
  const lines = [
    `TITLE "Frameleaf ${getLogProfileLabel(profile)} to Rec.709"`,
    `# Generated from the published curve and gamut definitions (FL-1285), ${range} range input.`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ];
  const step = 1 / (size - 1);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = convertLogToRec709([r * step, g * step, b * step], profile, range);
        lines.push(out.map((v) => v.toFixed(6)).join(' '));
      }
    }
  }
  return lines.join('\n') + '\n';
};

/** Tags read by exiftool that can say a clip was recorded in Log (see {@link detectLogVideo}). */
export interface LogVideoTags {
  Make?: unknown;
  Model?: unknown;
  /** Sony MakerNotes picture profile, e.g. "Gamma S-Log3 (PP8 or PP9)" (31). */
  PictureProfile?: unknown;
  /** Panasonic MakerNotes photo style, "V-Log" (17). */
  PhotoStyle?: unknown;
  /** Fujifilm MakerNotes (MOV `MVTG`), "F-log" (0x10) or "F-log2" (0x30). */
  VideoRecordingMode?: unknown;
  /** Canon MakerNotes LogInfo, "CLogV1" / "CLogV2" / "CLogV3" (1/2/3). */
  CanonLogVersion?: unknown;
  /** Canon MakerNotes LogInfo colour space, "BT.709" / "BT.2020" / "CinemaGamut" (0/1/2). */
  ColorSpace2?: unknown;
  /** Nikon menu settings tone mode, "N-Log" (2). */
  MovieToneMap?: unknown;
}

/** The exiftool tag names above, for a targeted read. */
export const LOG_VIDEO_TAG_NAMES = [
  'Make',
  'Model',
  'PictureProfile',
  'PhotoStyle',
  'VideoRecordingMode',
  'CanonLogVersion',
  'ColorSpace2',
  'MovieToneMap',
] as const satisfies ReadonlyArray<keyof LogVideoTags>;

export interface LogVideoEvidence {
  colorPrimaries: ColorPrimaries;
  colorTransfer: ColorTransfer;
  colorMatrix: ColorMatrix;
  /** The `logs` box inside the video sample entry (Apple), e.g. "com.apple.rec2020.apple-log". */
  sampleEntryLogTag?: string | null;
  /** Sony NonRealTimeMeta XML: `CaptureGammaEquation` (e.g. "s-log3-cine"). */
  sonyCaptureGamma?: string | null;
  /** Sony NonRealTimeMeta XML: `CaptureColorPrimaries` (e.g. "S-Gamut3.Cine-SLog3"). */
  sonyCaptureGamut?: string | null;
  /** DJI `.SRT` sidecar `color_md` value (e.g. "d_log", "dlog_m", "default"), see log-video-srt.ts. */
  djiColorMode?: string | null;
  tags?: LogVideoTags | null;
}

export type LogDetectionConfidence = 'high' | 'medium' | 'low';

export interface LogDetection {
  profile: LogProfile;
  /** Which file field said so, for logs and review. */
  signal: string;
  confidence: LogDetectionConfidence;
}

/** Apple's identifiers, from CoreVideo `kCVImageBufferLogTransferFunction_AppleLog` / `_AppleLog2`. */
export const APPLE_LOG_TAG = 'com.apple.rec2020.apple-log';
export const APPLE_LOG_2_TAG = 'com.apple.apple-wide-gamut.apple-log';

const text = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const isNumber = (value: unknown, expected: number) =>
  typeof value === 'number' ? value === expected : typeof value === 'string' && value.trim() === String(expected);
const makeIs = (tags: LogVideoTags, maker: string) => text(tags.Make).includes(maker);

/** PQ and HLG are HDR, not Log; they stay on the existing tone-mapping path. */
export const isHdrTransfer = (transfer: ColorTransfer) =>
  transfer === ColorTransfer.Smpte2084 || transfer === ColorTransfer.AribStdB67;

const sonyGamut = (gamma: string, primaries: string): LogGamutId => {
  if (primaries.includes('s-gamut3.cine') || primaries.includes('s-gamut3cine')) {
    return 's-gamut3-cine';
  }
  if (primaries.includes('s-gamut3')) {
    return 's-gamut3';
  }
  // Sony names the gamma after the gamut it was paired with: "s-log3-cine" is S-Gamut3.Cine/S-Log3.
  return gamma.endsWith('-cine') ? 's-gamut3-cine' : 's-gamut3';
};

const canonGamut = (value: unknown): LogGamutId => {
  const name = text(value);
  if (name === 'bt.709' || isNumber(value, 0)) {
    return 'rec709';
  }
  if (name === 'bt.2020' || isNumber(value, 1)) {
    return 'rec2020';
  }
  // CinemaGamut (2), and Canon's default gamut for Canon Log when the camera did not say.
  return 'cinema-gamut';
};

/**
 * Decide from file metadata whether a clip is Log, and which curve and gamut it uses. Returns null
 * for HDR (PQ/HLG), ordinary video, and Log this server does not convert.
 *
 * Signals, strongest first. Each is something the camera writes; none is inferred from the picture.
 *
 * - Apple Log (high): the `logs` box Apple writes inside the video sample description, holding the
 *   CoreVideo identifier `com.apple.rec2020.apple-log`. Verified by writing Apple Log with
 *   AVAssetWriter, which emits exactly this box (alongside `colr` = BT.2020 / unspecified / BT.2020).
 * - Apple Log, fallback (medium): Make "Apple" with BT.2020 primaries and matrix and an unspecified
 *   transfer. iPhone writes HLG for HDR and BT.709 for SDR, so this tagging only occurs for Log.
 * - Apple Log 2 (`com.apple.apple-wide-gamut.apple-log`, iPhone 17 Pro): not converted. It uses
 *   Apple Wide Gamut, whose published primaries are not available here, and a wrong gamut would
 *   shift every colour.
 * - Sony S-Log3 (high): the NonRealTimeMeta XML Sony writes into XAVC files,
 *   `CaptureGammaEquation` = "s-log3" / "s-log3-cine" and `CaptureColorPrimaries` for the gamut.
 * - Sony S-Log3 (medium): MakerNotes `PictureProfile` = "Gamma S-Log3" (PP8/PP9), gamut assumed
 *   S-Gamut3.Cine (the default for those profiles).
 * - Panasonic V-Log (medium): MakerNotes `PhotoStyle` = "V-Log" from the `PANA` box.
 * - Fujifilm F-Log / F-Log2 (medium): MakerNotes `VideoRecordingMode` from the MOV `MVTG` box.
 *   F-Gamut is BT.2020. Values exiftool does not name (for example F-Log2 C) are left alone.
 * - Canon Log / Log 2 / Log 3 (medium; Log 2 low, exiftool marks its value unconfirmed): MakerNotes
 *   LogInfo `CanonLogVersion`, with `ColorSpace2` for the gamut.
 * - Nikon N-Log (low): `MovieToneMap` = "N-Log" from the Nikon menu settings, when present.
 * - DJI D-Log (low): DJI writes the colour mode only to the optional `.SRT` sidecar next to the clip
 *   (`[color_md : d_log]`), never into the video file. Low because the SRT naming is not documented
 *   by DJI and owners report some models writing a plain "d-log" for D-Log M.
 * - DJI D-Log M (`dlog_m`): detected but not converted. DJI has published no D-Log M formula, only a
 *   LUT whose licence is unclear, so there is nothing to generate a conversion from here.
 *
 * Not covered, because no published formula exists or the file carries no signal: GoPro Protune
 * Flat / GP-Log (no published curve), Sony S-Log2.
 */
export const detectLogVideo = (evidence: LogVideoEvidence): LogDetection | null => {
  if (isHdrTransfer(evidence.colorTransfer)) {
    return null;
  }
  const tags = evidence.tags ?? {};

  const appleTag = evidence.sampleEntryLogTag?.trim().toLowerCase();
  if (appleTag === APPLE_LOG_TAG) {
    return { profile: { curve: 'apple-log', gamut: 'rec2020' }, signal: 'sample entry logs box', confidence: 'high' };
  }
  if (appleTag) {
    // Apple Log 2 or a future identifier: known to be Log, but not one this server can convert.
    return null;
  }

  const gamma = text(evidence.sonyCaptureGamma);
  if (gamma === 's-log3' || gamma === 's-log3-cine') {
    return {
      profile: { curve: 's-log3', gamut: sonyGamut(gamma, text(evidence.sonyCaptureGamut)) },
      signal: 'Sony XML CaptureGammaEquation',
      confidence: 'high',
    };
  }

  const pictureProfile = text(tags.PictureProfile);
  if (pictureProfile.includes('s-log3') || (makeIs(tags, 'sony') && isNumber(tags.PictureProfile, 31))) {
    return {
      profile: { curve: 's-log3', gamut: 's-gamut3-cine' },
      signal: 'Sony PictureProfile',
      confidence: 'medium',
    };
  }

  if (text(tags.PhotoStyle) === 'v-log' || (makeIs(tags, 'panasonic') && isNumber(tags.PhotoStyle, 17))) {
    return { profile: { curve: 'v-log', gamut: 'v-gamut' }, signal: 'Panasonic PhotoStyle', confidence: 'medium' };
  }

  const fuji = text(tags.VideoRecordingMode);
  const isFuji = makeIs(tags, 'fujifilm');
  if (fuji === 'f-log' || (isFuji && isNumber(tags.VideoRecordingMode, 0x10))) {
    return {
      profile: { curve: 'f-log', gamut: 'rec2020' },
      signal: 'Fujifilm VideoRecordingMode',
      confidence: 'medium',
    };
  }
  if (fuji === 'f-log2' || (isFuji && isNumber(tags.VideoRecordingMode, 0x30))) {
    return {
      profile: { curve: 'f-log2', gamut: 'rec2020' },
      signal: 'Fujifilm VideoRecordingMode',
      confidence: 'medium',
    };
  }

  const canonLog = text(tags.CanonLogVersion);
  const isCanon = makeIs(tags, 'canon');
  const canonCurves: Array<[string, number, LogCurveId, LogDetectionConfidence]> = [
    ['clogv1', 1, 'canon-log', 'medium'],
    ['clogv2', 2, 'canon-log2', 'low'],
    ['clogv3', 3, 'canon-log3', 'medium'],
  ];
  for (const [name, value, curve, confidence] of canonCurves) {
    if (canonLog === name || (isCanon && isNumber(tags.CanonLogVersion, value))) {
      return { profile: { curve, gamut: canonGamut(tags.ColorSpace2) }, signal: 'Canon CanonLogVersion', confidence };
    }
  }

  if (text(tags.MovieToneMap) === 'n-log' || (makeIs(tags, 'nikon') && isNumber(tags.MovieToneMap, 2))) {
    return { profile: { curve: 'n-log', gamut: 'rec2020' }, signal: 'Nikon MovieToneMap', confidence: 'low' };
  }

  // DJI's SRT sidecar comes after every marker inside the file, which always wins over it, and is
  // ignored when the file names another maker (a stale or mismatched sidecar). D-Log M ("dlog_m")
  // has no published formula, so it is not converted.
  const make = text(tags.Make);
  const dji = text(evidence.djiColorMode).replaceAll('-', '_');
  if ((dji === 'd_log' || dji === 'dlog') && (!make || make.includes('dji'))) {
    return { profile: { curve: 'd-log', gamut: 'd-gamut' }, signal: 'DJI SRT color_md', confidence: 'low' };
  }

  if (
    text(tags.Make) === 'apple' &&
    evidence.colorPrimaries === ColorPrimaries.Bt2020 &&
    evidence.colorMatrix === ColorMatrix.Bt2020Nc &&
    evidence.colorTransfer === ColorTransfer.Unknown
  ) {
    return {
      profile: { curve: 'apple-log', gamut: 'rec2020' },
      signal: 'Apple BT.2020 with unspecified transfer',
      confidence: 'medium',
    };
  }

  return null;
};
