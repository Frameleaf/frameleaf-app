/**
 * Reasons that no longer hold a photo back, so the next run imports it. Hidden photos always import, as Locked
 * (owner 2026-11-22). A file already in the library more than once links to the visible copy (owner 2026-11-23).
 */
export const ICLOUD_RELEASED_REVIEW_REASONS = [
  'source_hidden_requires_consent',
  'hidden_match_requires_consent',
  'multiple_content_matches',
];

export type ICloudReviewGroup = 'match' | 'live-photo' | 'stack' | 'details' | 'edits' | 'storage' | 'other';
export type ICloudReviewEffect = 'use-existing' | 'keep-current' | 'try-again';

// ponytail: 'match' and 'use-existing' stay in the API for older clients; nothing is put in them since FL-1749.
export const ICLOUD_REVIEW_GROUP_REASONS: Record<Exclude<ICloudReviewGroup, 'other' | 'match'>, string[]> = {
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

/**
 * Accepting keeps the library version for these groups. Storage full and every other reason copy the photo from
 * iCloud again instead, because the answer can change (there may be room now). Owner-approved mock, 2026-11-23.
 */
export const ICLOUD_REVIEW_KEEP_GROUPS = ['live-photo', 'stack', 'details', 'edits'] as const;

/** What differs between the iCloud copy and the library copy, shown side by side in review. */
export type ICloudReviewDifference = {
  field: 'date-taken' | 'favorite' | 'live-video' | 'edits';
  icloud: string | null;
  library: string | null;
};
