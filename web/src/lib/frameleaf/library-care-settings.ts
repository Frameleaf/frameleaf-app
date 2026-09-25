import type { Translations } from 'svelte-i18n';

/**
 * Library care's settings toggles (FL-69), exactly as the template lists them in
 * settings-catalog.mjs:905-977: Media health & integrity, Repair queues and Enrichment completeness.
 * Each is a real `libraryCare` system setting the server acts on:
 *
 * - `healthScan` schedules every account's incremental, checkpointed health scan.
 * - `checksumScan` makes health scans prove each original against its recorded checksum.
 * - `integrityAudit` runs the scheduled missing-file and untracked-file reference checks.
 * - `livePhotoRepair`, `rawRecovery` and `duplicateReview` decide whether Live Photo pairs, RAW
 *   originals in searches for originals, and near-duplicate groups are suggested at all.
 * - `incrementalEnrichment` makes a full description rerun redo only affected results.
 * - `manualMetadata` makes a description rerun keep what a person wrote.
 */
export type LibraryCareToggleKey =
  | 'healthScan'
  | 'checksumScan'
  | 'integrityAudit'
  | 'livePhotoRepair'
  | 'rawRecovery'
  | 'duplicateReview'
  | 'incrementalEnrichment'
  | 'manualMetadata';

export type LibraryCareSection = 'integrity-checks' | 'repair' | 'enrichment-care';

export const LIBRARY_CARE_TOGGLES: Readonly<
  Record<LibraryCareToggleKey, { titleKey: Translations; descriptionKey: Translations }>
> = Object.freeze({
  healthScan: { titleKey: 'frameleaf_care_health_scan', descriptionKey: 'frameleaf_care_health_scan_description' },
  checksumScan: {
    titleKey: 'frameleaf_care_checksum_scan',
    descriptionKey: 'frameleaf_care_checksum_scan_description',
  },
  integrityAudit: {
    titleKey: 'frameleaf_care_integrity_audit',
    descriptionKey: 'frameleaf_care_integrity_audit_description',
  },
  livePhotoRepair: {
    titleKey: 'frameleaf_care_live_photo_repair',
    descriptionKey: 'frameleaf_care_live_photo_repair_description',
  },
  rawRecovery: { titleKey: 'frameleaf_care_raw_recovery', descriptionKey: 'frameleaf_care_raw_recovery_description' },
  duplicateReview: {
    titleKey: 'frameleaf_care_duplicate_review',
    descriptionKey: 'frameleaf_care_duplicate_review_description',
  },
  incrementalEnrichment: {
    titleKey: 'frameleaf_care_incremental_enrichment',
    descriptionKey: 'frameleaf_care_incremental_enrichment_description',
  },
  manualMetadata: {
    titleKey: 'frameleaf_care_manual_metadata',
    descriptionKey: 'frameleaf_care_manual_metadata_description',
  },
});

/** Which toggles each Library care page shows, in the template's order. */
export const LIBRARY_CARE_SECTION_TOGGLES: Readonly<Record<LibraryCareSection, readonly LibraryCareToggleKey[]>> =
  Object.freeze({
    'integrity-checks': ['healthScan', 'checksumScan', 'integrityAudit'],
    repair: ['livePhotoRepair', 'rawRecovery', 'duplicateReview'],
    'enrichment-care': ['incrementalEnrichment', 'manualMetadata'],
  });
