/**
 * The numeric brand scales for script use, mirrored from ./brand-tokens.json and ./tokens.css
 * (tokens.spec.ts fails if the three drift). CSS reads the `--fl-*` custom properties; scripts that
 * need a number (an icon `size` prop, a Svelte transition, a Web Animations call) read these.
 */

/** Icon sizes in px, as numbers, for arithmetic and inline styles. */
export const ICON_PX = {
  /** Inline marks inside badges and chips. */
  xs: 12,
  /** Dense rows and captions. */
  sm: 14,
  /** The default: buttons, menu items, fields. */
  md: 16,
  /** Toolbars, rails and dialog chrome. */
  lg: 18,
  /** Prominent actions and section headers. */
  xl: 20,
  /** Empty states and error cards. */
  hero: 28,
} as const;

export type IconSize = keyof typeof ICON_PX;

/**
 * The same sizes as the strings the `Icon` component's `size` prop takes (an SVG length in user
 * units, so `'18'` is 18px): `<Icon {icon} size={ICON_SIZE.lg} />`. For a number, use `ICON_PX`.
 */
export const ICON_SIZE = {
  xs: '12',
  sm: '14',
  md: '16',
  lg: '18',
  xl: '20',
  hero: '28',
} as const satisfies Record<IconSize, string>;

/** Durations in ms, one per motion pattern (tokens.css `--fl-duration-*`, `--fl-motion*`). */
export const DURATION = {
  fast: 120,
  base: 180,
  slow: 240,
  fade: 200,
  press: 90,
  spring: 380,
  pop: 320,
  dock: 420,
  sheet: 480,
  hero: 520,
  /** The opacity crossfade every pattern becomes under Reduce Motion. */
  reduced: 150,
  /** One turn of the ring spinner. */
  spin: 800,
  /** One breath of a skeleton placeholder. */
  pulse: 1600,
} as const;

/** The delay between staggered Reveal items, and the most items that stagger. */
export const STAGGER_MS = 30;
export const STAGGER_LIMIT = 8;

/** Exit durations in ms. Exits are shorter than entrances and never overshoot. */
export const EXIT_DURATION = {
  pop: 120,
  sheet: 180,
  dock: 200,
} as const;

/** Control heights in px: the 44px floor, 48px for touch, 34px for opt-in compact desktop controls. */
export const CONTROL_HEIGHT = {
  compact: 34,
  default: 44,
  touch: 48,
} as const;

/** Stacking layers (tokens.css `--fl-z-*`). */
export const Z_INDEX = {
  sticky: 10,
  rail: 20,
  popover: 30,
  dock: 35,
  scrim: 40,
  modal: 50,
  toast: 60,
  menu: 70,
  tooltip: 90,
} as const;

/** tokens.css `--fl-ease`: opacity and colour changes. */
export const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
/** tokens.css `--fl-snappy`: small moves and every exit. */
export const SNAPPY = 'cubic-bezier(0.2, 0.9, 0.1, 1)';
/** Logo rules (Logo.svelte enforces them): clear space as a share of height, and minimum heights in px. */
export const LOGO_CLEAR_SPACE = 0.25;
export const LOGO_MIN_HEIGHT = { symbol: 16, lockup: 20 } as const;

/**
 * tokens.css `--fl-spring` as [progress, value] stops, for script-driven transitions. The CSS token
 * is the same curve written as `linear()`; stops without a position there are spaced evenly here.
 */
export const SPRING_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.0105, 0.009],
  [0.021, 0.035],
  [0.044, 0.141],
  [0.067, 0.281],
  [0.129, 0.723],
  [0.167, 0.938],
  [0.186, 1.017],
  [0.205, 1.077],
  [0.224, 1.121],
  [0.243, 1.149],
  [0.257, 1.159],
  [0.271, 1.163],
  [0.285, 1.161],
  [0.299, 1.154],
  [0.328, 1.129],
  [0.396, 1.051],
  [0.431, 1.017],
  [0.4705, 0.991],
  [0.51, 0.977],
  [0.538, 0.974],
  [0.571, 0.975],
  [0.698, 0.997],
  [0.769, 1.003],
  [1, 1],
];
