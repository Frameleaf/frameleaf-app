/**
 * The Command Center Overview's readiness rows (FL-71 CC-9, `CommandCenter.jsx:1790-1812, 1905-1935`)
 * from real server state, kept free of the DOM so the rules can be tested.
 */
import {
  CloudLinkState,
  LicenseState,
  MlDestinationHealth,
  MlWorkload,
  type CloudStatusResponseDto,
  type LicenseStatusResponseDto,
  type MlDestinationResponseDto,
  type MlWorkloadRouteDto,
  type RenderWorkerCompatibilityResponseDto,
} from '@frameleaf/sdk';

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

/** The Frameleaf Cloud glance tile's link part (FL-168; `cloudSummary` in frameleaf-cloud-data.mjs). */
export type CloudGlanceLink = 'linked' | 'pending' | 'unlinked';
/** Its plan part: the plan when there is one, else a supporter key, else none. */
export type CloudGlancePlan = 'none' | 'supporter' | 'active' | 'grace' | 'expired' | 'invalid';

/** Plans the Overview flags for the administrator's attention. */
const ATTENTION_PLANS: ReadonlySet<CloudGlancePlan> = new Set(['grace', 'expired', 'invalid']);

export type CloudGlance =
  | { configured: false; attention: false }
  | { configured: true; link: CloudGlanceLink; remote: boolean; plan: CloudGlancePlan; attention: boolean };

/**
 * "Frameleaf Cloud" on the Overview (FL-168), the prototype's `cloudSummary`: link state · remote
 * access on or off · plan, from the cloud manager's status and licence. A server without
 * `FRAMELEAF_CLOUD_URL` reads "Not set up" and nothing else, since it never contacts Frameleaf Cloud.
 * A plan in its grace period or expired needs attention.
 */
export const cloudGlance = (
  status: Pick<CloudStatusResponseDto, 'state' | 'configured' | 'remoteAccessEnabled'>,
  license?: Pick<LicenseStatusResponseDto, 'state' | 'plan' | 'entitlements'> | null,
): CloudGlance => {
  if (!status.configured || status.state === CloudLinkState.NotConfigured) {
    return { configured: false, attention: false };
  }
  const link: CloudGlanceLink =
    status.state === CloudLinkState.Linked
      ? 'linked'
      : status.state === CloudLinkState.Pending
        ? 'pending'
        : 'unlinked';
  let plan: CloudGlancePlan;
  if (license?.plan) {
    switch (license.state) {
      case LicenseState.Active: {
        plan = 'active';
        break;
      }
      case LicenseState.Grace: {
        plan = 'grace';
        break;
      }
      case LicenseState.Expired: {
        plan = 'expired';
        break;
      }
      case LicenseState.Invalid: {
        plan = 'invalid';
        break;
      }
      default: {
        plan = 'none';
      }
    }
  } else {
    plan = license?.entitlements?.supporter ? 'supporter' : 'none';
  }
  return {
    configured: true,
    link,
    remote: status.remoteAccessEnabled,
    plan,
    attention: ATTENTION_PLANS.has(plan),
  };
};

/** "GPU Studio": qualified when every render kind has a qualified GPU worker. */
export const gpuStudioState = (compatibility: RenderWorkerCompatibilityResponseDto): 'qualified' | 'check' =>
  compatibility.unavailable.length === 0 ? 'qualified' : 'check';
