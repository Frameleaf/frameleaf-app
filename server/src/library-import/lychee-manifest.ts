import { posix } from 'node:path';
import { z } from 'zod';
import type { LycheeRow, LycheeTable, openLycheeSnapshot } from 'src/library-import/lychee.js';
import fixture from 'src/library-import/fixtures/lychee/7.12.0-sqlite.json' with { type: 'json' };
import { resolveLycheeOriginals } from 'src/library-import/lychee-files.js';
import {
  type ImportManifest,
  importFileSchema,
  importTimestampSchema,
  parseImportManifest,
} from 'src/library-import/manifest.js';
import { type SourceArchiveRecord, encodeSourceArchiveRecord } from 'src/library-import/source-archive-codec.js';

type Manifest = Extract<ImportManifest, { version: 5 }>;
type Input = {
  source: ImportManifest['source'];
  inventory: ImportManifest['inventory'];
  files: (ImportManifest['files'][number] & { modifiedAt: string; contentId?: string })[];
  materializedAlbums: Record<string, string[]>;
};
const tables: LycheeTable[] = [
  'photos',
  'size_variants',
  'base_albums',
  'albums',
  'albums_tags',
  'photo_album',
  'photo_ratings',
  'tags',
  'photos_tags',
  'user_groups',
  'users_user_groups',
  'persons',
  'tag_albums',
  'tag_albums_tags',
  'person_albums',
  'person_albums_persons',
  'users',
  'access_permissions',
  'faces',
];
const refuse = (code: string): never => {
  throw new Error(`Lychee source refused: ${code}`);
};
const key = (value: unknown): string =>
  typeof value === 'bigint' || (typeof value === 'string' && value.length > 0)
    ? String(value)
    : refuse('LYCHEE_RELATIONSHIPS_INVALID');
