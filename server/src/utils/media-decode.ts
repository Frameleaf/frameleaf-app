/**
 * Frameleaf source-decoding qualification (FL-101 / VID-103).
 *
 * Before a frame of a source is decoded for a render or a preview, the probed stream is
 * classified against an advertised matrix: either this renderer can decode it and hand honest
 * planes to the float pipeline, or it tone maps it deliberately, or it refuses and says why.
 * A refusal is a *decision*, taken before any output directory is created and before any
 * existing valid derivative could be replaced; the original is always left untouched.
 *
 * The module is framework-free — no NestJS, no repositories, no filesystem — for the same
 * reason {@link file://./media-policy.ts} is: the quick editor, Studio and the transcode
 * services must all classify a source the same way, from the same table.
 *
 * Two rules drive every decision here:
 *
 * 1. **Dolby Vision profile 5 is not HDR10.** Its base layer is IPT-PQ-C2 with a mandatory
 *    reshaping step; decoding it as ordinary HDR10 produces wrong colour, and copying the
 *    source RPU onto edited pictures is not preservation. There is no qualified path for it
 *    here, so it is refused outright. Dolby Vision profiles 8.1 and 8.4 *do* have a usable
 *    base layer (HDR10 and HLG respectively) and are qualified as that base layer, with the
 *    RPU explicitly dropped rather than silently carried.
 * 2. **Bit depth and chroma are read from the pixel format, never from the codec name.** A
 *    `hevc` label says nothing about whether the planes are 8-bit 4:2:0 or 12-bit 4:4:4.
 */
import type { ConfigFFmpegDto } from 'src/dtos/config.dto.js';
import type { VideoStreamInfo } from 'src/types.js';
import {
  ColorTransfer,
  DvProfile,
  DvSignalCompatibility,
  ToneMapping,
  TranscodeHardwareAcceleration,
} from 'src/enum.js';
import { MediaPolicyError, MediaPolicyViolation } from 'src/utils/media-policy.js';

/** How this renderer will treat a probed source. */
export enum DecodeSupport {
  /** Decoded and carried through with its own colour volume. */
  Supported = 'supported',
  /** Decoded, then deliberately tone mapped to SDR. A recorded loss, never a silent one. */
  ToneMapped = 'toneMapped',
  /** Not decoded at all. The original is preserved and the caller must stop. */
  Refused = 'refused',
}

/** Why a source was refused. Stable identifiers; the prose lives in `reason`. */
export enum DecodeRefusal {
  /** Dolby Vision profile 5: no usable base layer, mandatory reshaping, no qualified path. */
  DolbyVisionProfile5 = 'dolbyVisionProfile5',
  /** Dolby Vision profile 7: the enhancement layer is not qualified in this renderer. */
  DolbyVisionEnhancementLayer = 'dolbyVisionEnhancementLayer',
  /** A Dolby Vision profile outside the advertised matrix. */
  DolbyVisionProfileUnqualified = 'dolbyVisionProfileUnqualified',
  /** Dolby Vision profile 8 whose base-layer compatibility id does not say what the base is. */
  DolbyVisionBaseLayerUnknown = 'dolbyVisionBaseLayerUnknown',
  /** The probed pixel format is not one this module can describe, so nothing is assumed. */
  UnknownPixelFormat = 'unknownPixelFormat',
  /** More than 12 bits per component; the encoders reachable from here cannot deliver it. */
  UnsupportedBitDepth = 'unsupportedBitDepth',
  /** The stream has no usable picture geometry. */
  UnusableGeometry = 'unusableGeometry',
}

/** What the source's planes actually are, read from the pixel format. */
export enum ChromaSubsampling {
  Yuv420 = '4:2:0',
  Yuv422 = '4:2:2',
  Yuv440 = '4:4:0',
  Yuv444 = '4:4:4',
  Yuv411 = '4:1:1',
  Yuv410 = '4:1:0',
  Monochrome = 'monochrome',
  Rgb = 'rgb',
}

