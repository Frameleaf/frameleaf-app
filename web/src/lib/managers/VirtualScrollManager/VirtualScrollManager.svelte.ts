import { debounce, isEqual } from 'lodash-es';
import type { CellGridOptions } from '$lib/frameleaf/library-grid';

type LayoutOptions = {
  headerHeight: number;
  rowHeight: number;
  gap: number;
  /**
   * Frameleaf (FL-33): lay groups out with the filling justified algorithm, so the last row of a
   * day group spans the timeline instead of trailing off. Off by default; the Frameleaf library
   * layouts turn it on.
   */
  fillRowWidth: boolean;
  /**
   * Frameleaf (FL-33): lay each month out as a grid of equal cells instead of justified rows — the
   * Browse square grid and the Work grid. `null` keeps the justified rows (Timeline).
   */
  cells: CellGridOptions | null;
  /**
   * Frameleaf (FL-33, T-7): a caption row under every justified Timeline row. The photo keeps the
   * row height and the row pitch grows by this much (template timeline-library.css `.tl-row .at-open
   * { height: var(--tl-h) }` with `.at-caption` 6px below it).
   */
  captionHeight: number;
};
export abstract class VirtualScrollManager {
  topSectionHeight = $state(0);
  bodySectionHeight = $state(0);
  bottomSectionHeight = $state(0);
  totalViewerHeight = $derived.by(() => this.topSectionHeight + this.bodySectionHeight + this.bottomSectionHeight);

  visibleWindow = $derived.by(() => ({
    top: this.#scrollTop,
    bottom: this.#scrollTop + this.viewportHeight,
  }));

  #viewportHeight = $state(0);
  #viewportWidth = $state(0);
  #scrollTop = $state(0);
  #rowHeight = $state(235);
  #headerHeight = $state(48);
  #gap = $state(12);
  #fillRowWidth = $state(false);
  #cells = $state<CellGridOptions | null>(null);
  #captionHeight = $state(0);
  #scrolling = $state(false);
  #suspendTransitions = $state(false);
  #resetScrolling = debounce(() => (this.#scrolling = false), 1000);
  #resetSuspendTransitions = debounce(() => (this.suspendTransitions = false), 1000);
  #justifiedLayoutOptions = $derived({
    spacing: 2,
    heightTolerance: 0.5,
    rowHeight: this.#rowHeight,
    rowWidth: Math.floor(this.viewportWidth),
    fillRowWidth: this.#fillRowWidth,
    captionHeight: this.#captionHeight,
  });

  constructor() {
    this.setLayoutOptions();
  }

  get scrollTop() {
    return 0;
  }

  get justifiedLayoutOptions() {
    return this.#justifiedLayoutOptions;
  }

  get maxScrollPercent() {
    const totalHeight = this.totalViewerHeight;
    return (totalHeight - this.viewportHeight) / totalHeight;
  }

  get maxScroll() {
    return this.totalViewerHeight - this.viewportHeight;
  }

  #setHeaderHeight(value: number) {
    if (this.#headerHeight === value) {
      return false;
    }
    this.#headerHeight = value;
    return true;
  }

  get headerHeight() {
    return this.#headerHeight;
  }

  #setGap(value: number) {
    if (this.#gap === value) {
      return false;
    }
    this.#gap = value;
    return true;
  }

  get gap() {
    return this.#gap;
  }

  #setRowHeight(value: number) {
    if (this.#rowHeight === value) {
      return false;
    }
    this.#rowHeight = value;
    return true;
  }

  get rowHeight() {
    return this.#rowHeight;
  }

  #setFillRowWidth(value: boolean) {
    if (this.#fillRowWidth === value) {
      return false;
    }
    this.#fillRowWidth = value;
    return true;
  }

  get fillRowWidth() {
    return this.#fillRowWidth;
  }

  #setCells(value: CellGridOptions | null) {
    if (isEqual(this.#cells, value)) {
      return false;
    }
    this.#cells = value;
    return true;
  }

  #setCaptionHeight(value: number) {
    if (this.#captionHeight === value) {
      return false;
    }
    this.#captionHeight = value;
    return true;
  }

  /** The caption row under each justified row (Timeline captions), or 0. */
  get captionHeight() {
    return this.#captionHeight;
  }

  /** The Browse or Work cell grid, or `null` for justified rows. */
  get cells() {
    return this.#cells;
  }

  set scrolling(value: boolean) {
    this.#scrolling = value;
    if (value) {
      this.suspendTransitions = true;
      this.#resetScrolling();
    }
  }

  get scrolling() {
    return this.#scrolling;
  }

  set suspendTransitions(value: boolean) {
    this.#suspendTransitions = value;
    if (value) {
      this.#resetSuspendTransitions();
    }
  }

  get suspendTransitions() {
    return this.#suspendTransitions;
  }

  set viewportWidth(value: number) {
    const changed = value !== this.#viewportWidth;
    this.#viewportWidth = value;
    this.suspendTransitions = true;
    void this.updateViewportGeometry(changed);
  }

  get viewportWidth() {
    return this.#viewportWidth;
  }

  set viewportHeight(value: number) {
    this.#viewportHeight = value;
    this.#suspendTransitions = true;
    void this.updateViewportGeometry(false);
  }

  get viewportHeight() {
    return this.#viewportHeight;
  }

  get hasEmptyViewport() {
    return this.viewportWidth === 0 || this.viewportHeight === 0;
  }

  protected updateViewportProximities(): void {}

  protected updateViewportGeometry(_: boolean) {}

  setLayoutOptions({
    headerHeight = 48,
    rowHeight = 235,
    gap = 12,
    fillRowWidth = false,
    cells = null,
    captionHeight = 0,
  }: Partial<LayoutOptions> = {}) {
    // Note: every setter must run. `||=` short-circuits, so the first option that reported a change
    // used to stop the rest from being applied at all — switching to the mobile layout set the
    // header height and silently kept the desktop row height.
    const changes = [
      this.#setHeaderHeight(headerHeight),
      this.#setGap(gap),
      this.#setRowHeight(rowHeight),
      this.#setFillRowWidth(fillRowWidth),
      this.#setCells(cells),
      this.#setCaptionHeight(captionHeight),
    ];
    if (changes.includes(true)) {
      this.refreshLayout();
    }
  }

  updateSlidingWindow() {
    const scrollTop = this.scrollTop;
    if (this.#scrollTop !== scrollTop) {
      this.#scrollTop = scrollTop;
      this.updateViewportProximities();
    }
  }

  refreshLayout() {
    this.updateViewportProximities();
  }

  destroy(): void {}
}
