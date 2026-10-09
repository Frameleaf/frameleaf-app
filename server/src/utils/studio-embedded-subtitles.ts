import { createHash } from 'node:crypto';
import z from 'zod';
import { canonicalJson } from 'src/utils/studio-project.js';
import {
  type StudioSidecarSeal,
  StudioSidecarSealSchema,
  buildStudioSidecarSemanticPlan,
  sealStudioSidecar,
} from 'src/utils/studio-subtitle-sidecar.js';

const CueSchema = z
  .object({ startMs: z.int().nonnegative(), endMs: z.int().positive(), text: z.string().min(1) })
  .strict();
/** Embedded track authority uses the same immutable, range-clipped cue producer as SRT. */
export const StudioEmbeddedSubtitleSealSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal('embedded'),
    container: z.literal('mp4'),
    codec: z.literal('mov_text'),
    language: z.literal('und'),
    default: z.literal(1),
    forced: z.literal(0),
    source: StudioSidecarSealSchema,
    decodedCueDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .refine(
    (seal) => !seal.source.zeroCue && seal.source.cueCount > 0 && BigInt(seal.source.sizeInBytes) <= 1024n * 1024n,
  );
export type StudioEmbeddedSubtitleSeal = z.infer<typeof StudioEmbeddedSubtitleSealSchema>;

export function sealStudioEmbeddedSubtitles(
  graph: Record<string, unknown>,
  binding: Pick<StudioSidecarSeal, 'revisionDigest' | 'manifestDigest' | 'engineDigest'>,
  range?: { inPoint: number; outPoint: number },
): StudioEmbeddedSubtitleSeal {
  const source = sealStudioSidecar(graph, binding, range);
  const plan = buildStudioSidecarSemanticPlan(graph, range);
  const cues = plan.cues.map((cue) => ({
    startMs: Math.round(cue.startSeconds * 1000),
    endMs: Math.round(cue.endSeconds * 1000),
    text: cue.text.trim(),
  }));
  if (
    cues.length === 0 ||
    cues.some(
      (cue, i) =>
        cue.endMs <= cue.startMs ||
        (i > 0 && cue.startMs < cues[i - 1].endMs) ||
        /[<>{}\r]/u.test(cue.text) ||
        cue.text.includes('\n\n'),
    )
  )
    throw new Error('MP4 timed text requires nonempty plain captions without overlapping cues');
  return StudioEmbeddedSubtitleSealSchema.parse({
    version: 1,
    mode: 'embedded',
    container: 'mp4',
    codec: 'mov_text',
    language: 'und',
    default: 1,
    forced: 0,
    source,
    decodedCueDigest: createHash('sha256').update(canonicalJson(cues)).digest('hex'),
  });
}

export function embeddedSubtitleSealOf(settings: Record<string, unknown>): StudioEmbeddedSubtitleSeal | null {
  if (settings.subtitleMode !== 'embedded') {
    if (settings.embeddedSubtitleSeal !== undefined) throw new Error('Unexpected embedded subtitle authority');
    return null;
  }
  return StudioEmbeddedSubtitleSealSchema.parse(settings.embeddedSubtitleSeal);
}

/** Decode output semantics independently of SRT numbering, line endings and trailing newlines. */
export function parseEmbeddedSrt(content: string) {
  if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Embedded subtitles exceed their resource limit');
  const ms = (stamp: string) => {
    const [h, m, s, fraction] = stamp.split(/[:,]/u).map(Number);
    const value = ((h * 60 + m) * 60 + s) * 1000 + fraction;
    if (!Number.isSafeInteger(value) || m > 59 || s > 59) throw new Error('Invalid subtitle timestamp');
    return value;
  };
  return content
    .replaceAll('\r\n', '\n')
    .trim()
    .split('\n\n')
    .map((block) => {
      const [index, timing, ...text] = block.split('\n');
      const match = /^(\d{2,}:\d{2}:\d{2},\d{3}) --> (\d{2,}:\d{2}:\d{2},\d{3})$/u.exec(timing ?? '');
      if (!/^\d+$/u.test(index) || !match || text.length === 0) throw new Error('Invalid decoded subtitle cue');
      return CueSchema.parse({ startMs: ms(match[1]), endMs: ms(match[2]), text: text.join('\n').trim() });
    });
}

export function findEmbeddedSubtitleMismatch(
  seal: StudioEmbeddedSubtitleSeal,
  measured: {
    streams: { codec: string | null; language: string | null; default: number; forced: number }[];
    content: string;
  },
): string | null {
  const [stream] = measured.streams;
  if (
    measured.streams.length !== 1 ||
    !stream ||
    stream.codec !== seal.codec ||
    stream.language !== seal.language ||
    stream.default !== seal.default ||
    stream.forced !== seal.forced
  )
    return 'The embedded subtitle stream does not match its immutable contract';
  try {
    if (
      createHash('sha256')
        .update(canonicalJson(parseEmbeddedSrt(measured.content)))
        .digest('hex') === seal.decodedCueDigest
    )
      return null;
  } catch {
    /* Malformed decode is an output refusal. */
  }
  return 'The decoded subtitle cues do not match their immutable text and timestamps';
}