export type SourcePixelLayout = {
  /** Bits per component: 8, 9, 10, 12, 14 or 16. */
  bitDepth: number;
  chroma: ChromaSubsampling;
  hasAlpha: boolean;
  /**
   * True for the semi-planar families (`nv12`, `p010le`, …) that hardware decoders hand back,
   * as opposed to the fully planar `yuv*p*` families software decoders produce.
   */
  semiPlanar: boolean;
  /** The pixel format name exactly as ffprobe reported it, lower-cased. */
  name: string;
};

/** What the source's light actually is, after Dolby Vision base-layer resolution. */
export enum SourceTransferKind {
  Sdr = 'sdr',
  Hdr10 = 'hdr10',
  Hlg = 'hlg',
}

/** A Dolby Vision input, described rather than assumed. */
export type DolbyVisionInput = {
  /** `5`, `8.1`, `8.4`, `7`, … as a display label. */
  label: string;
  profile: DvProfile;
  blSignalCompatibilityId: DvSignalCompatibility | null;
  /** What the base layer renders as on a non-Dolby decoder, or null when it has no usable one. */
  baseLayer: SourceTransferKind | null;
  /** True when this renderer has a qualified path for the base layer. */
  qualified: boolean;
  refusal: DecodeRefusal | null;
};

export type DecodeQualification = {
  support: DecodeSupport;
  /** Set only when `support` is {@link DecodeSupport.Refused}. */
  refusal: DecodeRefusal | null;
  /** Human-readable justification. Logged on refusal and recorded in lineage otherwise. */
  reason: string;
  codecName: string | null;
  /** Null only when the pixel format could not be described, which is itself a refusal. */
  layout: SourcePixelLayout | null;
  transfer: SourceTransferKind;
  dolbyVision: DolbyVisionInput | null;
  /**
   * The identifier of the advertised {@link DECODE_MATRIX} row this source matched, or null
   * when the source decodes but is outside the tested matrix. Never a refusal on its own: an
   * untested combination is reported honestly rather than blocked.
   */
  matrixEntry: string | null;
  /**
   * Bits per component the intermediate must carry so the decode is not flattened on its way
   * to the float pipeline. 8-bit SDR sources still process in float; this is the floor below
   * which a render would *lose* something the source had.
   */
  minimumIntermediateBitDepth: number;
};

/**
 * The advertised, tested source matrix. Each row is a combination this renderer claims to
 * decode correctly. `id` is stable and appears in {@link DecodeQualification.matrixEntry},
 * in logs and in the handoff evidence.
 *
 * Portrait and anamorphic sources are not separate rows: rotation and sample aspect are
 * geometry, not decoding, and every row covers them. They are qualified by the rotation and
 * pixel-aspect tests, not by a codec label.
 */
