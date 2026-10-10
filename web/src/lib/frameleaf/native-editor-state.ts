import type { AssetDevelopResponseDto } from '@frameleaf/sdk';

/** Publication is later than rendering; historical successes never satisfy an admitted target. */
export function nativePublicationState(develop: AssetDevelopResponseDto, targetId: string | undefined) {
  const target = develop.revisions.find((revision) => revision.id === targetId);
  return {
    published: !!target && target.status === 'rendered' && develop.currentRevisionId === targetId,
    awaitingPublication: !!target && target.status === 'rendered' && develop.currentRevisionId !== targetId,
    terminal: !!target && ['failed', 'cancelled', 'saved'].includes(target.status),
  };
}

/** Use isotropic image-pixel units; radius fractions always refer to the shorter edge. */
export function nativeStrokeOverlay(
  stroke: { points: [number, number][]; radius: number },
  width: number,
  height: number,
) {
  return {
    points: stroke.points.map(([x, y]) => `${x * width},${y * height}`).join(' '),
    radius: stroke.radius * Math.min(width, height),
    first: { x: stroke.points[0][0] * width, y: stroke.points[0][1] * height },
  };
}
