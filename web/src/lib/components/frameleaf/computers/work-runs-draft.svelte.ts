/**
 * The choices made on Where work runs and not saved yet (FL-1252). The Computers page keeps one for each
 * of its views, so a pick survives switching Everyday and Advanced or opening a computer's details, which
 * draw the table afresh.
 */
import type { MlProcessingSource, MlWhenUnavailable, StartWith } from '@frameleaf/sdk';
import type { WorkKind } from '$lib/frameleaf/work-places';
import type { Follower, RouteChoice } from '$lib/frameleaf/work-routes';

export class WorkRunsDraft {
  picked = $state<Partial<Record<Exclude<WorkKind, 'render'>, RouteChoice>>>({});
  followers = $state<Partial<Record<Follower, RouteChoice>>>({});
  suggest = $state<StartWith>();
  order = $state<MlProcessingSource[]>();
  when = $state<MlWhenUnavailable>();

  clear() {
    this.picked = {};
    this.followers = {};
    this.order = undefined;
    this.when = undefined;
    this.suggest = undefined;
  }
}