export const DECODE_MATRIX: readonly {
  id: string;
  description: string;
  codecs: readonly string[];
  bitDepths: readonly number[];
  chroma: readonly ChromaSubsampling[];
  transfer: SourceTransferKind;
  dolbyVision: string | null;
}[] = [
  {
    id: 'sdr-8bit-420',
    description: 'Ordinary SDR: 8-bit 4:2:0, untagged or Rec. 709 / Rec. 601 transfer',
    codecs: ['h264', 'hevc', 'av1', 'vp9', 'vp8'],
    bitDepths: [8],
    chroma: [ChromaSubsampling.Yuv420],
    transfer: SourceTransferKind.Sdr,
    dolbyVision: null,
  },
  {
    id: 'sdr-10bit-420',
    description: 'SDR 10-bit 4:2:0 (High 10 / Main 10 without an HDR transfer)',
    codecs: ['h264', 'hevc', 'av1', 'vp9'],
    bitDepths: [10],
    chroma: [ChromaSubsampling.Yuv420],
    transfer: SourceTransferKind.Sdr,
    dolbyVision: null,
  },
  {
    id: 'hdr10-10bit-420',
    description: 'HDR10: 10-bit 4:2:0, SMPTE ST 2084 (PQ) transfer, Rec. 2020 primaries',
    codecs: ['hevc', 'av1', 'vp9'],
    bitDepths: [10],
    chroma: [ChromaSubsampling.Yuv420],
    transfer: SourceTransferKind.Hdr10,
    dolbyVision: null,
  },
  {
    id: 'hlg-10bit-420',
    description: 'HLG: 10-bit 4:2:0, ARIB STD-B67 transfer',
    codecs: ['hevc', 'av1', 'vp9'],
    bitDepths: [10],
    chroma: [ChromaSubsampling.Yuv420],
    transfer: SourceTransferKind.Hlg,
    dolbyVision: null,
  },
  {
    id: 'prores-sdr',
    description: 'Apple ProRes 422 / 4444, 10-bit and 12-bit, SDR',
    codecs: ['prores'],
    bitDepths: [10, 12],
    chroma: [ChromaSubsampling.Yuv422, ChromaSubsampling.Yuv444],
    transfer: SourceTransferKind.Sdr,
    dolbyVision: null,
  },
  {
    id: 'prores-hdr',
    description: 'Apple ProRes 422 / 4444, 10-bit and 12-bit, SMPTE ST 2084 (PQ)',
    codecs: ['prores'],
    bitDepths: [10, 12],
    chroma: [ChromaSubsampling.Yuv422, ChromaSubsampling.Yuv444],
    transfer: SourceTransferKind.Hdr10,
    dolbyVision: null,
  },
  {
    id: 'prores-hlg',
    description: 'Apple ProRes 422 / 4444, 10-bit and 12-bit, HLG',
    codecs: ['prores'],
    bitDepths: [10, 12],
    chroma: [ChromaSubsampling.Yuv422, ChromaSubsampling.Yuv444],
    transfer: SourceTransferKind.Hlg,
    dolbyVision: null,
  },
  {
    id: 'dolby-vision-8.1',
    description: 'Dolby Vision profile 8.1: HDR10 base layer, 10-bit 4:2:0; the RPU is dropped',
    codecs: ['hevc'],
    bitDepths: [10],
    chroma: [ChromaSubsampling.Yuv420],
    transfer: SourceTransferKind.Hdr10,
    dolbyVision: '8.1',
  },
  {
    id: 'dolby-vision-8.4',
    description: 'Dolby Vision profile 8.4: HLG base layer, 10-bit 4:2:0; the RPU is dropped',
    codecs: ['hevc'],
    bitDepths: [10],
    chroma: [ChromaSubsampling.Yuv420],
    transfer: SourceTransferKind.Hlg,
    dolbyVision: '8.4',
  },
];

/** The highest bit depth a render started from here can carry end to end. */
export const MAX_DECODE_BIT_DEPTH = 12;

/**
 * Semi-planar and packed pixel formats, whose names spell the depth and subsampling in the
 * format name itself rather than after a plane marker. Everything that follows the regular
 * `yuv<sub>p<depth><endianness>` grammar is parsed, not tabulated.
 */
