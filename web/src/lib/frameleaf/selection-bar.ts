/**
 * The page's own actions on the selection bar (September 24 "one toolbar", `leading` in
 * `design/frameleaf/template/src/SelectionBar.jsx`): labelled buttons ahead of the icon-only bulk
 * actions, such as Compare, Quick edit and Open in Studio.
 */
export type SelectionBarLeadingAction = {
  id: string;
  /** Already translated. */
  label: string;
  /** An @mdi/js path. */
  icon: string;
  onClick: () => void;
  disabled?: boolean;
  /** The one accented action (Open in Studio in the prototype). */
  primary?: boolean;
};
