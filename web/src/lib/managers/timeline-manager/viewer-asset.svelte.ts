import type { CommonPosition } from '$lib/utils/layout-utils';
import type { TimelineMonth } from './timeline-month.svelte';
import type { TimelineAsset } from './types';

type FlowHost = { month: TimelineMonth; owner: TimelineMonth };

const samePosition = (a: CommonPosition | undefined, b: CommonPosition | undefined) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

export class ViewerAsset {
  #position: CommonPosition | undefined = $state.raw();
  #host: FlowHost | undefined = $state.raw();
  asset: TimelineAsset = $state() as TimelineAsset;
  id: string = $derived(this.asset.id);

  constructor(asset: TimelineAsset) {
    this.asset = asset;
  }

  /**
   * Where the tile sits, measured from the first row of its own month. A tile that a later month
   * lays out (a Years or All row running across a month boundary, FL-143) is still measured from
   * its own month, so everything that places it — scrolling to it, the scroll anchor, which tiles
   * are near the viewport — needs no special case.
   */
  get position(): CommonPosition | undefined {
    const position = this.#position;
    const host = this.#host;
    if (!position || !host) {
      return position;
    }
    const offset = host.month.top + host.month.groupHeaderHeight - (host.owner.top + host.owner.groupHeaderHeight);
    return { ...position, top: position.top + offset };
  }

  set position(position: CommonPosition | undefined) {
    // A flow lays a month out again whenever a neighbour changes (FL-143); a tile that did not move
    // keeps its position, so it is not drawn again.
    if (!this.#host && samePosition(this.#position, position)) {
      return;
    }
    this.#position = position;
    this.#host = undefined;
  }

  /** The later month whose rows this tile is laid out and drawn in, if any (FL-143). */
  get flowHost(): TimelineMonth | undefined {
    return this.#host?.month;
  }

  /** For a tile a later month lays out: where it sits, measured from that month's first row. */
  get flowPosition(): CommonPosition | undefined {
    return this.#host ? this.#position : undefined;
  }

  /** Lay the tile out in a later month's rows: `position` is measured from `host`'s first row. */
  placeInFlow(host: TimelineMonth, owner: TimelineMonth, position: CommonPosition) {
    if (this.#host?.month === host && this.#host.owner === owner && samePosition(this.#position, position)) {
      return;
    }
    this.#position = position;
    this.#host = { month: host, owner };
  }
}
