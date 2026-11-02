import { z } from 'zod';
import { ImportManifest } from 'src/library-import/manifest.js';
import { PhotoprismRow } from 'src/library-import/photoprism.js';

const text = z.string();
const flag = z.union([z.literal(0n), z.literal(1n)]).transform((value) => value === 1n);
const timestamp = text.transform((value) => value.replace(' ', 'T')).pipe(z.iso.datetime({ offset: true }));
const captureTimestamp = timestamp
  .nullable()
  .transform((value) =>
    value === null || /^0001-01-01T00:00:00(?:\.0+)?(?:Z|\+00:00)$/u.test(value) ? undefined : value,
  );
const photoSchema = z.object({
  id: z.bigint(),
  photo_uid: text.min(1),
  created_by: text.nullable(),
  photo_title: text,
  title_src: text,
  photo_caption: text,
  caption_src: text,
  taken_at: captureTimestamp,
  taken_at_local: captureTimestamp,
  taken_src: text,
  time_zone: text.min(1),
  photo_lat: z.number().min(-90).max(90),
  photo_lng: z.number().min(-180).max(180),
  place_src: text,
  photo_private: flag,
  photo_favorite: flag,
  photo_quality: z.bigint(),
  photo_stack: z.union([z.literal(-1n), z.literal(0n), z.literal(1n)]),
  deleted_at: timestamp.nullable(),
});

/** Normalize database values only; ownership, permission mapping and original-byte verification remain separate gates. */
export const normalizePhotoprismPhoto = (row: PhotoprismRow, details?: PhotoprismRow) => {
  let photo: z.infer<typeof photoSchema>;
  let tags: string[] | undefined;
  let timeZone: string | undefined;
  try {
    photo = photoSchema.parse(row);
    if (details)
      tags = text
        .parse(details.keywords)
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
    const offset = /^UTC([+-])([1-9]|1[0-2])$/u.exec(photo.time_zone);
    // IANA Etc/GMT names invert the sign of PhotoPrism's normalized UTC offsets.
    timeZone =
      photo.time_zone === 'Local'
        ? undefined
        : offset
          ? `Etc/GMT${offset[1] === '+' ? '-' : '+'}${offset[2]}`
          : photo.time_zone;
    if (timeZone) new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    throw new Error('PhotoPrism source refused: PHOTOPRISM_METADATA_INVALID');
  }
  if (details && details.photo_id !== photo.id) {
    throw new Error('PhotoPrism source refused: PHOTOPRISM_DETAILS_MISMATCH');
  }
  const review: string[] = [];
  if (photo.time_zone === 'Local') review.push('LOCAL_TIME_ZONE_UNRESOLVED');
  if (!details) review.push('PHOTO_DETAILS_MISSING');
  if (!photo.taken_at || !photo.taken_at_local) review.push('CAPTURE_TIME_UNKNOWN');
  // PhotoPrism uses (0,0) as absent coordinates, and quality is a computed score, not a user rating.
  const hasLocation = photo.photo_lat !== 0 || photo.photo_lng !== 0;
  const metadata: ImportManifest['assets'][number]['metadata'] = {
    title: photo.photo_title,
    description: photo.photo_caption,
    takenAt: photo.taken_at,
    timeZone,
    latitude: hasLocation ? photo.photo_lat : undefined,
    longitude: hasLocation ? photo.photo_lng : undefined,
    favorite: photo.photo_favorite,
    tags,
  };
  return {
    id: photo.photo_uid,
    sourceId: photo.id.toString(),
    createdBy: photo.created_by || undefined,
    metadata,
    // TakenAtLocal is a wall clock encoded in Go's UTC location, not another capture instant.
    localDateTime: photo.taken_at_local?.replace(/(?:Z|[+-]\d{2}:\d{2})$/u, ''),
    state: {
      private: photo.photo_private,
      archived: photo.deleted_at !== null && photo.photo_quality >= 0n,
      removed: photo.deleted_at !== null && photo.photo_quality < 0n,
    },
    stateChangedAt: photo.deleted_at ?? undefined,
    stackState: Number(photo.photo_stack),
    provenance: {
      title: photo.title_src,
      description: photo.caption_src,
      takenAt: photo.taken_src,
      location: photo.place_src,
      timeZone: photo.time_zone,
    },
    review,
    archive: { photo: row, details },
  };
};

const albumSchema = z.object({
  album_uid: text.min(1),
  created_by: text.nullable(),
  album_title: text,
  album_type: text.min(1),
  album_filter: text,
  album_private: flag,
  album_favorite: flag,
  deleted_at: timestamp.nullable(),
});
const membershipSchema = z.object({
  album_uid: text.min(1),
  photo_uid: text.min(1),
  order: z.bigint(),
  hidden: flag,
  missing: flag,
});

/** Retains excluded relationships for the protected archive; dynamic album membership needs separate materialization. */
export const normalizePhotoprismAlbum = (row: PhotoprismRow, relationships: PhotoprismRow[]) => {
  let album: z.infer<typeof albumSchema>;
  let memberships: z.infer<typeof membershipSchema>[];
  try {
    album = albumSchema.parse(row);
    memberships = relationships.map((relationship) => membershipSchema.parse(relationship));
  } catch {
    throw new Error('PhotoPrism source refused: PHOTOPRISM_ALBUM_METADATA_INVALID');
  }
  const seen = new Set<string>();
  for (const membership of memberships) {
    if (membership.album_uid !== album.album_uid || seen.has(membership.photo_uid)) {
      throw new Error('PhotoPrism source refused: PHOTOPRISM_ALBUM_MEMBERSHIP_INVALID');
    }
    seen.add(membership.photo_uid);
  }
  return {
    id: album.album_uid,
    createdBy: album.created_by || undefined,
    name: album.album_title,
    private: album.album_private,
    favorite: album.album_favorite,
    deletedAt: album.deleted_at ?? undefined,
    assetIds: memberships
      .filter((membership) => !membership.hidden && !membership.missing)
      .toSorted((a, b) => Number(a.order - b.order))
      .map((membership) => membership.photo_uid),
    memberships: memberships.map((membership) => ({
      photoId: membership.photo_uid,
      order: membership.order.toString(),
      hidden: membership.hidden,
      missing: membership.missing,
    })),
    review: album.album_type !== 'album' || album.album_filter !== '' ? ['ALBUM_REQUIRES_MATERIALIZATION'] : [],
    archive: { album: row, relationships },
  };
};
