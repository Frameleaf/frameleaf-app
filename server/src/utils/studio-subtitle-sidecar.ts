import { createHash } from 'node:crypto';
import { SidecarRefusal, type TrackState, prepareSidecarPlan } from '#studio-subtitle-sidecar';
import { canonicalJson } from 'src/utils/studio-project.js';
import { projectCadenceOf } from 'src/utils/studio-timing.js';
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
