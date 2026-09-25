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
  if (auth.sharedLink && !auth.sharedLink.showExif) {
    // AL-27: a link that hides metadata never offers downloads (the file carries it all); playback of
    // an original video stays possible but without its location
    return purpose === 'download' ? OriginalLocationPolicy.Refuse : OriginalLocationPolicy.RemoveLocation;
  }

  // A link shows at most what its creator may see: a partner the owner hides locations from must not get
  // them back by linking the asset, or an album holding it, and opening the link (FL-54 review B1).
  const viewerId = getOriginalViewerId(auth);
  if (ownerId === viewerId) {
    return OriginalLocationPolicy.Serve;
  }

  return locationHiddenOwnerIds.has(ownerId) ? OriginalLocationPolicy.RemoveLocation : OriginalLocationPolicy.Serve;
};

/** whose partner settings apply: the signed-in user, or for a shared link the user who created it */
const getOriginalViewerId = (auth: AuthDto) => auth.sharedLink?.userId ?? auth.user.id;

/**
 * Resolves the policy for every owner in `ownerIds`. The partner lookup only runs when someone else's files
 * are read (by a signed-in user or through a link), so the owner's own downloads cost nothing extra.
 */
export type OriginalAsset = { id: string; ownerId: string };

export const getOriginalLocationPolicies = async ({
  auth,
  assets,
  purpose,
  repository,
}: {
  auth: AuthDto;
  assets: Iterable<OriginalAsset>;
  purpose: OriginalPurpose;
  repository: PartnerRepository;
}): Promise<(asset: OriginalAsset) => OriginalLocationPolicy> => {
  const viewerId = getOriginalViewerId(auth);
  const hidesAllMetadata = !!auth.sharedLink && !auth.sharedLink.showExif;
  const others = hidesAllMetadata ? [] : [...assets].filter(({ ownerId }) => ownerId !== viewerId);
  const locationHiddenOwnerIds =
    others.length > 0 ? await getLocationHiddenPartnerIds({ userId: viewerId, repository }) : new Set<string>();

  // owner default (privacy first): an item reached through an album whose owner its owner hides locations
  // from is location-hidden for everyone looking through that album
  const candidates = others.filter(({ ownerId }) => !locationHiddenOwnerIds.has(ownerId)).map(({ id }) => id);
  const hiddenThroughAlbums =
    candidates.length > 0 ? await repository.getLocationHiddenThroughAlbums(viewerId, candidates) : new Set<string>();

  return ({ id, ownerId }) => {
    const policy = getOriginalLocationPolicy({ auth, ownerId, locationHiddenOwnerIds, purpose });
    return policy === OriginalLocationPolicy.Serve && hiddenThroughAlbums.has(id)
      ? OriginalLocationPolicy.RemoveLocation
      : policy;
  };
};

/**
 * Owners whose locations are hidden in a view: those who hide them from the viewer and, when the view is
 * one or more albums, those who hide them from any of those albums' owners (owner default, privacy
 * first). The viewer's own items are never hidden from them.
 */
export const getLocationHiddenOwnerIdsForView = async ({
  viewerId,
  albumIds = [],
  repository,
}: {
  viewerId: string;
  albumIds?: string[];
  repository: PartnerRepository;
}): Promise<Set<string>> => {
  const [hidden, throughAlbums] = await Promise.all([
    getLocationHiddenPartnerIds({ userId: viewerId, repository }),
    albumIds.length > 0
      ? repository.getLocationHiddenOwnerIdsForAlbums(albumIds, viewerId)
      : Promise.resolve([] as string[]),
  ]);
  for (const ownerId of throughAlbums) {
    if (ownerId !== viewerId) {
      hidden.add(ownerId);
    }
  }
  return hidden;
};

/** Clears the location of assets the viewer reaches only through an album whose owner is hidden from. */
export const applyAlbumLocationPolicy = async <
  T extends { id: string; ownerId?: string; exifInfo?: LocationFields | null },
>(
  assets: T[],
  { userId, repository }: PartnerLocationOptions,
): Promise<T[]> => {
  const candidates = assets.filter((asset) => asset.exifInfo && asset.ownerId && asset.ownerId !== userId);
  if (candidates.length === 0) {
    return assets;
  }

  const hidden = await repository.getLocationHiddenThroughAlbums(
    userId,
    candidates.map(({ id }) => id),
  );
  return hidden.size === 0 ? assets : assets.map((asset) => (hidden.has(asset.id) ? hideAssetLocation(asset) : asset));
};