const NAMED_PIXEL_LAYOUTS: Record<string, Omit<SourcePixelLayout, 'name'>> = {
  nv12: { bitDepth: 8, chroma: ChromaSubsampling.Yuv420, hasAlpha: false, semiPlanar: true },
  nv21: { bitDepth: 8, chroma: ChromaSubsampling.Yuv420, hasAlpha: false, semiPlanar: true },
  nv16: { bitDepth: 8, chroma: ChromaSubsampling.Yuv422, hasAlpha: false, semiPlanar: true },
  nv24: { bitDepth: 8, chroma: ChromaSubsampling.Yuv444, hasAlpha: false, semiPlanar: true },
  nv42: { bitDepth: 8, chroma: ChromaSubsampling.Yuv444, hasAlpha: false, semiPlanar: true },
  nv20le: { bitDepth: 10, chroma: ChromaSubsampling.Yuv422, hasAlpha: false, semiPlanar: true },
  nv20be: { bitDepth: 10, chroma: ChromaSubsampling.Yuv422, hasAlpha: false, semiPlanar: true },
  p010le: { bitDepth: 10, chroma: ChromaSubsampling.Yuv420, hasAlpha: false, semiPlanar: true },
  p010be: { bitDepth: 10, chroma: ChromaSubsampling.Yuv420, hasAlpha: false, semiPlanar: true },
  p012le: { bitDepth: 12, chroma: ChromaSubsampling.Yuv420, hasAlpha: false, semiPlanar: true },
  p012be: { bitDepth: 12, chroma: ChromaSubsampling.Yuv420, hasAlpha: false, semiPlanar: true },
  p016le: { bitDepth: 16, chroma: ChromaSubsampling.Yuv420, hasAlpha: false, semiPlanar: true },
  p016be: { bitDepth: 16, chroma: ChromaSubsampling.Yuv420, hasAlpha: false, semiPlanar: true },
  p210le: { bitDepth: 10, chroma: ChromaSubsampling.Yuv422, hasAlpha: false, semiPlanar: true },
  p212le: { bitDepth: 12, chroma: ChromaSubsampling.Yuv422, hasAlpha: false, semiPlanar: true },
  p216le: { bitDepth: 16, chroma: ChromaSubsampling.Yuv422, hasAlpha: false, semiPlanar: true },
  p410le: { bitDepth: 10, chroma: ChromaSubsampling.Yuv444, hasAlpha: false, semiPlanar: true },
  p412le: { bitDepth: 12, chroma: ChromaSubsampling.Yuv444, hasAlpha: false, semiPlanar: true },
  p416le: { bitDepth: 16, chroma: ChromaSubsampling.Yuv444, hasAlpha: false, semiPlanar: true },
  y210le: { bitDepth: 10, chroma: ChromaSubsampling.Yuv422, hasAlpha: false, semiPlanar: false },
  y212le: { bitDepth: 12, chroma: ChromaSubsampling.Yuv422, hasAlpha: false, semiPlanar: false },
  yuyv422: { bitDepth: 8, chroma: ChromaSubsampling.Yuv422, hasAlpha: false, semiPlanar: false },
  uyvy422: { bitDepth: 8, chroma: ChromaSubsampling.Yuv422, hasAlpha: false, semiPlanar: false },
  xv30le: { bitDepth: 10, chroma: ChromaSubsampling.Yuv444, hasAlpha: false, semiPlanar: false },
  xv36le: { bitDepth: 12, chroma: ChromaSubsampling.Yuv444, hasAlpha: false, semiPlanar: false },
  vuyx: { bitDepth: 8, chroma: ChromaSubsampling.Yuv444, hasAlpha: false, semiPlanar: false },
  ayuv64le: { bitDepth: 16, chroma: ChromaSubsampling.Yuv444, hasAlpha: true, semiPlanar: false },
};

/** `yuv420p`, `yuvj422p`, `yuva444p12le`, `yuv420p10be`, … */
const PLANAR_YUV = /^yuv(?<alpha>a)?j?(?<chroma>410|411|420|422|440|444)p(?<depth>\d{1,2})?(?:le|be)?$/;
/** `gbrp`, `gbrap10le`, `gbrpf32le` — planar RGB, used by ProRes 4444 and the float pipeline. */
const PLANAR_RGB = /^gbr(?<alpha>a)?p(?<depth>\d{1,2})?(?:le|be)?$/;
/** `gray`, `gray10le`, `gray16be`. */
const GRAY = /^gray(?<depth>\d{1,2})?(?:le|be)?$/;
/** `rgb24`, `bgra`, `rgba64le`, `argb`. */
const PACKED_RGB = /^(?<components>[abgrx]{3,4})(?<total>\d{2})?(?:le|be)?$/;

/**
 * The planar grammar captures the subsampling as digits (`420`); the enum stores the display
 * form (`4:2:0`). This is the only place the two are related.
 */
