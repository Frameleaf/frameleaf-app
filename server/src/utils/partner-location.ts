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
