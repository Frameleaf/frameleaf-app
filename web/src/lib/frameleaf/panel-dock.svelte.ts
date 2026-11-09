/**
 * How many selection capsules are open (SelectionBar); the transfer dock (PanelDock) rises above
 * them. Not a `:root:has(.selection-bar.is-open)` rule: Chrome checks a `:has()` on the root again
 * whenever a span or input is added anywhere, and re-styles every span and input in the page, so each
 * frame of a photo grid scroll re-styled the whole sidebar.
 */
export const dockLift = $state({ selections: 0 });
