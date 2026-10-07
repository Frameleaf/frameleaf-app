/** Shared recipe values without API framework imports; public DTOs re-export these identities. */
export const ASSET_DEVELOP_RECIPE_VERSION = 1;

export enum AssetDevelopPreset {
  Original = 'Original',
  Vivid = 'Vivid',
  Natural = 'Natural',
  Warm = 'Warm',
  Cool = 'Cool',
  Mono = 'Mono',
  Silvertone = 'Silvertone',
  Noir = 'Noir',
  Fade = 'Fade',
}

export enum AssetDevelopMaskKind {
  /** An ellipse: full effect inside, fading out across the feathered edge. */
  Radial = 'radial',
  /** A graduated filter: full effect at the start line, none at the end line. */
  Linear = 'linear',
  /** FL-233: painted strokes in original-image coordinates (`strokes`). */
  Brush = 'brush',
  /** FL-233: the main subject, from a stored mask bitmap (`artifact`). */
  Subject = 'subject',
  /** FL-233: the sky, from a stored mask bitmap (`artifact`). */
  Sky = 'sky',
  /** FL-233: everything behind the subject, from a stored mask bitmap (`artifact`). */
  Background = 'background',
}

export enum AssetDevelopCleanupMethod {
  /** Copy from `source`, blended to the colour around the area. */
  Heal = 'heal',
  /** Copy from `source` unchanged. */
  Clone = 'clone',
  /** Replace with a generated fill (`fill`, a stored artifact). */
  Remove = 'remove',
  /** Mosaic of `blockSize` blocks. */
  Pixelate = 'pixelate',
}

export const ASSET_DEVELOP_BITMAP_MASK_KINDS: readonly AssetDevelopMaskKind[] = [
  AssetDevelopMaskKind.Subject,
  AssetDevelopMaskKind.Sky,
  AssetDevelopMaskKind.Background,
];

export const ASSET_DEVELOP_MAX_MASKS = 8;

export const ASSET_DEVELOP_MAX_STROKES = 64;

export const ASSET_DEVELOP_MAX_STROKE_POINTS = 512;

export const ASSET_DEVELOP_MAX_CLEANUP = 32;

export const ASSET_DEVELOP_MAX_RECIPE_POINTS = 4096;
