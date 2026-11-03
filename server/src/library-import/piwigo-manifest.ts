import { DateTime } from 'luxon';
import { posix } from 'node:path';
import { z } from 'zod';
import type { PiwigoRow, PiwigoTable } from 'src/library-import/piwigo-source.js';
import fixture from 'src/library-import/fixtures/piwigo/16.4.0-mariadb.json' with { type: 'json' };
import {
  type ImportManifest,
  importFileSchema,
  importTimestampSchema,
  parseImportManifest,
} from 'src/library-import/manifest.js';
import { resolvePiwigoOriginals } from 'src/library-import/piwigo-files.js';
import { piwigoProjections } from 'src/library-import/piwigo-projections.js';
import { type SourceArchiveRecord, encodeSourceArchiveRecord } from 'src/library-import/source-archive-codec.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { normalizeTagValue } from 'src/utils/tag.js';

type Input = {
  source: ImportManifest['source'];
  inventory: ImportManifest['inventory'];
  photoOwners: Record<string, string>;
  albumOwners: Record<string, string>;
  reviewedCaptureOffsets: Record<string, number>;
  reviewedMissingImageIds: string[];
  files: (ImportManifest['files'][number] & { modifiedAt: string })[];
};
const refuse = (code: string): never => {
  throw new Error('Piwigo source refused: ' + code);
};
const key = (value: unknown): string =>
  typeof value === 'bigint' && value > 0n ? String(value) : refuse('PIWIGO_RELATIONSHIPS_INVALID');
const levels = new Set([0n, 1n, 2n, 4n, 8n]);
const imageSchema = z.object({
  id: z.bigint().positive(),
  file: z.string().min(1),
  date_available: z.string(),
  date_creation: z.string().nullable(),
  name: z.string().nullable(),
  comment: z.string().nullable(),
  level: z.bigint().refine((value) => levels.has(value)),
  latitude: z.union([z.string(), z.number()]).nullable(),
  longitude: z.union([z.string(), z.number()]).nullable(),
});

