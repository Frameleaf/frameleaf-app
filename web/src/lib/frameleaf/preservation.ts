/**
 * Preservation packages (FL-74, `IMP-006`): the rules the preservation screens share.
 *
 * Ported from the design's "Originals & preservation" section (Import & protection) and its
 * "Preservation export" workflow (`CommandCenter.jsx`: Include → Verify → Manifest), with the
 * production behaviour the prototype only simulated: a real selection, a durable export job, a
 * package that is verified and restored through its own review. Pure functions only, so the
 * components stay thin and this file carries the tests.
 */
import {
  MediaOperationStatus,
  PreservationConflictField,
  PreservationPackageStatus,
  PreservationRestoreStatus,
  PreservationSupportCategory,
  PreservationSupportLevel,
  PreservationVerificationStatus,
  type MediaOperationDto,
  type PreservationPackageDto,
  type PreservationPreviewResponseDto,
  type PreservationRestoreDto,
  type PreservationScopeDto,
  type PreservationSupportDto,
  type SearchFilter,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import type { BulkAsset } from '$lib/frameleaf/bulk-actions';
import {
  MAX_PALETTE_TEXT,
  emptyPaletteCatalog,
  parseSearchInput,
  withAllText,
  type PaletteCatalog,
  type PaletteToken,
} from '$lib/frameleaf/search-palette';

/** The design's export stages, in order. */
export const EXPORT_STEPS = [
  'frameleaf_preservation_step_include',
  'frameleaf_preservation_step_verify',
  'frameleaf_preservation_step_manifest',
] as const;

/** The restoration stages: choose a package, let the server check it, review, restore. */
export const RESTORE_STEPS = [
  'frameleaf_preservation_restore_step_package',
  'frameleaf_preservation_restore_step_check',
  'frameleaf_preservation_restore_step_review',
  'frameleaf_preservation_restore_step_restore',
] as const;

/** The design's facts about what a package holds, shown before an export starts. */
export const MANIFEST_FACTS = [
  { labelKey: 'frameleaf_preservation_fact_originals', valueKey: 'frameleaf_preservation_fact_originals_value' },
  { labelKey: 'frameleaf_preservation_fact_metadata', valueKey: 'frameleaf_preservation_fact_metadata_value' },
  { labelKey: 'frameleaf_preservation_fact_organization', valueKey: 'frameleaf_preservation_fact_organization_value' },
  { labelKey: 'frameleaf_preservation_fact_editing', valueKey: 'frameleaf_preservation_fact_editing_value' },
] as const;

/**
 * What an export preserves. `search` is a typed search (the search palette's operators and free text)
 * compiled to the server's structured filter; `selection` is the items chosen in the library or in
 * search results, handed over by "Export for preservation…" in the selection bar.
 */
export type ScopeKind = 'library' | 'favorites' | 'dates' | 'albums' | 'search' | 'selection';

export type ScopeChoice = {
  kind: ScopeKind;
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, inclusive. */
  to: string;
  albumIds: string[];
  /** The typed search, as compiled by {@link searchScope}; null while empty or not expressible. */
  searchFilter: SearchFilter | null;
  /** The chosen items, already narrowed to the signed-in account's own where that is known. */
  assetIds: string[];
};

export const emptyScope = (): ScopeChoice => ({
  kind: 'library',
  from: '',
  to: '',
  albumIds: [],
  searchFilter: null,
  assetIds: [],
});

/** Items in one package; the server refuses a longer list outright (`PRESERVATION_MAX_ITEMS`). */
export const PRESERVATION_MAX_SELECTED = 100_000;

export type SearchScope = {
  /** The server filter, or null when there is nothing to search for or it cannot be expressed. */
  filter: SearchFilter | null;
  /** The operators that were understood, for the chips under the field. */
  tokens: PaletteToken[];
  /** Free text matched in file names, descriptions, recognized text and paths. */
  text: string;
  /** The free text was longer than a search takes and was cut. */
  truncated: boolean;
  /** The text and the operators together are more than one filter can say; nothing is searched. */
  tooComplex: boolean;
};

/**
 * A typed search as a preservation scope: the search palette's operators (`person:`, `tag:`, `year:`,
 * `camera:`, `text:` …) resolved against the account's own vocabulary, and any free text as the
 * palette's "All text" search. Smart (meaning-based) search ranks by similarity and has no filter the
 * server can freeze, so it is not a scope; its results can be selected and exported as a selection.
 */
export const searchScope = (input: string, catalog: PaletteCatalog = emptyPaletteCatalog()): SearchScope => {
  const parsed = parseSearchInput(input, catalog);
  const raw = parsed.text.replaceAll(/\s+/g, ' ').trim();
  const text = raw.slice(0, MAX_PALETTE_TEXT);
  const truncated = raw.length > text.length;
  let filter: SearchFilter | undefined = parsed.filter;
  if (text) {
    filter = withAllText(filter, text);
  }
  const tooComplex = !filter;
  const empty = !filter || Object.keys(filter).length === 0;
  return { filter: empty ? null : filter!, tokens: parsed.tokens, text, truncated, tooComplex };
};

/**
 * The selection bar's items as an export: the account's own, in the order chosen, without repeats.
 * An item known to belong to someone else — a partner's photo in the timeline, a shared album's — is
 * left out and counted, so the dialog can say so. An item whose owner the page has not loaded is
 * sent as chosen: the server keeps only the requester's own and the preview counts what remains.
 */
export const selectionForPreservation = (
  selectedIds: readonly string[],
  assets: readonly Pick<BulkAsset, 'id' | 'ownerId'>[],
  currentUserId: string | undefined,
): { assetIds: string[]; leftOut: number } => {
  const owners = new Map(assets.map((asset) => [asset.id, asset.ownerId]));
  const assetIds: string[] = [];
  const seen = new Set<string>();
  let leftOut = 0;
  for (const id of selectedIds) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const ownerId = owners.get(id);
    if (currentUserId && ownerId && ownerId !== currentUserId) {
      leftOut++;
      continue;
    }
    assetIds.push(id);
  }
  return { assetIds, leftOut };
};

