/** Reasons that only held a photo back for being hidden. Hidden photos now always import, as Locked. */
export const ICLOUD_HIDDEN_REVIEW_REASONS = ['source_hidden_requires_consent', 'hidden_match_requires_consent'];

export type ICloudReviewGroup = 'match' | 'live-photo' | 'stack' | 'details' | 'edits' | 'storage' | 'other';
export type ICloudReviewEffect = 'use-existing' | 'keep-current' | 'try-again';

export const ICLOUD_REVIEW_GROUP_REASONS: Record<Exclude<ICloudReviewGroup, 'other'>, string[]> = {
  match: [
    'multiple_content_matches',
    'saved_checksum_conflict',
    'mapped_asset_identity_changed',
    'reserved_import_content_match',
  ],
  'live-photo': [
    'live_photo_identity_conflict',
    'local_live_photo_override',
    'motion_visibility_override',
    'motion_has_manual_membership',
  ],
  stack: [
    'local_stack_membership_override',
    'manual_stack_conflict',
    'source_stack_removed',
    'source_stack_provenance_conflict',
    'shared_edit_primary_ambiguous',
  ],
  details: ['source_metadata_conflict', 'source_metadata_family_too_large'],
  edits: [
    'retained_edit_limit',
    'legacy_edit_order_unproven',
    'edit_member_evidence_unproven',
    'edit_member_evidence_changed',
    'edit_member_unavailable',
    'edit_bound_asset_required',
  ],
  storage: ['quota_exceeded'],
};

/** Accepting uses the matching photo already in the library; identical files are stored once. */
export const ICLOUD_REVIEW_USE_EXISTING = ['multiple_content_matches'];
/** Accepting tries the item again, because the answer can change (there may be room now). */
export const ICLOUD_REVIEW_TRY_AGAIN = ['quota_exceeded'];

export const isICloudReviewAccepted = (source: unknown, reason: string) => {
  const accepted = (source as { _sync?: { acceptedReasons?: unknown } } | null)?._sync?.acceptedReasons;
  return Array.isArray(accepted) && accepted.includes(reason);
};
