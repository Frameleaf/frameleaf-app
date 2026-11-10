/**
 * The page's own actions on the selection bar (September 24 "one toolbar", `leading` in
 * `design/frameleaf/template/src/SelectionBar.jsx`): labelled buttons after the everyday bulk
 * actions (FL-1391 B2), such as Compare, Quick edit and Open in Studio.
 */
export type SelectionBarLeadingAction = {
  id: string;
  /** Already translated. */
  label: string;
  /** An @mdi/js path. */
  icon: string;
  onClick: () => void;
  disabled?: boolean;
  /**
   * Why the action is unavailable, already translated ("Select two or more to compare"). With it a
   * disabled action stays focusable and says so, instead of being a dead control.
   */
  disabledReason?: string;
};
