import type { SystemConfig } from 'src/config.js';
import type { MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import {
  DEFAULT_ML_PROCESSING_ORDER,
  MlDestinationHealth,
  MlDestinationKind,
  MlProcessingSource,
  MlProcessingSourceState,
  MlWorkload,
} from 'src/enum.js';
import { cloudRouteAllows, hasRequiredConsent } from 'src/utils/ml-destination.js';

/**
 * FL-456: where processing runs. Every workload follows one ordered list of places (this server, the
 * person's computers, Frameleaf Cloud) unless it has a list of its own. A job runs on the first place
 * that is available and allowed to do its work; when none is, it waits. Work is never sent to a place
 * that is not in its list.
 *
 * This module is pure: it turns stored rows into the ordered candidates. Admission
 * (`selectMlDestination`) still checks the chosen one live before anything is sent.
 */

/** The scope of the main list in `ml_processing_order`; any other scope is a workload. */
export const ML_PROCESSING_ORDER_DEFAULT_SCOPE = 'default';

/** Work a Frameleaf Desktop helper can take, through the desktop assistance pool (FL-490). */
export const DESKTOP_POOL_WORKLOADS: readonly MlWorkload[] = [MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Face];

export const KIND_SOURCE: Record<MlDestinationKind, MlProcessingSource> = {
  [MlDestinationKind.Local]: MlProcessingSource.Local,
  [MlDestinationKind.Lan]: MlProcessingSource.Desktops,
  [MlDestinationKind.FrameleafCloud]: MlProcessingSource.Cloud,
};

export type MlProcessingOrder = {
  /** The main list. */
  order: MlProcessingSource[];
  /** Workloads with a list of their own. An empty list keeps the workload off. */
  overrides: Partial<Record<MlWorkload, MlProcessingSource[]>>;
};

/** One place a job may run, in the order it is tried. */
export type MlRouteCandidate = {
  source: MlProcessingSource;
  destinationId: string;
  /**
   * The job goes to a Frameleaf Desktop helper through `destinationId`'s desktop assistance pool, not to
   * `destinationId` itself (whose health does not matter to it).
   */
  desktopPool: boolean;
  /** From what is stored: turned on, allowed, consented, within budget and not known to be down. */
  available: boolean;
};

/** The route this server recorded for a workload: the anchor the desktop assistance pool hangs off. */
export type StoredRouteState = {
  destinationId: string | null;
  origin: 'default' | 'pinned' | 'legacy' | null;
};

export type MlRoutePlanInput = {
  workload: MlWorkload;
  order: MlProcessingOrder;
  /** Every destination, oldest first. */
  destinations: readonly MlDestinationRow[];
  storedRoute?: StoredRouteState;
  /** The saved Frameleaf Cloud processing settings; without them the cloud gate is left to admission. */
  cloudMl?: Pick<SystemConfig['frameleafCloud']['cloudMl'], 'enabled' | 'routing'>;
  /** Some approved Frameleaf Desktop helper is online and qualified now. */
  desktopsReady: boolean;
  /** Spend in the current budget window, for destinations with a budget limit. */
  spentUsd?: ReadonlyMap<string, number>;
};

/** Whether `sources` is a list of places, each named at most once. */
export const isProcessingOrder = (sources: unknown): sources is MlProcessingSource[] =>
  Array.isArray(sources) &&
  sources.every((source) => Object.values(MlProcessingSource).includes(source)) &&
  new Set(sources).size === sources.length;

/**
 * The list a workload follows: its own, else the one place an administrator pinned it to (a route
 * restored by Buddy recovery, or saved before its own list was), else the main one.
 */
export const sourcesFor = (
  order: MlProcessingOrder,
  workload: MlWorkload,
  pinned?: { storedRoute?: StoredRouteState; destinations: readonly Pick<MlDestinationRow, 'id' | 'kind'>[] },
): MlProcessingSource[] => {
  const own = order.overrides[workload];
  if (own) {
    return own;
  }
  if (pinned?.storedRoute?.origin === 'pinned') {
    const { destinationId } = pinned.storedRoute;
    const anchor = pinned.destinations.find((destination) => destination.id === destinationId);
    return anchor ? [KIND_SOURCE[anchor.kind]] : [];
  }
  return order.order;
};

/** Whether a workload follows the main list: no list of its own and no place pinned for it. */
export const followsMainOrder = (order: MlProcessingOrder, workload: MlWorkload, storedRoute?: StoredRouteState) =>
  order.overrides[workload] === undefined && storedRoute?.origin !== 'pinned';

/**
 * The stored order as read from the table, with the main list falling back to the default when its row
 * is missing or unreadable. Unreadable workload rows are ignored, so they follow the main list.
 */
export const processingOrderOf = (rows: ReadonlyArray<{ scope: string; sources: unknown }>): MlProcessingOrder => {
  const workloads = new Set<string>(Object.values(MlWorkload));
  const main = rows.find((row) => row.scope === ML_PROCESSING_ORDER_DEFAULT_SCOPE)?.sources;
  const overrides: MlProcessingOrder['overrides'] = {};
  for (const row of rows) {
    if (workloads.has(row.scope) && isProcessingOrder(row.sources)) {
      overrides[row.scope as MlWorkload] = row.sources;
    }
  }
  return { order: isProcessingOrder(main) ? main : [...DEFAULT_ML_PROCESSING_ORDER], overrides };
};

/** A destination that is turned on and allowed to run the workload. */
const configured = (destination: MlDestinationRow, workload: MlWorkload) =>
  destination.enabled && destination.workloads.includes(workload);

const withinBudget = (destination: MlDestinationRow, spentUsd?: ReadonlyMap<string, number>) =>
  destination.budgetLimitUsd === null || (spentUsd?.get(destination.id) ?? 0) < destination.budgetLimitUsd;

/** What is stored says this destination can take the workload now. Admission checks again, live. */
export const storedAvailable = (
  destination: MlDestinationRow,
  workload: MlWorkload,
  { cloudMl, spentUsd }: Pick<MlRoutePlanInput, 'cloudMl' | 'spentUsd'> = {},
) => {
  if (!configured(destination, workload) || !hasRequiredConsent(destination)) {
    return false;
  }
  if (destination.lastProbeHealth === MlDestinationHealth.Unhealthy || !withinBudget(destination, spentUsd)) {
    return false;
  }
  if (destination.kind === MlDestinationKind.FrameleafCloud && cloudMl) {
    return cloudMl.enabled && cloudRouteAllows(cloudMl, workload);
  }
  return true;
};

/**
 * Every place the workload may run, in the order it is tried. A place that is configured but not
 * available now is listed (`available: false`), so a job that finds nothing available can wait on the
 * first one and be told why.
 */
export const planMlRoute = (input: MlRoutePlanInput): MlRouteCandidate[] => {
  const { workload, destinations, storedRoute } = input;
  const anchor = storedRoute?.destinationId
    ? destinations.find((destination) => destination.id === storedRoute.destinationId)
    : undefined;
  // The destination this server recorded comes first among those of its kind.
  const ofKind = (kind: MlDestinationKind) =>
    destinations
      .filter((destination) => destination.kind === kind && configured(destination, workload))
      .toSorted((a, b) => Number(b.id === anchor?.id) - Number(a.id === anchor?.id));
  const candidate = (destination: MlDestinationRow): MlRouteCandidate => ({
    source: KIND_SOURCE[destination.kind],
    destinationId: destination.id,
    desktopPool: false,
    available: storedAvailable(destination, workload, input),
  });

  const candidates: MlRouteCandidate[] = [];
  for (const source of sourcesFor(input.order, workload, { storedRoute, destinations })) {
    switch (source) {
      case MlProcessingSource.Local: {
        candidates.push(...ofKind(MlDestinationKind.Local).map((destination) => candidate(destination)));
        break;
      }
      case MlProcessingSource.Desktops: {
        candidates.push(...ofKind(MlDestinationKind.Lan).map((destination) => candidate(destination)));
        // The desktop assistance pool takes work only through the route this server recorded on its own
        // (its proofs name that route's revision), so it is offered only there.
        if (
          DESKTOP_POOL_WORKLOADS.includes(workload) &&
          storedRoute?.origin === 'default' &&
          anchor &&
          anchor.kind !== MlDestinationKind.FrameleafCloud &&
          configured(anchor, workload)
        ) {
          candidates.push({
            source,
            destinationId: anchor.id,
            desktopPool: true,
            available: input.desktopsReady,
          });
        }
        break;
      }
      case MlProcessingSource.Cloud: {
        candidates.push(...ofKind(MlDestinationKind.FrameleafCloud).map((destination) => candidate(destination)));
        break;
      }
    }
  }
  return candidates;
};

export type MlProcessingSourceStatus = {
  source: MlProcessingSource;
  state: MlProcessingSourceState;
  ready: number;
  total: number;
};

const NO_DESKTOPS = { approved: 0, ready: 0 };

const destinationReady = (destination: MlDestinationRow) =>
  destination.enabled && destination.lastProbeHealth !== MlDestinationHealth.Unhealthy;

/**
 * FL-456: what the settings page says about each place, in plain terms: whether it can take work now, is
 * off, did not answer, still needs permission (Frameleaf Cloud) or is not set up.
 */
export const processingSourceStatuses = (
  destinations: readonly MlDestinationRow[],
  desktops: { approved: number; ready: number },
  cloudProcessingOn: boolean,
): MlProcessingSourceStatus[] => {
  const ofKind = (kind: MlDestinationKind) => destinations.filter((destination) => destination.kind === kind);
  const homeState = (
    rows: MlDestinationRow[],
    extra: { approved: number; ready: number } = NO_DESKTOPS,
  ): MlProcessingSourceStatus['state'] => {
    if (rows.length + extra.approved === 0) {
      return MlProcessingSourceState.NotSetUp;
    }
    if (rows.some((row) => destinationReady(row)) || extra.ready > 0) {
      return MlProcessingSourceState.Ready;
    }
    return extra.approved === 0 && rows.every((row) => !row.enabled)
      ? MlProcessingSourceState.TurnedOff
      : MlProcessingSourceState.NotAnswering;
  };

  const local = ofKind(MlDestinationKind.Local);
  const lan = ofKind(MlDestinationKind.Lan);
  const cloud = ofKind(MlDestinationKind.FrameleafCloud);
  const cloudState = () => {
    if (cloud.length === 0) {
      return MlProcessingSourceState.NotSetUp;
    }
    if (!cloudProcessingOn || cloud.every((row) => !row.enabled)) {
      return MlProcessingSourceState.TurnedOff;
    }
    const enabled = cloud.filter((row) => row.enabled);
    if (enabled.every((row) => !hasRequiredConsent(row))) {
      return MlProcessingSourceState.NeedsPermission;
    }
    return enabled.some((row) => hasRequiredConsent(row) && destinationReady(row))
      ? MlProcessingSourceState.Ready
      : MlProcessingSourceState.NotAnswering;
  };

  const cloudNow = cloudState();
  return [
    {
      source: MlProcessingSource.Local,
      state: homeState(local),
      ready: local.filter((row) => destinationReady(row)).length,
      total: local.length,
    },
    {
      source: MlProcessingSource.Desktops,
      state: homeState(lan, desktops),
      ready: lan.filter((row) => destinationReady(row)).length + desktops.ready,
      total: lan.length + desktops.approved,
    },
    {
      source: MlProcessingSource.Cloud,
      state: cloudNow,
      ready: cloudNow === MlProcessingSourceState.Ready ? 1 : 0,
      total: cloud.length > 0 ? 1 : 0,
    },
  ];
};

/**
 * Where a job of this workload goes now: the first available place, else the first place in its list
 * (the job then waits on it), else nowhere.
 */
export const firstCandidate = (candidates: readonly MlRouteCandidate[]): MlRouteCandidate | undefined =>
  candidates.find((candidate) => candidate.available) ?? candidates[0];
