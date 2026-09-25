/**
 * The Frameleaf viewer information panel's pure logic (FL-36).
 *
 * Ported from the approved design template `design/frameleaf/template/src/media-viewer.mjs`
 * (`descriptionReview`, `sensitivityReview`, `osmLink`, `locationLabel`, `validCoordinate`)
 * and the `DetailsSection` rows in `MediaViewer.jsx`, adapted from the prototype's sample
 * shape to the production `AssetResponseDto` and `AssetImageEnrichmentResponseDto`.
 *
 * Nothing here talks to the server or renders markup: it decides *what the panel says* about
 * an asset so the decisions can be tested without mounting the viewer. Every action the panel
 * offers on top of these answers goes through an existing endpoint — `updateAsset` for the
 * inline edits and `updateAssetImageEnrichment` for the enrichment card.
 */
import {
  AssetTypeEnum,
  type AssetImageEnrichmentResponseDto,
  type AssetResponseDto,
  type ExifResponseDto,
} from '@immich/sdk';
import {
  cameraLabel,
  dimensionsLabel,
  exposureParts,
  formatDuration,
  formatFileSize,
  megapixels,
} from '$lib/frameleaf/viewer-headline';

/* ---------------------------------------------------------------- coordinates */

/** The prototype's guard: a finite number inside the axis limit, or null. */
export const validCoordinate = (value: unknown, limit: number): number | null => {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    // `Number(null)` and `Number('')` are 0, which would pass as a real coordinate.
    return null;
  }
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
};

export interface Coordinates {
  lat: number;
  lng: number;
}

export const coordinatesOf = (exif: ExifResponseDto | undefined): Coordinates | null => {
  const lat = validCoordinate(exif?.latitude, 90);
  const lng = validCoordinate(exif?.longitude, 180);
  // 0,0 is the null island EXIF writers emit when they have nothing; treat it as no fix.
  if (lat === null || lng === null || (lat === 0 && lng === 0)) {
    return null;
  }
  return { lat, lng };
};

export const coordinateLabel = (point: Coordinates | null): string | null =>
  point ? `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}` : null;

/** The OpenStreetMap deep link the design puts under the location row. */
export const osmLink = (point: Coordinates | null): string | null =>
  point
    ? `https://www.openstreetmap.org/?mlat=${point.lat}&mlon=${point.lng}&zoom=13#map=15/${point.lat}/${point.lng}`
    : null;

/** City, state and country as one line, skipping the parts the asset does not carry. */
export const locationLabel = (exif: ExifResponseDto | undefined): string | null =>
  [exif?.city, exif?.state, exif?.country].filter(Boolean).join(', ') || null;

/* ---------------------------------------------------------------- description */

export type DescriptionSource = 'manual' | 'generated' | 'none';

export interface DescriptionReview {
  /** Where the description currently stored on the asset came from. */
  source: DescriptionSource;
  /** The enrichment run's own state: missing, success, failed or skipped. */
  status: string;
  modelName: string | null;
  /**
   * The model's confidence in its description as a whole percentage, only when the processing
   * destination reported one (`ImageDescriptionEnrichment.confidence` is nullable); never guessed.
   */
  confidencePercent: number | null;
  /** The generated text, when a run produced one and it is not already the stored value. */
  suggestion: string | null;
  /** A generated description exists and differs from what is stored, so it can be accepted. */
  canAccept: boolean;
  /**
   * The server applied a generated description to this asset, so `clear-generated-description`
   * has something to undo. An owner-written description is cleared in the editor instead —
   * the panel never routes a manual edit through an enrichment action.
   */
  canClear: boolean;
  error: string | null;
}

const text = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim() : '');

export function descriptionReview(
  asset: AssetResponseDto,
  enrichment: AssetImageEnrichmentResponseDto | undefined,
): DescriptionReview | null {
  const review = enrichment?.description;
  if (!review) {
    return null;
  }

  const stored = text(asset.exifInfo?.description);
  const generated = text(review.description);
  const confidence = review.confidence;
  const appliedGenerated = review.appliedDescription && stored.length > 0 && (!generated || stored === generated);

  return {
    source: stored.length === 0 ? 'none' : appliedGenerated ? 'generated' : 'manual',
    status: review.status,
    modelName: review.modelName ?? null,
    confidencePercent:
      typeof confidence === 'number' && Number.isFinite(confidence)
        ? Math.round(Math.min(1, Math.max(0, confidence)) * 100)
        : null,
    suggestion: generated && generated !== stored ? generated : null,
    canAccept: generated.length > 0 && generated !== stored,
    canClear: review.appliedDescription,
    error: review.error ?? null,
  };
}

/* ---------------------------------------------------------------- sensitivity */

export type SensitivityState = 'missing' | 'needs-review' | 'overridden' | 'reviewed';

export interface SensitivityReview {
  /** The model's confidence, 0 to 1, or null when it never ran. */
  score: number | null;
  /** `score` as a whole percentage, for display. */
  scorePercent: number | null;
  /** What the model concluded, when it ran. */
  predicted: boolean | null;
  /** What the asset is marked as right now, including any human decision. */
  marked: boolean;
  /** Whether a person has recorded a decision on this asset. */
  reviewed: boolean;
  state: SensitivityState;
  /** Status colour. Never the only carrier of meaning: the state has its own label. */
  tone: 'warning' | 'blue' | 'teal' | 'neutral';
  error: string | null;
}

