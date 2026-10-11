/**
 * Where work runs (FL-364): one answer per kind of heavy work, read from the two records the server
 * keeps today and written back to both, so the page cannot show them disagreeing.
 *
 * - The home record (`ml-destinations/routes`): for each of the server's workloads, the one computer
 *   at home it runs on, or none.
 * - The cloud record (`frameleafCloud.cloudMl.routing` in the settings): for five kinds of work,
 *   whether it stays at home, may go to Frameleaf Cloud when the person picks it, or always goes.
 *
 * On screen a row has one choice: a computer at home, "Ask me each time", Frameleaf Cloud, or
 * nowhere. "Ask" and "Frameleaf Cloud" are the cloud record's `both` and `cloud`; a computer or
 * nowhere is the home record with the cloud record set to home only. A choice is saved to both.
 * One saved record on the server is the follow-up; until then this module is the single reading.
 */
import {
  CloudRouteMode,
  MlDestinationKind,
  MlWorkload,
  type MlDestinationResponseDto,
  type MlWorkloadRouteDto,
} from '@frameleaf/sdk';
import { isRoutedWorkload, mlWorkloads, type RoutedWorkload } from '$lib/frameleaf/cloud-ml';
import type { WorkKind } from '$lib/frameleaf/work-places';

/** The server workload behind each row. Studio export is not routed: connected computers take it. */
export const ROW_WORKLOAD: Record<Exclude<WorkKind, 'render'>, MlWorkload> = {
  search: MlWorkload.Clip,
  faces: MlWorkload.Face,
  ocr: MlWorkload.Ocr,
  descriptions: MlWorkload.Enrichment,
  upscale: MlWorkload.Upscale,
  restoration: MlWorkload.RestorationFaithful,
  studio: MlWorkload.StudioAi,
  interpolation: MlWorkload.Interpolation,
};

/** Work that normally runs wherever its row does ("Finer choices"). */
export const FOLLOWERS = {
  pets: { workload: MlWorkload.PetRecognition, follows: 'faces' },
  creative: { workload: MlWorkload.RestorationCreative, follows: 'restoration' },
} as const satisfies Record<string, { workload: MlWorkload; follows: Exclude<WorkKind, 'render'> }>;
export type Follower = keyof typeof FOLLOWERS;

export const ASK = 'ask';
export const CLOUD = 'cloud';
export const NONE = 'none';
export const SAME = 'same';
/** A row's choice: the id of a computer at home, or one of the words above. */
export type RouteChoice = string;

export type RouteFacts = {
  destinations: readonly MlDestinationResponseDto[];
  routes: readonly MlWorkloadRouteDto[];
  /** The cloud record; undefined when the settings could not be read. */
  cloudRouting: Partial<Record<RoutedWorkload, CloudRouteMode>> | undefined;
  /** This server is linked and cloud processing is turned on. */
  cloudOn: boolean;
};

const isHome = (destination: MlDestinationResponseDto) => destination.kind !== MlDestinationKind.FrameleafCloud;

/** The computers at home that are switched on and allowed to do a workload, this server first. */
export const homePlaces = (workload: MlWorkload, { destinations }: Pick<RouteFacts, 'destinations'>) =>
  destinations
    .filter((destination) => isHome(destination) && destination.enabled && destination.workloads.includes(workload))
    .sort((a, b) => Number(b.kind === MlDestinationKind.Local) - Number(a.kind === MlDestinationKind.Local));

const homeRoute = (workload: MlWorkload, { destinations, routes }: Pick<RouteFacts, 'destinations' | 'routes'>) => {
  const id = routes.find((route) => route.workload === workload)?.destinationId;
  const destination = destinations.find((item) => item.id === id);
  // A route to Frameleaf Cloud in the home record is not a computer at home: the cloud record decides.
  return destination && isHome(destination) ? destination.id : NONE;
};

const canGoToCloud = (kind: WorkKind, facts: Pick<RouteFacts, 'cloudOn'>) =>
  facts.cloudOn && !!mlWorkloads.find(({ id }) => id === kind)?.cloud && isRoutedWorkload(kind);