/** Maps an admitted restored snapshot; the controller independently establishes capture, fencing and original-byte evidence. */
export async function readPiwigoManifest(
  source: AsyncIterable<{ table: PiwigoTable; rows: PiwigoRow[] }>,
  input: Input,
) {
  if (input.source.kind !== 'piwigo' || input.source.version !== fixture.source.version)
    return refuse('PIWIGO_VERSION_UNQUALIFIED');
  if (input.source.schemaSha256 !== fixture.schemaSha256) return refuse('PIWIGO_SCHEMA_UNQUALIFIED');
  if (
    ['complete', 'ownershipComplete', 'privacyComplete', 'writersStopped'].some(
      (field) => Reflect.get(input.inventory, field) !== true,
    ) ||
    input.inventory.revisionBefore !== input.source.revision ||
    input.inventory.revisionAfter !== input.source.revision
  )
    return refuse('PIWIGO_CAPTURE_INCOMPLETE');
  const captured = new Map<PiwigoTable, PiwigoRow[]>(
    Object.keys(piwigoProjections).map((table) => [table as PiwigoTable, []]),
  );
  const archive: SourceArchiveRecord[] = [];
  for await (const batch of source) {
    if (!Object.hasOwn(piwigoProjections, batch.table)) return refuse('PIWIGO_TABLE_UNQUALIFIED');
    const columns: readonly string[] = piwigoProjections[batch.table].columns;
    for (const value of batch.rows) {
      if (Object.keys(value).length !== columns.length || Object.keys(value).some((name) => !columns.includes(name)))
        return refuse('PIWIGO_ROW_UNQUALIFIED');
      encodeSourceArchiveRecord({ table: batch.table, value });
      archive.push({ table: batch.table, value });
      captured.get(batch.table)!.push(value);
    }
  }
  const rows = (table: PiwigoTable) => captured.get(table)!;
  const index = (table: PiwigoTable, column = 'id') => {
    const result = new Map<string, PiwigoRow>();
    for (const row of rows(table)) {
      const id = key(row[column]);
      if (result.has(id)) return refuse('PIWIGO_RELATIONSHIPS_INVALID');
      result.set(id, row);
    }
    return result;
  };
  const images = index('images'),
    categories = index('categories'),
    users = index('users'),
    infos = index('user_infos', 'user_id'),
    groups = index('groups'),
    tags = index('tags');
  if (rows('lounge').length > 0) return refuse('PIWIGO_PENDING_UPLOADS');
  if (users.size !== infos.size || users.keys().some((id) => !infos.has(id)))
    return refuse('PIWIGO_RELATIONSHIPS_INVALID');
  const accountIds = new Set<string>();
  for (const [id, user] of users) {
    const info = infos.get(id)!;
    if (
      typeof user.username !== 'string' ||
      !['webmaster', 'admin', 'normal', 'generic', 'guest'].includes(String(info.status)) ||
      typeof info.level !== 'bigint' ||
      !levels.has(info.level) ||
      !['true', 'false'].includes(String(info.enabled_high))
    )
      return refuse('PIWIGO_OWNER_REVIEW_REQUIRED');
    if (info.status !== 'guest') accountIds.add(id);
  }
  for (const [id, category] of categories) {
    if (
      typeof category.name !== 'string' ||
      !['public', 'private'].includes(String(category.status)) ||
      !['true', 'false'].includes(String(category.visible))
    )
      return refuse('PIWIGO_CATEGORY_GRAPH_INVALID');
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined) {
      if (seen.has(current) || !categories.has(current)) return refuse('PIWIGO_CATEGORY_GRAPH_INVALID');
      seen.add(current);
      const parent = categories.get(current)!.id_uppercat;
      current = parent === null ? undefined : key(parent);
    }
  }
  const relations = (
    table: PiwigoTable,
    left: string,
    leftIds: Map<string, PiwigoRow>,
    right: string,
    rightIds: Map<string, PiwigoRow>,
  ) => {
    const seen = new Set<string>();
    for (const row of rows(table)) {
      const a = key(row[left]),
        b = key(row[right]),
        pair = JSON.stringify([a, b]);
      if (!leftIds.has(a) || !rightIds.has(b) || seen.has(pair)) return refuse('PIWIGO_RELATIONSHIPS_INVALID');
      seen.add(pair);
    }
  };
  relations('user_group', 'user_id', users, 'group_id', groups);
  relations('user_access', 'user_id', users, 'cat_id', categories);
  relations('group_access', 'group_id', groups, 'cat_id', categories);
  const missing = new Set<string>();
  for (const table of ['image_category', 'favorites', 'image_tag', 'image_format'] as const)
    for (const row of rows(table)) if (!images.has(key(row.image_id))) missing.add(key(row.image_id));
  for (const category of categories.values())
    if (category.representative_picture_id !== null && !images.has(key(category.representative_picture_id)))
      missing.add(key(category.representative_picture_id));
  const reviewed = new Set(input.reviewedMissingImageIds);
  if (
    reviewed.size !== input.reviewedMissingImageIds.length ||
    reviewed.size !== missing.size ||
    reviewed.values().some((id) => !missing.has(id))
  )
    return refuse('PIWIGO_MISSING_IMAGES_REVIEW_REQUIRED');
  for (const row of rows('image_category'))
    if (!categories.has(key(row.category_id))) return refuse('PIWIGO_RELATIONSHIPS_INVALID');
  for (const row of rows('favorites')) if (!users.has(key(row.user_id))) return refuse('PIWIGO_RELATIONSHIPS_INVALID');
  for (const row of rows('image_tag')) if (!tags.has(key(row.tag_id))) return refuse('PIWIGO_RELATIONSHIPS_INVALID');
  const memberships = Map.groupBy(
    rows('image_category').filter((row) => images.has(key(row.image_id))),
    (row) => key(row.image_id),
  );
  const seenLinks = new Set<string>();
  for (const table of ['image_category', 'favorites', 'image_tag'] as const)
    for (const row of rows(table)) {
      const name = table === 'image_category' ? 'category_id' : table === 'favorites' ? 'user_id' : 'tag_id';
      const pair = JSON.stringify([table, key(row.image_id), key(row[name])]);
      if (seenLinks.has(pair)) return refuse('PIWIGO_RELATIONSHIPS_INVALID');
      seenLinks.add(pair);
    }
  const formats = Map.groupBy(rows('image_format'), (row) => key(row.image_id));
  const imageTags = Map.groupBy(rows('image_tag'), (row) => key(row.image_id));
  const favourites = new Set(rows('favorites').map((row) => JSON.stringify([key(row.image_id), key(row.user_id)])));
  const categoryLinks = Map.groupBy(
    rows('image_category').filter((row) => images.has(key(row.image_id))),
    (row) => key(row.category_id),
  );
  const userGroups = Map.groupBy(rows('user_group'), (row) => key(row.user_id));
  const direct = Map.groupBy(rows('user_access'), (row) => key(row.user_id));
  const granted = Map.groupBy(rows('group_access'), (row) => key(row.group_id));
  const privateGrants = new Map(
    [...users.keys()].map((id) => [
      id,
      new Set([
        ...(direct.get(id) ?? []).map((row) => key(row.cat_id)),
        ...(userGroups.get(id) ?? []).flatMap((group) =>
          (granted.get(key(group.group_id)) ?? []).map((row) => key(row.cat_id)),
        ),
      ]),
    ]),
  );
  const categoryAllowed = (ownerId: string, categoryId: string) => {
    const info = infos.get(ownerId),
      category = categories.get(categoryId);
    if (!accountIds.has(ownerId) || !info || !category || info.enabled_high !== 'true') return false;
    if (category.visible === 'false' && !['admin', 'webmaster'].includes(String(info.status))) return false;
    return category.status === 'public' || privateGrants.get(ownerId)!.has(categoryId);
  };
  if (
    Object.keys(input.photoOwners).length !== images.size ||
    Object.keys(input.photoOwners).some((id) => !images.has(id)) ||
    Object.keys(input.albumOwners).length !== categories.size ||
    Object.keys(input.albumOwners).some((id) => !categories.has(id))
  )
    return refuse('PIWIGO_OWNER_REVIEW_REQUIRED');
  for (const [id, owner] of Object.entries(input.albumOwners))
    if (!categoryAllowed(owner, id)) return refuse('PIWIGO_OWNER_REVIEW_REQUIRED');
  if (
    Object.keys(input.reviewedCaptureOffsets).length !== images.size ||
    Object.keys(input.reviewedCaptureOffsets).some((id) => !images.has(id))
  )
    return refuse('PIWIGO_CAPTURE_OFFSET_REVIEW_REQUIRED');
  const losses: ImportManifest['losses'] = [
    { code: 'PIWIGO_SOURCE_METADATA_ARCHIVED', acknowledged: false },
    { code: 'PIWIGO_SHARING_RESTRICTED', acknowledged: false },
  ];
  const loss = (code: string, entityId?: string) => {
    losses.push({ code, ...(entityId === undefined ? {} : { entityId }), acknowledged: false });
  };
  if (missing.size > 0) loss('PIWIGO_MISSING_IMAGE_RELATIONSHIPS_ARCHIVED');
  const proofs = new Map(input.files.map((file) => [file.id, file]));
  if (proofs.size !== input.files.length) return refuse('PIWIGO_FILE_EVIDENCE_MISMATCH');
  const files: ImportManifest['files'] = [],
    assets: ImportManifest['assets'] = [];
  const checked = new Set<string>();
  for (const [id, row] of images) {
    const parsed = imageSchema.safeParse(row);
    if (!parsed.success) return refuse('PIWIGO_METADATA_INVALID');
    const image = parsed.data;
    const ownerId = input.photoOwners[id],
      info = infos.get(ownerId);
    if (
      !info ||
      typeof info.level !== 'bigint' ||
      info.level < image.level ||
      !(memberships.get(id) ?? []).some((row) => categoryAllowed(ownerId, key(row.category_id)))
    )
      return refuse('PIWIGO_OWNER_REVIEW_REQUIRED');
    const originals = resolvePiwigoOriginals(row, formats.get(id) ?? []);
    const names: Record<string, string> = {},
      fileIds: string[] = [];
    for (const original of originals) {
      const fileId = 'image:' + id + ':' + (original.formatId === null ? 'original' : 'format:' + original.formatId),
        proof = proofs.get(fileId);
      if (
        !proof ||
        proof.path !== original.path ||
        proof.role !== 'original' ||
        !importTimestampSchema.safeParse(proof.modifiedAt).success
      )
        return refuse('PIWIGO_FILE_EVIDENCE_MISMATCH');
      const { modifiedAt: _modifiedAt, ...file } = proof;
      if (!importFileSchema.safeParse(file).success) return refuse('PIWIGO_FILE_EVIDENCE_MISMATCH');
      files.push(file);
      checked.add(fileId);
      fileIds.push(fileId);
      names[fileId] =
        original.formatId === null ? image.file : posix.parse(image.file).name + posix.extname(original.path);
    }
    const primaryFileId = fileIds[0],
      primary = proofs.get(primaryFileId)!;
    const type = mimeTypes.isImage(primary.path)
      ? 'IMAGE'
      : mimeTypes.isVideo(primary.path)
        ? 'VIDEO'
        : refuse('PIWIGO_MEDIA_UNQUALIFIED');
    const sql = image.date_creation ?? image.date_available;
    if (
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u.test(sql) ||
      !DateTime.fromSQL(sql, { zone: 'UTC' }).isValid
    )
      return refuse('PIWIGO_CAPTURE_TIME_INVALID');
    const offset = input.reviewedCaptureOffsets[id];
    if (!Number.isSafeInteger(offset) || Math.abs(offset) > 840) return refuse('PIWIGO_CAPTURE_OFFSET_REVIEW_REQUIRED');
    const localDateTime = sql.replace(' ', 'T'),
      [seconds, fraction] = localDateTime.split('.', 2);
    const takenAt = new Date(Date.parse(seconds + 'Z') - offset * 60_000)
      .toISOString()
      .replace(/\.\d{3}Z$/u, () => (fraction ? '.' + fraction + 'Z' : '.000Z'));
    if (image.date_creation === null) loss('PIWIGO_CAPTURE_TIME_FALLBACK', id);
    archive.push({ table: 'frameleaf_capture_offset_review', value: { image_id: id, offset_minutes: BigInt(offset) } });
    const coordinates = [image.latitude, image.longitude].map((value) =>
      value === null ? null : typeof value === 'string' && value.trim() === '' ? Number.NaN : Number(value),
    );
    if (
      (coordinates[0] === null) !== (coordinates[1] === null) ||
      (coordinates[0] !== null && (!Number.isFinite(coordinates[0]) || Math.abs(coordinates[0]) > 90)) ||
      (coordinates[1] !== null && (!Number.isFinite(coordinates[1]) || Math.abs(coordinates[1]) > 180))
    )
      return refuse('PIWIGO_METADATA_INVALID');
    const photoTags = (imageTags.get(id) ?? []).map((link) => tags.get(key(link.tag_id))!.name);
    if (
      photoTags.some(
        (tag) => typeof tag !== 'string' || tag !== normalizeTagValue(tag) || tag.length === 0 || tag.includes('\0'),
      ) ||
      new Set(photoTags).size !== photoTags.length
    )
      return refuse('PIWIGO_TAG_REVIEW_REQUIRED');
    if (image.name) loss('PIWIGO_TITLE_ARCHIVED', id);
    if (row.rotation !== null && row.rotation !== 0n) loss('PIWIGO_ROTATION_ARCHIVED', id);
    if (row.rating_score !== null) loss('PIWIGO_AGGREGATE_RATING_ARCHIVED', id);
    assets.push({
      id,
      ownerId,
      fileIds,
      primaryFileId,
      type,
      fileModifiedAt: primary.modifiedAt,
      originalFileNames: names,
      localDateTime,
      visibility: 'timeline',
      metadata: {
        description: image.comment ?? '',
        takenAt,
        latitude: coordinates[0],
        longitude: coordinates[1],
        tags: photoTags as string[],
        favorite: favourites.has(JSON.stringify([id, ownerId])),
      },
    });
  }
  if (checked.size !== proofs.size) return refuse('PIWIGO_FILE_EVIDENCE_MISMATCH');
  const albums: ImportManifest['albums'] = [];
  for (const [id, category] of categories) {
    const partitions = new Map<string, string[]>([[input.albumOwners[id], []]]);
    const links = (categoryLinks.get(id) ?? []).sort((a, b) =>
      a.rank === b.rank ? 0 : typeof a.rank === 'bigint' && typeof b.rank === 'bigint' && a.rank < b.rank ? -1 : 1,
    );
    for (const link of links) {
      const photoId = key(link.image_id),
        ownerId = input.photoOwners[photoId];
      if (!categoryAllowed(ownerId, id)) {
        loss('PIWIGO_ALBUM_MEMBERSHIP_RESTRICTED', id + ':' + photoId);
        continue;
      }
      const members = partitions.get(ownerId) ?? [];
      members.push(photoId);
      partitions.set(ownerId, members);
    }
    for (const [ownerId, assetIds] of partitions)
      albums.push({
        id: id + ':owner:' + ownerId,
        ownerId,
        name: String(category.name),
        ...(typeof category.comment === 'string' ? { description: category.comment } : {}),
        assetIds,
        members: [],
      });
    if (category.id_uppercat !== null) loss('PIWIGO_CATEGORY_HIERARCHY_ARCHIVED', id);
  }
  return {
    manifest: parseImportManifest({
      format: 'frameleaf-library-import',
      version: 3,
      source: input.source,
      inventory: input.inventory,
      users: [...accountIds].map((id) => ({ id, name: String(users.get(id)!.username) })),
      files,
      assets,
      albums,
      losses,
    }),
    archive,
  };
}
