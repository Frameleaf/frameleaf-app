import type { AuthDto } from 'src/dtos/auth.dto.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';

/**
 * Per-partner location sharing (FL-54). A sharer may turn `partner.shareLocation` off for one recipient;
 * from then on every read path that hands the sharer's assets to that recipient must omit GPS
 * coordinates and reverse-geocoded place names. The sharer's own reads and every other user's access
 * are untouched, so the policy is keyed on the viewing user and the asset owner only.
 */

export type LocationFields = {
  latitude?: number | null;
  longitude?: number | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
};

export type PartnerLocationOptions = {
  /** the viewing user */
  userId: string;
  repository: PartnerRepository;
};

/** Owners who share their library with `userId` but hide their asset locations from them. */
export const getLocationHiddenPartnerIds = async ({
  userId,
  repository,
}: PartnerLocationOptions): Promise<Set<string>> => {
  const hidden = new Set<string>();
  const partners = await repository.getAll(userId);
  for (const partner of partners) {
    // a user never hides locations from themselves, whatever a stray self-partner row says
    if (partner.sharedWithId === userId && partner.sharedById !== userId && !partner.shareLocation) {
      hidden.add(partner.sharedById);
    }
  }

  return hidden;
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

export const hideAssetLocation = <T extends { exifInfo?: LocationFields | null }>(asset: T): T =>
  asset.exifInfo ? { ...asset, exifInfo: hideLocation(asset.exifInfo) } : asset;

/**
 * Applies the location policy to assets the viewer is already authorized to see. Skips the partner
 * lookup entirely when every asset with EXIF belongs to the viewer, which is the common case.
 */
export const applyPartnerLocationPolicy = async <T extends { ownerId?: string; exifInfo?: LocationFields | null }>(
  assets: T[],
  { userId, repository }: PartnerLocationOptions,
): Promise<T[]> => {
  if (assets.every((asset) => !asset.exifInfo || asset.ownerId === userId)) {
    return assets;
  }

  const hidden = await getLocationHiddenPartnerIds({ userId, repository });
  if (hidden.size === 0) {
    return assets;
  }

  return assets.map((asset) => (asset.ownerId && hidden.has(asset.ownerId) ? hideAssetLocation(asset) : asset));
};

/**
 * FL-54: what may happen to the metadata embedded in an original (or any file served as-is) when it
 * leaves the server. The database fields above are cleared per read; the file's own EXIF/XMP/QuickTime
 * location travels with its bytes, so the serving paths need a decision of their own.
 */
export enum OriginalLocationPolicy {
  /** send the bytes unchanged: the owner, a partner who may see locations, or a link that shows metadata */
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
  ownerId,
  locationHiddenOwnerIds,
  purpose,
}: {
  auth: AuthDto;
  ownerId: string;
  locationHiddenOwnerIds: ReadonlySet<string>;
  purpose: OriginalPurpose;
}): OriginalLocationPolicy => {
  if (auth.sharedLink) {
    if (auth.sharedLink.showExif) {
      return OriginalLocationPolicy.Serve;
    }

    // AL-27: a link that hides metadata never offers downloads (the file carries it all); playback of
    // an original video stays possible but without its location
    return purpose === 'download' ? OriginalLocationPolicy.Refuse : OriginalLocationPolicy.RemoveLocation;
  }

  if (ownerId === auth.user.id) {
    return OriginalLocationPolicy.Serve;
  }

  return locationHiddenOwnerIds.has(ownerId) ? OriginalLocationPolicy.RemoveLocation : OriginalLocationPolicy.Serve;
};

/**
 * Resolves the policy for every owner in `ownerIds`. The partner lookup only runs when a signed-in user
 * reads someone else's files, so the owner's own downloads cost nothing extra.
 */
export const getOriginalLocationPolicies = async ({
  auth,
  ownerIds,
  purpose,
  repository,
}: {
  auth: AuthDto;
  ownerIds: Iterable<string>;
  purpose: OriginalPurpose;
  repository: PartnerRepository;
}): Promise<(ownerId: string) => OriginalLocationPolicy> => {
  const needsLookup = !auth.sharedLink && [...ownerIds].some((ownerId) => ownerId !== auth.user.id);
  const locationHiddenOwnerIds = needsLookup
    ? await getLocationHiddenPartnerIds({ userId: auth.user.id, repository })
    : new Set<string>();

  return (ownerId) => getOriginalLocationPolicy({ auth, ownerId, locationHiddenOwnerIds, purpose });
};