/** What a row is set to now, from both records. */
export const currentChoice = (kind: Exclude<WorkKind, 'render'>, facts: RouteFacts): RouteChoice => {
  if (canGoToCloud(kind, facts) && isRoutedWorkload(kind)) {
    const mode = facts.cloudRouting?.[kind];
    if (mode === CloudRouteMode.Cloud) {
      return CLOUD;
    }
    if (mode === CloudRouteMode.Both) {
      return ASK;
    }
  }
  return homeRoute(ROW_WORKLOAD[kind], facts);
};

/**
 * What can be picked for a row: each real place, asking each time, and nowhere. Empty when there is
 * nothing to choose (no place can do it, or the one place that can already does), so the row says
 * where it runs and why instead of offering a picker with one answer.
 */
export const choicesFor = (kind: Exclude<WorkKind, 'render'>, facts: RouteFacts): RouteChoice[] => {
  const home = homePlaces(ROW_WORKLOAD[kind], facts).map(({ id }) => id);
  const cloud = canGoToCloud(kind, facts);
  const places = [...home, ...(cloud ? [...(home.length > 0 ? [ASK] : []), CLOUD] : [])];
  if (places.length === 0) {
    return [];
  }
  const current = currentChoice(kind, facts);
  if (places.length === 1 && current === places[0]) {
    return [];
  }
  return [...places, NONE];
};

/** What a follower is set to: "same" while it runs where its row does. */
export const followerChoice = (follower: Follower, facts: RouteFacts): RouteChoice => {
  const { workload, follows } = FOLLOWERS[follower];
  const own = homeRoute(workload, facts);
  return own === homeRoute(ROW_WORKLOAD[follows], facts) ? SAME : own;
};

export const followerChoices = (follower: Follower, facts: RouteFacts): RouteChoice[] => {
  const home = homePlaces(FOLLOWERS[follower].workload, facts).map(({ id }) => id);
  return home.length === 0 ? [] : [SAME, ...home, NONE];
};

export type RouteWrites = {
  /** Home-record writes: a workload and the computer it runs on, or null for nowhere. */
  routes: { workload: MlWorkload; destinationId: string | null }[];
  /** Cloud-record values to set. */
  cloud: Partial<Record<RoutedWorkload, CloudRouteMode>>;
};

/**
 * What saving a set of choices writes. Only what differs from the records is written. A row moved
 * to a computer or to nowhere takes its followers with it while they are set to "same"; a follower
 * that has its own place keeps it.
 */
export const routeWrites = (
  choices: Partial<Record<Exclude<WorkKind, 'render'>, RouteChoice>>,
  followers: Partial<Record<Follower, RouteChoice>>,
  facts: RouteFacts,
): RouteWrites => {
  const writes: RouteWrites = { routes: [], cloud: {} };
  const setHome = (workload: MlWorkload, choice: RouteChoice) => {
    if (homeRoute(workload, facts) !== choice) {
      writes.routes.push({ workload, destinationId: choice === NONE ? null : choice });
    }
  };
  const allows = (workload: MlWorkload, id: string) =>
    id === NONE || homePlaces(workload, facts).some((destination) => destination.id === id);

  for (const [kind, choice] of Object.entries(choices) as [Exclude<WorkKind, 'render'>, RouteChoice][]) {
    const routed = isRoutedWorkload(kind);
    const mode = choice === CLOUD ? CloudRouteMode.Cloud : choice === ASK ? CloudRouteMode.Both : CloudRouteMode.Local;
    if (routed && (facts.cloudRouting?.[kind] ?? CloudRouteMode.Local) !== mode) {
      writes.cloud[kind] = mode;
    }
    if (choice === CLOUD || choice === ASK) {
      continue;
    }
    setHome(ROW_WORKLOAD[kind], choice);
  }

  for (const follower of Object.keys(FOLLOWERS) as Follower[]) {
    const { workload, follows } = FOLLOWERS[follower];
    const wanted = followers[follower] ?? followerChoice(follower, facts);
    if (wanted !== SAME) {
      setHome(workload, wanted);
      continue;
    }
    const leader = choices[follows] ?? currentChoice(follows, facts);
    const home = leader === CLOUD || leader === ASK ? homeRoute(ROW_WORKLOAD[follows], facts) : leader;
    // A follower only goes where it is allowed to run; otherwise it stays where it was.
    if (allows(workload, home)) {
      setHome(workload, home);
    }
  }
  return writes;
};

export const hasWrites = (writes: RouteWrites) => writes.routes.length > 0 || Object.keys(writes.cloud).length > 0;