/**
 * How many of the items sent the server did not count: in the trash, gone, not the requester's, or
 * Locked while the session has not unlocked (an ordinary session is never told about Locked items,
 * so they are indistinguishable from the rest here, and never named).
 */
export const selectionShortfall = (
  requested: number,
  preview: Pick<PreservationPreviewResponseDto, 'items' | 'lockedItems'>,
): number => Math.max(0, requested - preview.items - preview.lockedItems);

const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

const nextDay = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
};

/**
 * The selection as the server's structured filter. Dates are the days the photos were taken,
 * inclusive at both ends; albums are any of the chosen ones. Null when the choice is incomplete,
 * so the dialog never asks the server about half a selection.
 */
export const scopeToRequest = (choice: ScopeChoice): PreservationScopeDto | null => {
  switch (choice.kind) {
    case 'library': {
      return { filter: {} };
    }
    case 'favorites': {
      return { filter: { isFavorite: { eq: true } } };
    }
    case 'dates': {
      if ((!choice.from && !choice.to) || (choice.from && !isDay(choice.from)) || (choice.to && !isDay(choice.to))) {
        return null;
      }
      if (choice.from && choice.to && choice.from > choice.to) {
        return null;
      }
      const takenAt: NonNullable<SearchFilter['takenAt']> = {};
      if (choice.from) {
        takenAt.gte = `${choice.from}T00:00:00.000Z`;
      }
      if (choice.to) {
        takenAt.lt = nextDay(choice.to);
      }
      return { filter: { takenAt } };
    }
    case 'albums': {
      return choice.albumIds.length > 0 ? { filter: { albumIds: { any: [...choice.albumIds] } } } : null;
    }
    case 'search': {
      return choice.searchFilter ? { filter: choice.searchFilter } : null;
    }
    case 'selection': {
      return choice.assetIds.length > 0 && choice.assetIds.length <= PRESERVATION_MAX_SELECTED
        ? { assetIds: [...choice.assetIds] }
        : null;
    }
  }
};

/** A default package name from the selection, so a person can start without typing. */
export const defaultPackageName = (choice: ScopeChoice, today = new Date()): string => {
  const stamp = today.toISOString().slice(0, 10);
  switch (choice.kind) {
    case 'favorites': {
      return `Favorites ${stamp}`;
    }
    case 'dates': {
      return choice.from || choice.to ? `Photos ${choice.from || '…'} to ${choice.to || '…'}` : `Photos ${stamp}`;
    }
    case 'albums': {
      return `Albums ${stamp}`;
    }
    case 'search': {
      return `Search ${stamp}`;
    }
    case 'selection': {
      return `Selection ${stamp}`;
    }
    default: {
      return `Library ${stamp}`;
    }
  }
};