const TONES: Record<SensitivityState, SensitivityReview['tone']> = {
  'needs-review': 'warning',
  overridden: 'blue',
  reviewed: 'teal',
  missing: 'neutral',
};

export function sensitivityReview(enrichment: AssetImageEnrichmentResponseDto | undefined): SensitivityReview | null {
  const detection = enrichment?.nsfwDetection;
  if (!detection) {
    return null;
  }

  const raw = detection.score;
  const score = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : null;
  const predicted = typeof detection.isNsfw === 'boolean' ? detection.isNsfw : score === null ? null : score >= 0.5;
  const marked = detection.effectiveIsNsfw;
  const reviewed = !!detection.review;

  const state: SensitivityState =
    detection.status !== 'success' && !reviewed
      ? 'missing'
      : // A human decision that contradicts the model, or a mark the model did not ask for.
        predicted !== null && predicted !== marked
        ? 'overridden'
        : reviewed
          ? 'reviewed'
          : predicted === true
            ? 'needs-review'
            : 'reviewed';

  return {
    score,
    scorePercent: score === null ? null : Math.round(score * 100),
    predicted,
    marked,
    reviewed,
    state,
    tone: TONES[state],
    error: detection.error ?? null,
  };
}

/* ---------------------------------------------------------------- detail rows */

export type InfoDetailRowId = 'filename' | 'path' | 'image' | 'camera' | 'lens' | 'exposure' | 'video' | 'checksum';

export interface InfoDetailRow {
  id: InfoDetailRowId;
  value: string;
}

/**
 * The design's Details list: file, path, image, camera, lens, exposure, video and checksum,
 * in that order, with every row the asset cannot fill dropped. The path and the checksum are
 * only shown to the owner — they are storage facts about someone else's library otherwise.
 */
export function infoDetailRows(asset: AssetResponseDto, { isOwner }: { isOwner: boolean }): InfoDetailRow[] {
  const exif = asset.exifInfo;
  const isVideo = asset.type === AssetTypeEnum.Video;
  const image = [
    dimensionsLabel(asset),
    isVideo ? null : megapixels(exif?.exifImageWidth ?? asset.width, exif?.exifImageHeight ?? asset.height),
    formatFileSize(exif?.fileSizeInByte),
  ]
    .filter(Boolean)
    .join(' · ');
  const exposure = isVideo ? '' : exposureParts(exif).join(' · ');
  const video = isVideo ? formatDuration(asset.duration) : null;

  const rows: (InfoDetailRow | null)[] = [
    asset.originalFileName ? { id: 'filename', value: asset.originalFileName } : null,
    isOwner && asset.originalPath ? { id: 'path', value: asset.originalPath } : null,
    image ? { id: 'image', value: image } : null,
    cameraLabel(exif) ? { id: 'camera', value: cameraLabel(exif) as string } : null,
    exif?.lensModel ? { id: 'lens', value: exif.lensModel } : null,
    exposure ? { id: 'exposure', value: exposure } : null,
    video ? { id: 'video', value: video } : null,
    isOwner && asset.checksum ? { id: 'checksum', value: asset.checksum } : null,
  ];

  return rows.filter((row): row is InfoDetailRow => row !== null);
}

/* ---------------------------------------------------------------- tags */

export interface TagSuggestion {
  /** The tag's id, or for `create` the trimmed text to create a tag from. */
  id: string;
  /** The tag's full path, or the text a new tag would take. */
  label: string;
  create: boolean;
}

/**
 * The "Add a tag" suggestions (`TagsSection`, MediaViewer.jsx:3190-3233): up to eight of the account's
 * tags the item does not have yet that contain the typed text, then "Create …" when the text names no
 * tag at all. Tags are matched on their full path (`value`), as the tag browser names them.
 */
export function tagSuggestions(
  tags: readonly { id: string; value: string }[],
  currentIds: readonly string[],
  query: string,
  limit = 8,
): TagSuggestion[] {
  const text = query.trim();
  const term = text.toLocaleLowerCase();
  const current = new Set(currentIds);
  const options: TagSuggestion[] = tags
    .filter((tag) => !current.has(tag.id))
    .filter((tag) => !term || tag.value.toLocaleLowerCase().includes(term))
    .slice(0, limit)
    .map((tag) => ({ id: tag.id, label: tag.value, create: false }));
  const exists = tags.some((tag) => tag.value.toLocaleLowerCase() === term);
  if (term && !exists) {
    options.push({ id: text, label: text, create: true });
  }
  return options;
}

/* ---------------------------------------------------------------- owner */

/**
 * The owner line under the albums (`ownerLine`, media-viewer.mjs:538-552): "Shared by …" for an item
 * seen through a shared album, "Owned by …" for someone else's item, and nothing for one's own.
 */
export function ownerLine(
  asset: Pick<AssetResponseDto, 'ownerId' | 'owner'>,
  currentUserId: string | undefined,
  { sharedAlbum = false }: { sharedAlbum?: boolean } = {},
): { kind: 'shared' | 'owned'; name: string } | null {
  const name = asset.owner?.name;
  if (!name || !currentUserId || asset.ownerId === currentUserId) {
    return null;
  }
  return { kind: sharedAlbum ? 'shared' : 'owned', name };
}
