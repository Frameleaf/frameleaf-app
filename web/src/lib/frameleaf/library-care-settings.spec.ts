import { describe, expect, it } from 'vitest';
import { LIBRARY_CARE_SECTION_TOGGLES, LIBRARY_CARE_TOGGLES } from '$lib/frameleaf/library-care-settings';
import en from '../../../../i18n/en.json';

describe('Library care settings (FL-69, settings-catalog.mjs:905-977)', () => {
  it('lists each page’s toggles in the template’s order', () => {
    expect(LIBRARY_CARE_SECTION_TOGGLES).toEqual({
      'integrity-checks': ['healthScan', 'checksumScan', 'integrityAudit'],
      repair: ['livePhotoRepair', 'rawRecovery', 'duplicateReview'],
      'enrichment-care': ['incrementalEnrichment', 'manualMetadata'],
    });
  });

  it('uses the template’s words for every toggle', () => {
    const words = Object.fromEntries(
      Object.entries(LIBRARY_CARE_TOGGLES).map(([key, { titleKey, descriptionKey }]) => [
        key,
        [
          (en as unknown as Record<string, string>)[titleKey],
          (en as unknown as Record<string, string>)[descriptionKey],
        ],
      ]),
    );
    expect(words).toEqual({
      healthScan: ['Schedule incremental health scans', 'Resume from recorded checkpoints after interruption.'],
      checksumScan: ['Verify original checksums', 'Checksums help prove preservation; existence alone does not.'],
      integrityAudit: ['Audit database and file references', 'Include physical-deduplication owners and references.'],
      livePhotoRepair: ['Suggest Live Photo relinking', 'Ambiguous pairs remain in review.'],
      rawRecovery: ['Suggest recoverable RAW sources', 'Prefer original provenance and verified dimensions.'],
      duplicateReview: [
        'Group near-duplicates for review',
        'Keeper suggestions use quality, resolution, and format; deletion stays explicit.',
      ],
      incrementalEnrichment: [
        'Reprocess only affected outputs',
        'Changing an identity should not rerun unrelated media jobs.',
      ],
      manualMetadata: [
        'Preserve manual metadata on rerun',
        'Rule provenance and model versions identify replaceable generated output.',
      ],
    });
  });
});