/** Media operation statuses that are still the server's problem. */
const ACTIVE = new Set<MediaOperationStatus>([
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
  MediaOperationStatus.Cancelling,
  MediaOperationStatus.Paused,
]);

export const isOperationActive = (operation: Pick<MediaOperationDto, 'status'> | null | undefined): boolean =>
  !!operation && ACTIVE.has(operation.status);

/** Poll again while any package or restoration has a job the server is still working on. */
export const pollDelay = (operations: Array<Pick<MediaOperationDto, 'status'> | null | undefined>): number | null => {
  const active = operations.filter((operation) => isOperationActive(operation));
  if (active.length === 0) {
    return null;
  }
  return active.every((operation) => operation!.status === MediaOperationStatus.Paused) ? 10_000 : 2500;
};

export type Tone = 'accent' | 'teal' | 'blue' | 'warning' | 'danger' | 'neutral';

/** A package's state as the owner should read it: its job first, then what the files say. */
export const packageState = (
  item: Pick<PreservationPackageDto, 'status' | 'operation' | 'verification'>,
): { key: Translations; tone: Tone } => {
  const operation = item.operation;
  if (operation && isOperationActive(operation)) {
    if (operation.status === MediaOperationStatus.Paused) {
      return { key: 'frameleaf_preservation_state_paused', tone: 'warning' };
    }
    return { key: `frameleaf_preservation_state_running_${operation.kind}` as Translations, tone: 'blue' };
  }
  if (operation?.status === MediaOperationStatus.Failed) {
    return { key: 'frameleaf_preservation_state_failed', tone: 'danger' };
  }
  switch (item.status) {
    case PreservationPackageStatus.Unreadable: {
      return { key: 'frameleaf_preservation_state_unreadable', tone: 'danger' };
    }
    case PreservationPackageStatus.Incomplete: {
      return { key: 'frameleaf_preservation_state_incomplete', tone: 'warning' };
    }
    case PreservationPackageStatus.Building: {
      return { key: 'frameleaf_preservation_state_building', tone: 'neutral' };
    }
    case PreservationPackageStatus.Removed: {
      return { key: 'frameleaf_preservation_state_removed', tone: 'neutral' };
    }
    case PreservationPackageStatus.Ready: {
      // Written in full: what it says next depends on its last verification, below.
      break;
    }
  }
  if (item.verification?.status === PreservationVerificationStatus.Verified) {
    return { key: 'frameleaf_preservation_state_verified', tone: 'teal' };
  }
  if (item.verification) {
    return { key: `frameleaf_preservation_state_${item.verification.status}` as Translations, tone: 'danger' };
  }
  // Written, never checked: a ready package is not a verified backup.
  return { key: 'frameleaf_preservation_state_unverified', tone: 'warning' };
};

export const restoreState = (
  item: Pick<PreservationRestoreDto, 'status' | 'operation'>,
): { key: Translations; tone: Tone } => {
  if (item.operation?.status === MediaOperationStatus.Paused) {
    return { key: 'frameleaf_preservation_state_paused', tone: 'warning' };
  }
  if (item.operation?.status === MediaOperationStatus.Failed && item.status !== PreservationRestoreStatus.Completed) {
    return { key: 'frameleaf_preservation_state_failed', tone: 'danger' };
  }
  switch (item.status) {
    case PreservationRestoreStatus.Reviewing: {
      return { key: 'frameleaf_preservation_restore_state_reviewing', tone: 'blue' };
    }
    case PreservationRestoreStatus.Ready: {
      return { key: 'frameleaf_preservation_restore_state_ready', tone: 'accent' };
    }
    case PreservationRestoreStatus.Restoring: {
      return { key: 'frameleaf_preservation_restore_state_restoring', tone: 'blue' };
    }
    case PreservationRestoreStatus.Unreadable: {
      return { key: 'frameleaf_preservation_state_unreadable', tone: 'danger' };
    }
    default: {
      return { key: 'frameleaf_preservation_restore_state_completed', tone: 'teal' };
    }
  }
};

