import type { AuthDto } from 'src/dtos/auth.dto.js';

/**
 * Location in files that leave the server. FL-326 (owner decision 2026-10-03): locations are always
 * shared with partners, who receive their own copies, so the per-partner hiding of FL-54/FL-146 is gone.
 * What remains is the shared-link rule: a link that hides metadata never hands out a location.
 */

export type LocationFields = {
  latitude?: number | null;
  longitude?: number | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
};

/** Returns a copy of `exif` with every location field cleared. */
export const hideLocation = <T extends LocationFields>(exif: T): T => ({
  ...exif,
  latitude: null,
  longitude: null,
  city: null,
  state: null,
  country: null,
});

/**
 * What may happen to the metadata embedded in an original (or any file served as-is) when it leaves the
 * server: the file's own EXIF/XMP/QuickTime location travels with its bytes.
 */
export enum OriginalLocationPolicy {
  /** send the bytes unchanged */
  Serve = 'serve',
  /** send a copy without its embedded location, or nothing when that copy cannot be guaranteed */
  RemoveLocation = 'remove-location',
  /** do not send the file at all */
  Refuse = 'refuse',
}

/** `download` hands the file over for keeping (original, archive); `playback` streams it for viewing. */
export type OriginalPurpose = 'download' | 'playback';

export const getOriginalLocationPolicy = ({
  auth,
  purpose,
}: {
  auth: AuthDto;
  purpose: OriginalPurpose;
}): OriginalLocationPolicy => {
  if (auth.sharedLink && !auth.sharedLink.showExif) {
    // AL-27: a link that hides metadata never offers downloads (the file carries it all); playback of
    // an original video stays possible but without its location
    return purpose === 'download' ? OriginalLocationPolicy.Refuse : OriginalLocationPolicy.RemoveLocation;
  }
  return OriginalLocationPolicy.Serve;
};

export type OriginalAsset = { id: string; ownerId: string };

/** The policy for each of these files; the same for every file of one request. */
export const getOriginalLocationPolicies = ({
  auth,
  purpose,
}: {
  auth: AuthDto;
  assets: Iterable<OriginalAsset>;
  purpose: OriginalPurpose;
}): ((asset: OriginalAsset) => OriginalLocationPolicy) => {
  const policy = getOriginalLocationPolicy({ auth, purpose });
  return () => policy;
};