const CHROMA_BY_DIGITS: Record<string, ChromaSubsampling> = {
  '410': ChromaSubsampling.Yuv410,
  '411': ChromaSubsampling.Yuv411,
  '420': ChromaSubsampling.Yuv420,
  '422': ChromaSubsampling.Yuv422,
  '440': ChromaSubsampling.Yuv440,
  '444': ChromaSubsampling.Yuv444,
};

/**
 * Describes a probed pixel format, or returns null when the name is not one this module can
 * describe. Null is deliberately *not* a guess at 8-bit 4:2:0: guessing is how a 12-bit source
 * silently becomes an 8-bit one.
 */
export const parseSourcePixelLayout = (pixelFormat: string | null | undefined): SourcePixelLayout | null => {
  const name = (pixelFormat ?? '').trim().toLowerCase();
  if (!name) {
    return null;
  }

  const named = NAMED_PIXEL_LAYOUTS[name];
  if (named) {
    return { ...named, name };
  }

  const planar = PLANAR_YUV.exec(name);
  if (planar?.groups) {
    return {
      bitDepth: planar.groups.depth ? Number(planar.groups.depth) : 8,
      chroma: CHROMA_BY_DIGITS[planar.groups.chroma],
      hasAlpha: planar.groups.alpha === 'a',
      semiPlanar: false,
      name,
    };
  }

  const rgbPlanar = PLANAR_RGB.exec(name);
  if (rgbPlanar?.groups) {
    return {
      bitDepth: rgbPlanar.groups.depth ? Number(rgbPlanar.groups.depth) : 8,
      chroma: ChromaSubsampling.Rgb,
      hasAlpha: rgbPlanar.groups.alpha === 'a',
      semiPlanar: false,
      name,
    };
  }

  const gray = GRAY.exec(name);
  if (gray?.groups) {
    return {
      bitDepth: gray.groups.depth ? Number(gray.groups.depth) : 8,
      chroma: ChromaSubsampling.Monochrome,
      hasAlpha: false,
      semiPlanar: false,
      name,
    };
  }

  const packed = PACKED_RGB.exec(name);
  if (packed?.groups) {
    // `rgb24` and `rgba64le` spell the total width of the whole pixel, not of one component.
    const components = packed.groups.components.length;
    const total = packed.groups.total ? Number(packed.groups.total) : components * 8;
    return {
      bitDepth: Math.round(total / components),
      chroma: ChromaSubsampling.Rgb,
      hasAlpha: packed.groups.components.includes('a'),
      semiPlanar: false,
      name,
    };
  }

  return null;
};

/**
 * Describes a Dolby Vision configuration record. The base-layer compatibility id — not the
 * profile number alone, and never the probed colour transfer — is what says whether there is
 * something a non-Dolby decoder can honestly render.
 */
export const describeDolbyVisionInput = (
  dvProfile: DvProfile,
  blSignalCompatibilityId: DvSignalCompatibility | null,
): DolbyVisionInput => {
  const base: Pick<DolbyVisionInput, 'profile' | 'blSignalCompatibilityId'> = {
    profile: dvProfile,
    blSignalCompatibilityId,
  };

  switch (dvProfile) {
    case DvProfile.Dvhe05: {
      return {
        ...base,
        label: 'profile 5',
        baseLayer: null,
        qualified: false,
        refusal: DecodeRefusal.DolbyVisionProfile5,
      };
    }
    case DvProfile.Dvhe07: {
      return {
        ...base,
        label: 'profile 7',
        baseLayer: null,
        qualified: false,
        refusal: DecodeRefusal.DolbyVisionEnhancementLayer,
      };
    }
    case DvProfile.Dvhe08: {
      switch (blSignalCompatibilityId) {
        case DvSignalCompatibility.Hdr10: {
          return { ...base, label: 'profile 8.1', baseLayer: SourceTransferKind.Hdr10, qualified: true, refusal: null };
        }
        case DvSignalCompatibility.Sdr709: {
          return { ...base, label: 'profile 8.2', baseLayer: SourceTransferKind.Sdr, qualified: true, refusal: null };
        }
        case DvSignalCompatibility.Hlg: {
          return { ...base, label: 'profile 8.4', baseLayer: SourceTransferKind.Hlg, qualified: true, refusal: null };
        }
        default: {
          return {
            ...base,
            label: `profile 8 (base-layer compatibility ${blSignalCompatibilityId ?? 'absent'})`,
            baseLayer: null,
            qualified: false,
            refusal: DecodeRefusal.DolbyVisionBaseLayerUnknown,
          };
        }
      }
    }
    default: {
      return {
        ...base,
        label: `profile ${dvProfile}`,
        baseLayer: null,
        qualified: false,
        refusal: DecodeRefusal.DolbyVisionProfileUnqualified,
      };
    }
  }
};