/** Which step a restoration is on, so reopening it lands where the owner left off. */
export const restoreStep = (item: Pick<PreservationRestoreDto, 'status'> | null): number => {
  switch (item?.status) {
    case undefined: {
      return 0;
    }
    case PreservationRestoreStatus.Reviewing:
    case PreservationRestoreStatus.Unreadable: {
      return 1;
    }
    case PreservationRestoreStatus.Ready: {
      return 2;
    }
    default: {
      return 3;
    }
  }
};

/** The copy key for a reason the server gives, or a generic one for codes this client does not know. */
const KNOWN_REASONS = new Set([
  'asset_unavailable',
  'locked_excluded',
  'original_offline',
  'original_missing',
  'original_changed',
  'original_unreadable',
  'checksum_mismatch',
  'metadata_invalid',
  'metadata_changed',
  'metadata_missing',
  'asset_in_trash',
  'asset_hidden',
  'package_no_space',
  'package_entry_missing',
  'package_entry_changed',
  'package_changed_since_review',
  'package_manifest_invalid',
  'package_manifest_changed',
  'package_index_invalid',
  'package_index_changed',
  'package_counts_changed',
  'package_documents_changed',
  'package_documents_invalid',
  'package_not_zip',
  'package_too_large',
  'package_zip64',
  'package_spanned',
  'package_corrupt',
  'package_unavailable',
]);

export const reasonKey = (code: string | null | undefined): Translations | null => {
  if (!code) {
    return null;
  }
  return KNOWN_REASONS.has(code)
    ? (`frameleaf_preservation_reason_${code}` as Translations)
    : 'frameleaf_preservation_reason_other';
};

const KNOWN_FINDINGS = new Set([
  'generated_description_provenance',
  'generated_moments_provenance',
  'library_values_kept',
  'document_corrections_kept',
  'album_not_restored',
  'person_not_restored',
  'face_named_differently',
  'edit_recipe_waiting',
  'edit_recipe_not_applied',
  'edit_recipe_unsupported',
  'live_photo_incomplete',
  'live_photo_kept',
]);

export const findingKey = (finding: string): Translations =>
  KNOWN_FINDINGS.has(finding)
    ? (`frameleaf_preservation_finding_${finding}` as Translations)
    : 'frameleaf_preservation_finding_other';

export const supportLevelKey = (level: PreservationSupportLevel): Translations =>
  `frameleaf_preservation_support_${level.replaceAll('-', '_')}` as Translations;

export const supportCategoryKey = (category: PreservationSupportCategory): Translations =>
  `frameleaf_preservation_category_${category}` as Translations;

export const supportTone = (level: PreservationSupportLevel): Tone => {
  switch (level) {
    case PreservationSupportLevel.Restored: {
      return 'teal';
    }
    case PreservationSupportLevel.RestoredWhenEmpty: {
      return 'blue';
    }
    case PreservationSupportLevel.ProvenanceOnly: {
      return 'warning';
    }
    default: {
      return 'neutral';
    }
  }
};

/** The support list grouped by level, in the order a person should read it. */
export const groupSupport = (support: PreservationSupportDto[]) => {
  const order = [
    PreservationSupportLevel.Restored,
    PreservationSupportLevel.RestoredWhenEmpty,
    PreservationSupportLevel.ProvenanceOnly,
    PreservationSupportLevel.NotIncluded,
  ];
  return order
    .map((level) => ({
      level,
      categories: support.filter((item) => item.level === level).map((item) => item.category),
    }))
    .filter((group) => group.categories.length > 0);
};

export const conflictFieldKey = (field: PreservationConflictField): Translations =>
  `frameleaf_preservation_field_${field}` as Translations;

/** A stored byte count, which the API sends as a string so it never loses precision. */
export const asBytes = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Whether the free space measured where the package is written can hold it. */
export const hasRoomFor = (includedBytes: string, freeBytes: string | null): boolean | null => {
  const needed = asBytes(includedBytes);
  const free = asBytes(freeBytes);
  if (needed === null || free === null) {
    return null;
  }
  return free >= needed;
};

/** An idempotency key for one submit: a retried request finds the first package instead of a second. */
export const newRequestKey = (): string => {
  const native = globalThis.crypto?.randomUUID?.();
  if (native) {
    return native;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};
