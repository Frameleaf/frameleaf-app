import { createHash } from 'node:crypto';
import z from 'zod';
import { SidecarRefusal, type TrackState, prepareSidecarPlan } from '#studio-subtitle-sidecar';
import { canonicalJson } from 'src/utils/studio-project.js';
import { projectCadenceOf } from 'src/utils/studio-timing.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Private immutable semantic evidence, independent of a worker attempt or its reported hash. */
export const StudioSidecarSealSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal('sidecar'),
    codec: z.literal('srt'),
    required: z.literal(true),
    cadence: z.object({ num: z.int().positive(), den: z.int().positive() }).strict(),
    inPoint: z.int().nonnegative(),
    outPoint: z.int().positive(),
    cueCount: z.int().nonnegative(),
    zeroCue: z.boolean(),
    expectedSrtSha256: digest,
    sizeInBytes: z.string().regex(/^(0|[1-9][0-9]*)$/),
    cueDigest: digest,
    revisionDigest: digest,
    graphDigest: digest,
    manifestDigest: digest,
    engineDigest: digest,
  })
  .strict()
  .refine(
    (seal) =>
      seal.outPoint > seal.inPoint &&
      BigInt(seal.sizeInBytes) <= BigInt(Number.MAX_SAFE_INTEGER) &&
      seal.zeroCue === (seal.cueCount === 0) &&
      (seal.zeroCue
        ? seal.sizeInBytes === '0' && seal.expectedSrtSha256 === createHash('sha256').update('').digest('hex')
        : BigInt(seal.sizeInBytes) > 0n),
  );
export type StudioSidecarSeal = z.infer<typeof StudioSidecarSealSchema>;

export function sealStudioSidecar(
  graph: Record<string, unknown>,
  binding: Pick<StudioSidecarSeal, 'revisionDigest' | 'manifestDigest' | 'engineDigest'>,
  range?: { inPoint: number; outPoint: number },
): StudioSidecarSeal {
  const timeline = graph.timeline as Record<string, unknown> | undefined;
  if (
    (Array.isArray(graph.compositions) && graph.compositions.length > 0) ||
    (Array.isArray(timeline?.compositions) && timeline.compositions.length > 0) ||
    (timeline?.items as Record<string, unknown>[] | undefined)?.some((item) => item.type === 'composition')
  )
    throw new SidecarRefusal('Sidecar requires the root timeline');
  const plan = buildStudioSidecarSemanticPlan(graph, range);
  return StudioSidecarSealSchema.parse({
    version: 1,
    mode: 'sidecar',
    codec: 'srt',
    required: true,
    cadence: plan.cadence,
    inPoint: plan.inPoint,
    outPoint: plan.outPoint,
    cueCount: plan.cueCount,
    zeroCue: plan.zeroCue,
    expectedSrtSha256: plan.expectedSrtSha256,
    sizeInBytes: String(plan.byteLength),
    cueDigest: plan.cueDigest,
    graphDigest: createHash('sha256').update(canonicalJson(graph)).digest('hex'),
    ...binding,
  });
}

export function sidecarSealOf(settings: Record<string, unknown>): StudioSidecarSeal | null {
  if (settings.subtitleMode !== 'sidecar') {
    if (settings.subtitleSeal !== undefined) throw new SidecarRefusal('Unexpected subtitle authority');
    return null;
  }
  const seal = StudioSidecarSealSchema.safeParse(settings.subtitleSeal);
  if (!seal.success) throw new SidecarRefusal('Required subtitle authority is unavailable');
  return seal.data;
}
/** Pure semantic producer only. Does not grant resource, worker or publication authority. */
export function buildStudioSidecarSemanticPlan(
  graph: Record<string, unknown>,
  range?: { inPoint: number; outPoint: number },
) {
  const metadata = graph.metadata as { fps?: number; frameRate?: { num: number; den: number } } | undefined;
  const cadence = projectCadenceOf(metadata);
  if (!cadence) throw new SidecarRefusal('Sidecar cadence is not supported');
  const timeline = graph.timeline as { tracks: TrackState[]; items: unknown[] } | undefined;
  const plan = prepareSidecarPlan({
    tracks: timeline?.tracks as TrackState[],
    items: timeline?.items as unknown[],
    fps: metadata?.fps ?? cadence.num / cadence.den,
    frameRate: metadata?.frameRate,
    ...range,
  });
  return {
    ...plan,
    expectedSrtSha256: createHash('sha256').update(plan.content, 'utf8').digest('hex'),
    cueDigest: createHash('sha256').update(canonicalJson(plan.cues)).digest('hex'),
  };
}