/** The source's light, from its transfer characteristics. An untagged source is SDR. */
export const classifySourceTransfer = (colorTransfer: ColorTransfer): SourceTransferKind => {
  switch (colorTransfer) {
    case ColorTransfer.Smpte2084: {
      return SourceTransferKind.Hdr10;
    }
    case ColorTransfer.AribStdB67: {
      return SourceTransferKind.Hlg;
    }
    default: {
      return SourceTransferKind.Sdr;
    }
  }
};

const findMatrixEntry = ({
  codecName,
  layout,
  transfer,
  dolbyVision,
}: Pick<DecodeQualification, 'codecName' | 'layout' | 'transfer' | 'dolbyVision'>): string | null => {
  if (!layout) {
    return null;
  }

  const codec = (codecName ?? '').toLowerCase();
  const dv = dolbyVision?.qualified ? dolbyVision.label.replace('profile ', '') : null;

  const entry = DECODE_MATRIX.find(
    (row) =>
      row.dolbyVision === dv &&
      row.transfer === transfer &&
      row.codecs.includes(codec) &&
      row.bitDepths.includes(layout.bitDepth) &&
      row.chroma.includes(layout.chroma),
  );

  return entry?.id ?? null;
};

const refuse = (
  refusal: DecodeRefusal,
  reason: string,
  partial: Pick<DecodeQualification, 'codecName' | 'layout' | 'transfer' | 'dolbyVision'>,
): DecodeQualification => ({
  ...partial,
  support: DecodeSupport.Refused,
  refusal,
  reason,
  matrixEntry: null,
  minimumIntermediateBitDepth: partial.layout?.bitDepth ?? 8,
});

/**
 * Classifies a probed stream into supported, tone-mapped or refused. Call this before any
 * render or preview, and before the output directory is created — a refusal must never be the
 * thing that happens *after* an existing derivative has been cleared away.
 */
