/**
 * The Command Center Overview's readiness rows (FL-71 CC-9, `CommandCenter.jsx:1790-1812, 1905-1935`)
 * from real server state, kept free of the DOM so the rules can be tested.
 */
import {
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkload,
  type MlDestinationResponseDto,
  type MlWorkloadRouteDto,
  type RenderWorkerCompatibilityResponseDto,
} from '@immich/sdk';

/** The workloads the ordinary machine-learning container serves (the Overview's "ML endpoint"). */
const LIBRARY_WORKLOADS = new Set<MlWorkload>([
  MlWorkload.Face,
  MlWorkload.Clip,
  MlWorkload.Ocr,
  MlWorkload.Enrichment,
]);

const libraryDestinations = (destinations: MlDestinationResponseDto[], routes: MlWorkloadRouteDto[]) => {
  const routed = new Set(
    routes.filter((route) => LIBRARY_WORKLOADS.has(route.workload) && route.destinationId).map((r) => r.destinationId),
  );
  return destinations.filter((destination) => routed.has(destination.id));
};

export type MlEndpointState = 'reachable' | 'unreachable' | 'unchecked' | 'none';

/**
 * "ML endpoint": the destinations library analysis is routed to, by their last probe. Reachable when
 * every one answered, unreachable when one did not, unchecked before any probe.
 */
export const mlEndpointState = (
  destinations: MlDestinationResponseDto[],
  routes: MlWorkloadRouteDto[],
): MlEndpointState => {
  const routed = libraryDestinations(destinations, routes);
  if (routed.length === 0) {
    return 'none';
  }
  if (routed.some((destination) => destination.health.status === MlDestinationHealth.Unhealthy)) {
    return 'unreachable';
  }
  return routed.every((destination) => destination.health.status === MlDestinationHealth.Healthy)
    ? 'reachable'
    : 'unchecked';
};

/** "Cloud destination": Frameleaf Cloud when a library workload is routed to it (FL-159). */
export const cloudDestinationState = (
  destinations: MlDestinationResponseDto[],
  routes: MlWorkloadRouteDto[],
): 'frameleaf' | 'local' =>
  libraryDestinations(destinations, routes).some((destination) => destination.kind === MlDestinationKind.FrameleafCloud)
    ? 'frameleaf'
    : 'local';

/** "GPU Studio": qualified when every render kind has a qualified GPU worker. */
export const gpuStudioState = (compatibility: RenderWorkerCompatibilityResponseDto): 'qualified' | 'check' =>
  compatibility.unavailable.length === 0 ? 'qualified' : 'check';