const flag = z.union([z.literal(0n), z.literal(1n)]).transform((value) => value === 1n);
const numeric = z.union([z.number(), z.bigint().transform(Number)]);
const photoSchema = z.object({
  id: z.string().min(1),
  owner_id: z.bigint(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.string().min(1),
  taken_at: z.string().nullable(),
  taken_at_orig_tz: z.string().nullable(),
  is_highlighted: flag,
  is_validated: flag,
  latitude: numeric.pipe(z.number().min(-90).max(90)).nullable(),
  longitude: numeric.pipe(z.number().min(-180).max(180)).nullable(),
  live_photo_short_path: z.string().nullable(),
  live_photo_content_id: z.string().nullable(),
});

/** Maps admitted content only; source fencing, complete privacy configuration and independently inspected bytes remain required. */
export function readLycheeManifest(snapshot: ReturnType<typeof openLycheeSnapshot>, input: Input) {
  if (
    input.source.kind !== 'lychee' ||
    input.source.version !== fixture.source.version ||
    snapshot.version !== input.source.version
  )
    return refuse('LYCHEE_VERSION_UNQUALIFIED');
  if (input.source.schemaSha256 !== fixture.schemaSha256 || snapshot.schemaSha256 !== input.source.schemaSha256)
    return refuse('LYCHEE_SCHEMA_UNQUALIFIED');
  if (
    ['complete', 'ownershipComplete', 'privacyComplete', 'writersStopped'].some(
      (name) => Reflect.get(input.inventory, name) !== true,
    ) ||
    input.inventory.revisionBefore !== input.source.revision ||
    input.inventory.revisionAfter !== input.source.revision
  )
    return refuse('LYCHEE_CAPTURE_INCOMPLETE');
  const captured = new Map<LycheeTable, LycheeRow[]>();
  const archive: SourceArchiveRecord[] = [];
  for (const table of tables) {
    const records = [...snapshot.rows(table)].flat();
    for (const value of records) {
      encodeSourceArchiveRecord({ table, value });
      archive.push({ table, value });
    }
    captured.set(table, records);
  }
  const rows = (table: LycheeTable) => captured.get(table)!;
  const index = (table: LycheeTable) => {
    const result = new Map<string, LycheeRow>();
    for (const row of rows(table)) {
      const id = key(row.id);
      if (result.has(id)) return refuse('LYCHEE_RELATIONSHIPS_INVALID');
      result.set(id, row);
    }
    return result;
  };
  const users = index('users'),
    photos = index('photos'),
    albums = index('base_albums'),
    regular = index('albums'),
    tags = index('tags');
  const tagAlbums = index('tag_albums'),
    personAlbums = index('person_albums');
  const dynamic = new Set([...tagAlbums.keys(), ...personAlbums.keys()]);
  for (const id of [...regular.keys(), ...dynamic]) if (!albums.has(id)) return refuse('LYCHEE_RELATIONSHIPS_INVALID');
  for (const id of albums.keys())
    if (Number(regular.has(id)) + Number(tagAlbums.has(id)) + Number(personAlbums.has(id)) !== 1)
      return refuse('LYCHEE_ALBUM_TYPE_UNQUALIFIED');
  for (const id of regular.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined) {
      if (seen.has(current) || !regular.has(current)) return refuse('LYCHEE_ALBUM_HIERARCHY_INVALID');
      seen.add(current);
      const parent: LycheeRow['parent_id'] = regular.get(current)!.parent_id;
      current = parent === null ? undefined : key(parent);
    }
  }
  if (Object.keys(input.materializedAlbums).some((id) => !dynamic.has(id))) return refuse('LYCHEE_MAPPING_CHANGED');
  const losses: ImportManifest['losses'] = [];
  const loss = (code: string, entityId?: string) => {
    losses.push({ code, ...(entityId === undefined ? {} : { entityId }), acknowledged: false });
  };
  if (archive.length > 0) loss('LYCHEE_SOURCE_METADATA_ARCHIVED');
  if (rows('access_permissions').length > 0 || rows('user_groups').length > 0 || rows('users_user_groups').length > 0)
    loss('LYCHEE_SHARING_RESTRICTED');
  // shortcut: archive face geometry, directory ancestry and album tags until their destination mappings are qualified.
  if (rows('persons').length > 0 || rows('faces').length > 0) loss('LYCHEE_PEOPLE_ARCHIVED');
  if (rows('albums').some((row) => row.parent_id !== null)) loss('LYCHEE_ALBUM_HIERARCHY_ARCHIVED');
  if (rows('albums_tags').length > 0) loss('LYCHEE_ALBUM_TAGS_ARCHIVED');
  const variants = Map.groupBy(rows('size_variants'), (row) => key(row.photo_id));
  if (variants.keys().some((id) => !photos.has(id))) return refuse('LYCHEE_RELATIONSHIPS_INVALID');
  const photoTags = new Map<string, string[]>();
  for (const row of rows('photos_tags')) {
    const photoId = key(row.photo_id),
      tagId = key(row.tag_id);
    if (!photos.has(photoId) || !tags.has(tagId)) return refuse('LYCHEE_RELATIONSHIPS_INVALID');
    const values = photoTags.get(photoId) ?? [];
    if (values.includes(tagId)) return refuse('LYCHEE_RELATIONSHIPS_INVALID');
    values.push(tagId);
    photoTags.set(photoId, values);
  }
  const ratings = new Map<string, Map<string, number>>();
  for (const row of rows('photo_ratings')) {
    const photoId = key(row.photo_id),
      userId = key(row.user_id);
    if (
      !photos.has(photoId) ||
      !users.has(userId) ||
      typeof row.rating !== 'bigint' ||
      row.rating < 0n ||
      row.rating > 5n
    )
      return refuse('LYCHEE_RATING_REVIEW_REQUIRED');
    const values = ratings.get(photoId) ?? new Map<string, number>();
    if (values.has(userId)) return refuse('LYCHEE_RATING_REVIEW_REQUIRED');
    values.set(userId, Number(row.rating));
    ratings.set(photoId, values);
  }
  const proofs = new Map(input.files.map((file) => [file.id, file]));
  if (proofs.size !== input.files.length) return refuse('LYCHEE_FILE_EVIDENCE_MISMATCH');
  const checked = new Set<string>();
  const files: ImportManifest['files'] = [];
  const verifyFile = (id: string, path: string, role: 'original' | 'companion', bytes: string | null) => {
    const proof = proofs.get(id);
    if (
      !proof ||
      proof.path !== path ||
      proof.role !== role ||
      (bytes !== null && proof.bytes !== bytes) ||
      checked.has(id)
    )
      return refuse('LYCHEE_FILE_EVIDENCE_MISMATCH');
    const { modifiedAt, contentId: _contentId, ...file } = proof;
    if (!importTimestampSchema.safeParse(modifiedAt).success || !importFileSchema.safeParse(file).success)
      return refuse('LYCHEE_FILE_EVIDENCE_MISMATCH');
    checked.add(id);
    files.push({ ...file, role: 'original' });
    return proof;
  };
  const clocks = (
    photo: z.infer<typeof photoSchema>,
    modifiedAt: string,
  ): { takenAt: string; timeZone?: string; localDateTime?: string } => {
    if (photo.taken_at === null) {
      loss('LYCHEE_CAPTURE_TIME_FALLBACK', photo.id);
      return { takenAt: modifiedAt, timeZone: 'UTC' };
    }
    const takenAt = photo.taken_at.replace(' ', 'T') + 'Z';
    if (!importTimestampSchema.safeParse(takenAt).success || !photo.taken_at_orig_tz)
      return refuse('LYCHEE_CAPTURE_TIME_INVALID');
    const offset = /^([+-])(\d{2}):(\d{2})$/.exec(photo.taken_at_orig_tz);
    if (offset) {
      const hours = Number(offset[2]),
        minutes = Number(offset[3]);
      if (hours > 23 || minutes > 59) return refuse('LYCHEE_CAPTURE_TIME_INVALID');
      const shift = (hours * 60 + minutes) * (offset[1] === '-' ? -1 : 1);
      const fraction = /\.\d+(?=Z$)/.exec(takenAt)?.[0] ?? '';
      const localDateTime = new Date(Date.parse(takenAt) + shift * 60_000).toISOString().slice(0, 19) + fraction;
      if (!importTimestampSchema.safeParse(localDateTime + 'Z').success) return refuse('LYCHEE_CAPTURE_TIME_INVALID');
      return { takenAt, localDateTime };
    }
    try {
      return {
        takenAt,
        timeZone: new Intl.DateTimeFormat('en', { timeZone: photo.taken_at_orig_tz }).resolvedOptions().timeZone,
      };
    } catch {
      return refuse('LYCHEE_CAPTURE_TIME_INVALID');
    }
  };
  const assets: Manifest['assets'] = [];
  const livePhotos: Manifest['livePhotos'] = [];
  for (const [id, row] of photos) {
    const parsed = photoSchema.safeParse(row);
    if (!parsed.success || (parsed.data.latitude === null) !== (parsed.data.longitude === null))
      return refuse('LYCHEE_METADATA_INVALID');
    const photo = parsed.data;
    const ownerId = key(photo.owner_id);
    if (!users.has(ownerId)) return refuse('LYCHEE_OWNER_INVALID');
    const sourceVariants = variants.get(id) ?? [];
    const related = resolveLycheeOriginals(row, sourceVariants);
    const originals = related.filter((file) => file.role === 'original');
    const originalVariant = sourceVariants.find((variant) => variant.type === 1n);
    const primary =
      originals.find((file) => file.variantId === (originalVariant ? key(originalVariant.id) : undefined)) ??
      originals[0];
    const originalsProof = originals.map((file) =>
      verifyFile(`variant:${file.variantId}`, file.path, 'original', file.bytes),
    );
    const primaryProof = proofs.get(`variant:${primary.variantId}`)!;
    const { localDateTime, ...dates } = clocks(photo, primaryProof.modifiedAt);
    const rating = ratings.get(id)?.get(ownerId);
    if ([...(ratings.get(id)?.keys() ?? [])].some((userId) => userId !== ownerId))
      loss('LYCHEE_VIEWER_RATINGS_ARCHIVED', id);
    if (photo.title) loss('LYCHEE_TITLE_ARCHIVED', id);
    if (!photo.is_validated) loss('LYCHEE_UNVALIDATED_CONTENT_HIDDEN', id);
    const type = photo.type.startsWith('image/')
      ? 'IMAGE'
      : photo.type.startsWith('video/')
        ? 'VIDEO'
        : refuse('LYCHEE_MEDIA_TYPE_INVALID');
    const metadata = {
      ...dates,
      description: photo.description ?? '',
      latitude: photo.latitude,
      longitude: photo.longitude,
      favorite: photo.is_highlighted,
      tags: (photoTags.get(id) ?? []).map((tagId) => z.string().parse(tags.get(tagId)!.name)),
      ...(rating === undefined ? {} : { rating }),
    };
    assets.push({
      id,
      ownerId,
      fileIds: originalsProof.map((file) => file.id),
      primaryFileId: primaryProof.id,
      type,
      fileModifiedAt: primaryProof.modifiedAt,
      originalFileNames: Object.fromEntries(originalsProof.map((file) => [file.id, posix.basename(file.path)])),
      ...(localDateTime === undefined ? {} : { localDateTime }),
      // Owner 2026-11-04: an upload the Lychee owner never approved imports Locked, for review.
      visibility: photo.is_validated ? 'timeline' : 'locked',
      metadata,
    });
    const companion = related.find((file) => file.role === 'companion');
    if (companion) {
      const motion = verifyFile(`companion:${id}`, companion.path, 'companion', null);
      if (
        type !== 'IMAGE' ||
        !originalVariant ||
        !photo.live_photo_content_id ||
        primaryProof.contentId !== photo.live_photo_content_id ||
        motion.contentId !== photo.live_photo_content_id
      )
        return refuse('LYCHEE_LIVE_PHOTO_IDENTITY_REQUIRED');
      const motionId = `motion:${id}`;
      assets.push({
        id: motionId,
        ownerId,
        fileIds: [motion.id],
        primaryFileId: motion.id,
        type: 'VIDEO',
        visibility: 'hidden',
        fileModifiedAt: motion.modifiedAt,
        originalFileNames: { [motion.id]: posix.basename(motion.path) },
        ...(localDateTime === undefined ? {} : { localDateTime }),
        metadata: { ...dates, latitude: photo.latitude, longitude: photo.longitude },
      });
      livePhotos.push({ photoAssetId: id, videoAssetId: motionId });
      archive.push({
        table: 'frameleaf_live_photo_verification',
        value: {
          photo_id: id,
          content_id: photo.live_photo_content_id,
          original_sha256: primaryProof.sha256,
          companion_sha256: motion.sha256,
          companion_bytes: motion.bytes,
          companion_path: motion.path,
        },
      });
    }
  }
  if (checked.size !== proofs.size) return refuse('LYCHEE_FILE_EVIDENCE_MISMATCH');
  const photoAssets = new Map(assets.filter((asset) => photos.has(asset.id)).map((asset) => [asset.id, asset]));
  const memberships = new Map<string, string[]>();
  for (const row of rows('photo_album')) {
    const albumId = key(row.album_id),
      photoId = key(row.photo_id);
    if (!regular.has(albumId) || !photoAssets.has(photoId)) return refuse('LYCHEE_RELATIONSHIPS_INVALID');
    const members = memberships.get(albumId) ?? [];
    if (members.includes(photoId)) return refuse('LYCHEE_RELATIONSHIPS_INVALID');
    members.push(photoId);
    memberships.set(albumId, members);
  }
  const mappedAlbums: ImportManifest['albums'] = [];
  for (const [id, row] of albums) {
    const ownerId = key(row.owner_id);
    if (
      !users.has(ownerId) ||
      typeof row.title !== 'string' ||
      (row.description !== null && typeof row.description !== 'string')
    )
      return refuse('LYCHEE_ALBUM_METADATA_INVALID');
    let members = memberships.get(id) ?? [];
    if (dynamic.has(id)) {
      if (!Object.hasOwn(input.materializedAlbums, id)) return refuse('LYCHEE_ALBUM_SNAPSHOT_REQUIRED');
      members = input.materializedAlbums[id];
      loss('LYCHEE_ALBUM_SNAPSHOT', id);
    }
    if (new Set(members).size !== members.length || members.some((member) => !photoAssets.has(member)))
      return refuse('LYCHEE_RELATIONSHIPS_INVALID');
    if (members.some((member) => photoAssets.get(member)!.ownerId !== ownerId))
      loss('LYCHEE_CROSS_OWNER_MEMBERSHIP_ARCHIVED', id);
    mappedAlbums.push({
      id,
      ownerId,
      name: row.title + (dynamic.has(id) ? ' (snapshot)' : ''),
      ...(row.description === null ? {} : { description: row.description }),
      assetIds: members.filter((member) => photoAssets.get(member)!.ownerId === ownerId),
      members: [],
    });
  }
  for (const record of archive) encodeSourceArchiveRecord(record);
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 5,
    source: input.source,
    inventory: input.inventory,
    users: [...users].map(([id, row]) => ({ id, name: z.string().parse(row.display_name ?? row.username) })),
    files,
    assets,
    albums: mappedAlbums,
    stacks: [],
    livePhotos,
    losses,
  });
  return { manifest, archive };
}
