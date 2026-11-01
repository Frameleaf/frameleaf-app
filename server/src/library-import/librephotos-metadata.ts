import { z } from 'zod';
import { LibrephotosRow } from 'src/library-import/librephotos.js';
import { ImportManifest } from 'src/library-import/manifest.js';

const flag = z.union([z.literal(0n), z.literal(1n)]).transform((value) => value === 1n);
const wallClock = z
  .string()
  .transform((value) => value.replace(' ', 'T'))
  .refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u.test(value))
  .refine((value) => z.iso.datetime().safeParse(value + 'Z').success);
const photoSchema = z.object({
  id: z.string().regex(/^[\da-f]{32}$/u),
  owner_id: z.bigint(),
  main_file_id: z.string().min(1).nullable(),
  exif_timestamp: wallClock.nullable(),
  timestamp: wallClock.nullable(),
  exif_timestamp_offset: z.bigint().min(-840n).max(840n).nullable(),
  exif_timestamp_source: z.bigint().nullable(),
  exif_gps_lat: z.number().min(-90).max(90).nullable(),
  exif_gps_lon: z.number().min(-180).max(180).nullable(),
  location_source: z.string().nullable(),
  rating: z.bigint().min(0n).max(5n).transform(Number),
  public: flag,
  hidden: flag,
  archived: flag,
  in_trashcan: flag,
  removed: flag,
});
const ownerSchema = z.object({
  id: z.bigint(),
  favorite_min_rating: z.bigint(),
  rating_mode: z.enum(['favorite', 'stars']),
});
const metadataSchema = z.object({ title: z.string().nullable() });
const captionSchema = z.object({ user_caption: z.string().nullable().optional() });
const tagSchema = z.object({ id: z.bigint(), owner_id: z.bigint(), name: z.string().min(1) });

/** Context rows and complete current tag relationships must come from the same admitted source snapshot. */
export const normalizeLibrephotosPhoto = (input: {
  photo: LibrephotosRow;
  owner: LibrephotosRow;
  metadata?: LibrephotosRow;
  caption?: LibrephotosRow;
  tags: LibrephotosRow[];
}) => {
  let photo: z.infer<typeof photoSchema>;
  let owner: z.infer<typeof ownerSchema>;
  let details: z.infer<typeof metadataSchema> | undefined;
  let caption: z.infer<typeof captionSchema> | undefined;
  let tags: z.infer<typeof tagSchema>[];
  try {
    photo = photoSchema.parse(input.photo);
    owner = ownerSchema.parse(input.owner);
    details = input.metadata ? metadataSchema.parse(input.metadata) : undefined;
    caption =
      input.caption?.captions_json === null || !input.caption
        ? undefined
        : captionSchema.parse(JSON.parse(z.string().parse(input.caption.captions_json)));
    tags = input.tags.map((row) => tagSchema.parse(row));
    if ((photo.exif_gps_lat === null) !== (photo.exif_gps_lon === null)) throw new Error('Incomplete location');
  } catch {
    throw new Error('LibrePhotos source refused: LIBREPHOTOS_METADATA_INVALID');
  }
  if (
    owner.id !== photo.owner_id ||
    (input.metadata && input.metadata.photo_id !== photo.id) ||
    (input.caption && input.caption.photo_id !== photo.id) ||
    tags.some((tag) => tag.owner_id !== owner.id) ||
    new Set(tags.map((tag) => tag.id)).size !== tags.length
  ) {
    throw new Error('LibrePhotos source refused: LIBREPHOTOS_METADATA_RELATIONSHIP_INVALID');
  }
  const review: string[] = [];
  const localDateTime = photo.timestamp ?? photo.exif_timestamp ?? undefined;
  let takenAt: string | undefined;
  if (!localDateTime) review.push('CAPTURE_TIME_UNKNOWN');
  else if (photo.timestamp !== null || photo.exif_timestamp_offset === null) review.push('CAPTURE_OFFSET_UNKNOWN');
  else {
    const [seconds, fraction] = localDateTime.split('.', 2);
    // Preserve SQLite's microseconds; Date arithmetic alone would truncate them to milliseconds.
    takenAt = new Date(Date.parse(seconds + 'Z') - Number(photo.exif_timestamp_offset) * 60_000)
      .toISOString()
      .replace(/\.\d{3}Z$/u, () => (fraction ? `.${fraction}Z` : 'Z'));
    if (!z.iso.datetime().safeParse(takenAt).success) {
      throw new Error('LibrePhotos source refused: LIBREPHOTOS_METADATA_INVALID');
    }
  }
  if (photo.timestamp !== null && photo.timestamp !== photo.exif_timestamp) review.push('MANUAL_CAPTURE_RULE_MISMATCH');
  if (!input.metadata) review.push('PHOTO_METADATA_MISSING');
  const metadata: ImportManifest['assets'][number]['metadata'] = {
    title: details?.title ?? undefined,
    description: caption?.user_caption ?? undefined,
    takenAt,
    latitude: photo.exif_gps_lat ?? undefined,
    longitude: photo.exif_gps_lon ?? undefined,
    rating: photo.rating,
    favorite: BigInt(photo.rating) >= owner.favorite_min_rating,
    // Current tag relationships include individual additions/removals that embedded keywords cannot represent.
    tags: tags.map((tag) => tag.name),
  };
  return {
    id: photo.id,
    ownerId: owner.id.toString(),
    mainFileId: photo.main_file_id ?? undefined,
    metadata,
    localDateTime,
    state: {
      public: photo.public,
      hidden: photo.hidden,
      archived: photo.archived,
      inTrash: photo.in_trashcan,
      removed: photo.removed,
    },
    provenance: {
      captureTime: photo.timestamp !== null ? 'manual' : 'source-rule',
      captureRule: photo.exif_timestamp_source?.toString(),
      captureOffsetMinutes: photo.exif_timestamp_offset === null ? undefined : Number(photo.exif_timestamp_offset),
      location: photo.location_source ?? undefined,
      ratingMode: owner.rating_mode,
    },
    review,
  };
};
