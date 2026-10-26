/**
 * FL-516, after the prototype's `SpacePicker` (`settings-v2/cloud/People.jsx`): how much space a person
 * has, chosen from a short list (No limit, 50 GB, 200 GB, 500 GB, 1 TB) with "Other…" for an exact
 * amount. Never a bare number where blank means no limit. The server keeps bytes per account and
 * decimal GB (D5) for "Space for new people".
 */
export const SPACE_SIZES_GB = [50, 200, 500, 1000] as const;
export type SpaceChoice = 'none' | `${(typeof SPACE_SIZES_GB)[number]}` | 'other';

const GB = 1_000_000_000;

/** The choice a number of GB is (null is no limit). */
export const spaceChoiceOf = (gb: number | null): SpaceChoice =>
  gb === null ? 'none' : (SPACE_SIZES_GB as readonly number[]).includes(gb) ? (String(gb) as SpaceChoice) : 'other';

export const gbOfBytes = (bytes: number | null | undefined) =>
  bytes === null || bytes === undefined ? null : Math.round((bytes / GB) * 100) / 100;
export const bytesOfGb = (gb: number | null) => (gb === null ? null : Math.round(gb * GB));

/** A size the way a phone or a drive box says it: "200 GB", "1 TB", "500 MB". */
export const spaceWords = (gb: number) =>
  gb >= 1000 ? `${Math.round(gb / 100) / 10} TB` : gb < 1 ? `${Math.round(gb * 1000)} MB` : `${Math.round(gb)} GB`;