export const qualifySourceDecode = (
  videoStream: Pick<
    VideoStreamInfo,
    'codecName' | 'pixelFormat' | 'colorTransfer' | 'dvProfile' | 'dvBlSignalCompatibilityId' | 'width' | 'height'
  >,
  config: Pick<ConfigFFmpegDto, 'tonemap'>,
): DecodeQualification => {
  const codecName = videoStream.codecName ? videoStream.codecName.toLowerCase() : null;
  const layout = parseSourcePixelLayout(videoStream.pixelFormat);
  const dvProfile = videoStream.dvProfile ?? null;
  const dolbyVision =
    dvProfile === null ? null : describeDolbyVisionInput(dvProfile, videoStream.dvBlSignalCompatibilityId ?? null);

  // The base layer, when there is a qualified one, is the authority on what the pixels are.
  // The probed transfer describes the same base layer and should agree; when it does not, the
  // configuration record wins and the disagreement is stated rather than averaged away.
  const probedTransfer = classifySourceTransfer(videoStream.colorTransfer);
  const transfer = dolbyVision?.qualified && dolbyVision.baseLayer ? dolbyVision.baseLayer : probedTransfer;
  const partial = { codecName, layout, transfer, dolbyVision };

  if (dolbyVision && !dolbyVision.qualified) {
    const reason =
      dolbyVision.refusal === DecodeRefusal.DolbyVisionProfile5
        ? 'Dolby Vision profile 5 carries no usable base layer: its pictures are IPT-PQ-C2 and require ' +
          'reshaping, so decoding them as HDR10 would produce wrong colour. There is no qualified path ' +
          'for it in this renderer; the original is preserved unchanged.'
        : dolbyVision.refusal === DecodeRefusal.DolbyVisionEnhancementLayer
          ? 'Dolby Vision profile 7 carries a separate enhancement layer that this renderer does not ' +
            'combine; decoding the base layer alone would silently discard picture information.'
          : `Dolby Vision ${dolbyVision.label} is outside the qualified input matrix ` +
            `(${DECODE_MATRIX.filter((row) => row.dolbyVision)
              .map((row) => row.dolbyVision)
              .join(', ')}).`;
    return refuse(dolbyVision.refusal ?? DecodeRefusal.DolbyVisionProfileUnqualified, reason, partial);
  }

  if (!layout) {
    return refuse(
      DecodeRefusal.UnknownPixelFormat,
      `Pixel format '${videoStream.pixelFormat}' is not one this renderer can describe, so its bit depth ` +
        'and chroma subsampling are unknown. Nothing is assumed about it.',
      partial,
    );
  }

  if (layout.bitDepth > MAX_DECODE_BIT_DEPTH) {
    return refuse(
      DecodeRefusal.UnsupportedBitDepth,
      `Pixel format '${layout.name}' carries ${layout.bitDepth} bits per component; this renderer delivers ` +
        `at most ${MAX_DECODE_BIT_DEPTH}, and reducing it silently would not be preservation.`,
      partial,
    );
  }

  if (!videoStream.width || !videoStream.height) {
    return refuse(
      DecodeRefusal.UnusableGeometry,
      'The stream reports no usable picture geometry; re-run metadata extraction before rendering.',
      partial,
    );
  }

  const matrixEntry = findMatrixEntry(partial);
  const minimumIntermediateBitDepth =
    transfer === SourceTransferKind.Sdr ? layout.bitDepth : Math.max(layout.bitDepth, 10);
  const untested = matrixEntry
    ? ''
    : ` This combination (${codecName ?? 'unknown codec'}, ${layout.bitDepth}-bit ${layout.chroma}) is outside the ` +
      'advertised tested matrix; it decodes, but it is not qualified evidence.';

  if (transfer !== SourceTransferKind.Sdr && config.tonemap !== ToneMapping.Disabled) {
    return {
      ...partial,
      support: DecodeSupport.ToneMapped,
      refusal: null,
      matrixEntry,
      minimumIntermediateBitDepth,
      reason:
        `Source is ${transfer.toUpperCase()}${dolbyVision ? ` (Dolby Vision ${dolbyVision.label} base layer)` : ''} ` +
        `and is tone mapped with '${config.tonemap}'.${untested}`,
    };
  }

  return {
    ...partial,
    support: DecodeSupport.Supported,
    refusal: null,
    matrixEntry,
    minimumIntermediateBitDepth,
    reason:
      `Source is ${transfer === SourceTransferKind.Sdr ? 'SDR' : transfer.toUpperCase()}` +
      `${dolbyVision ? ` (Dolby Vision ${dolbyVision.label} base layer; the RPU is not carried)` : ''}, ` +
      `${layout.bitDepth}-bit ${layout.chroma}, decoded and carried through.${untested}`,
  };
};

/**
 * Throws when the source was refused, so a caller that only cares about the happy path cannot
 * forget to check. The error is a {@link MediaPolicyError}, which the render jobs already
 * catch and report without failing the whole queue.
 */
export const assertDecodeQualified = (qualification: DecodeQualification): void => {
  if (qualification.support === DecodeSupport.Refused) {
    throw new MediaPolicyError(MediaPolicyViolation.UnsupportedSource, qualification.reason);
  }
};

/** Codecs the fixed-function decoders in the supported accelerators actually handle. */
const HARDWARE_DECODE_CODECS: Record<TranscodeHardwareAcceleration, readonly string[]> = {
  [TranscodeHardwareAcceleration.Nvenc]: ['h264', 'hevc', 'vp9', 'av1', 'mpeg2video', 'vc1'],
  [TranscodeHardwareAcceleration.Qsv]: ['h264', 'hevc', 'vp9', 'av1', 'mpeg2video', 'vc1'],
  [TranscodeHardwareAcceleration.Vaapi]: ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg2video', 'vc1'],
  [TranscodeHardwareAcceleration.Rkmpp]: ['h264', 'hevc', 'vp9', 'av1'],
  [TranscodeHardwareAcceleration.Disabled]: [],
};

export type DecodeAccelerationDecision = {
  /**
   * The ffmpeg configuration the render should build its command from. It is the caller's own
   * configuration with `accelDecode` cleared when the source cannot go through the fixed-function
   * decoder honestly; `accel` itself is never changed, so hardware *encoding* is unaffected.
   */
  config: ConfigFFmpegDto;
  accelDecode: boolean;
  reason: string;
};

/**
 * Chooses hardware or software decoding for a qualified source, reusing the existing transcode
 * hardware configuration rather than introducing a second one: `accel` picks the vendor and the
 * existing `BaseConfig.create` picks the `*HwDecodeConfig` or `*SwDecodeConfig` handler from
 * `accelDecode`. All this adds is the cases where the fixed-function path would be *wrong*:
 *
 * - a codec the fixed-function decoder does not implement (ProRes, DNxHD, FFV1, MJPEG …);
 * - 4:2:2, 4:4:4, monochrome or RGB source planes, because every hardware filter chain in this
 *   fork hands frames on as `nv12` or `p010`, both 4:2:0 — a hardware decode would subsample the
 *   chroma before the float pipeline ever saw it;
 * - more than 10 bits per component, which those same surface formats cannot carry;
 * - an alpha plane, which they cannot carry either;
 * - a Dolby Vision source, whose base-layer handling is not qualified on the hardware path.
 *
 * Falling back to software decoding changes the speed of a render, never its result.
 */
export const selectDecodeAcceleration = (
  config: ConfigFFmpegDto,
  qualification: DecodeQualification,
): DecodeAccelerationDecision => {
  if (config.accel === TranscodeHardwareAcceleration.Disabled || !config.accelDecode) {
    return { config, accelDecode: false, reason: 'Hardware decoding is not enabled.' };
  }

  const softwareOnly = (reason: string): DecodeAccelerationDecision => ({
    config: { ...config, accelDecode: false },
    accelDecode: false,
    reason,
  });

  const codec = qualification.codecName ?? '';
  if (!HARDWARE_DECODE_CODECS[config.accel].includes(codec)) {
    return softwareOnly(
      `${config.accel.toUpperCase()} has no fixed-function decoder for '${codec || 'unknown'}'; decoding in software.`,
    );
  }

  const layout = qualification.layout;
  if (!layout) {
    return softwareOnly('The source pixel format is unknown; decoding in software.');
  }

  if (layout.chroma !== ChromaSubsampling.Yuv420) {
    return softwareOnly(
      `The source is ${layout.chroma}; the hardware surface formats used here are 4:2:0, so a hardware ` +
        'decode would subsample the chroma before the float pipeline. Decoding in software.',
    );
  }

  if (layout.bitDepth > 10) {
    return softwareOnly(
      `The source carries ${layout.bitDepth} bits per component; the hardware surface formats used here carry ` +
        'at most 10. Decoding in software.',
    );
  }

  if (layout.hasAlpha) {
    return softwareOnly(
      'The source carries an alpha plane, which the hardware surface formats drop. Decoding in software.',
    );
  }

  if (qualification.dolbyVision) {
    return softwareOnly(
      `Dolby Vision ${qualification.dolbyVision.label} base-layer decoding is not qualified on the ` +
        `${config.accel.toUpperCase()} path. Decoding in software.`,
    );
  }

  return {
    config,
    accelDecode: true,
    reason:
      `${config.accel.toUpperCase()} fixed-function decoding for ` +
      `${layout.bitDepth}-bit ${layout.chroma} ${codec}.`,
  };
};
