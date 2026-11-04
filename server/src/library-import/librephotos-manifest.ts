import { posix } from 'node:path';
import { z } from 'zod';
import type { LibrephotosRow, LibrephotosTable } from 'src/library-import/librephotos.js';
import postgres from 'src/library-import/fixtures/librephotos/1.5.1-postgres18.json' with { type: 'json' };
import sqlite from 'src/library-import/fixtures/librephotos/1.5.1-sqlite.json' with { type: 'json' };
import { classifyLibrephotosFile, normalizeLibrephotosFileCopy } from 'src/library-import/librephotos-files.js';
import { normalizeLibrephotosPhoto } from 'src/library-import/librephotos-metadata.js';
import { librephotosProjections } from 'src/library-import/librephotos-projections.js';
import {
  type ImportManifest,
  importFileSchema,
  importTimestampSchema,
  parseImportManifest,
} from 'src/library-import/manifest.js';
import { type SourceArchiveRecord, encodeSourceArchiveRecord } from 'src/library-import/source-archive-codec.js';

type Snapshot = {
  version: string;
  schemaSha256: string;
  rows: (table: LibrephotosTable) => Iterable<LibrephotosRow[]> | AsyncIterable<LibrephotosRow[]>;
};
type Input = {
  source: ImportManifest['source'];
  inventory: ImportManifest['inventory'];
  sourceRoot: string;
  files: (ImportManifest['files'][number] & { modifiedAt: string })[];
  reviewedCaptureOffsets: Record<string, number>;
};
type Manifest = Extract<ImportManifest, { version: 4 }>;
const refuse = (code: string): never => {
  throw new Error(`LibrePhotos source refused: ${code}`);
};
const key = (value: unknown): string =>
  typeof value === 'bigint' || (typeof value === 'string' && value.length > 0)
    ? String(value)
    : refuse('LIBREPHOTOS_RELATIONSHIPS_INVALID');
const auditTime = (value: unknown) => {
  if (typeof value !== 'string') return refuse('LIBREPHOTOS_AUDIT_TIME_INVALID');
  const result = importTimestampSchema.safeParse(value.replace(' ', 'T') + 'Z');
  return result.success ? result.data : refuse('LIBREPHOTOS_AUDIT_TIME_INVALID');
};

/** Admitted snapshots only; live source fencing, private account credentials and byte capture stay with the caller. */
export async function readLibrephotosManifest(snapshot: Snapshot, input: Input) {
  if (
    input.source.kind !== 'librephotos' ||
    input.source.version !== sqlite.source.version ||
    snapshot.version !== input.source.version
  )
    return refuse('LIBREPHOTOS_VERSION_UNQUALIFIED');
  if (
    ![sqlite.schemaSha256, postgres.schemaSha256].includes(input.source.schemaSha256) ||
    snapshot.schemaSha256 !== input.source.schemaSha256
  )
    return refuse('LIBREPHOTOS_SCHEMA_UNQUALIFIED');
  if (
    ['complete', 'ownershipComplete', 'privacyComplete', 'writersStopped'].some(
      (name) => Reflect.get(input.inventory, name) !== true,
    ) ||
    input.inventory.revisionBefore !== input.source.revision ||
    input.inventory.revisionAfter !== input.source.revision
  )
    return refuse('LIBREPHOTOS_CAPTURE_INCOMPLETE');
  const tables = new Map<LibrephotosTable, LibrephotosRow[]>();
  const archive: SourceArchiveRecord[] = [];
  for (const table of Object.keys(librephotosProjections) as LibrephotosTable[]) {
    const captured: LibrephotosRow[] = [];
    for await (const batch of snapshot.rows(table)) {
      for (const value of batch) {
        encodeSourceArchiveRecord({ table, value });
        captured.push(value);
        archive.push({ table, value });
      }
    }
    tables.set(table, captured);
  }
  const rows = (table: LibrephotosTable) => tables.get(table)!;
  const index = (table: LibrephotosTable, column: string) => {
    const result = new Map<string, LibrephotosRow>();
    for (const row of rows(table)) {
      const id = key(row[column]);
      if (result.has(id)) return refuse('LIBREPHOTOS_RELATIONSHIPS_INVALID');
      result.set(id, row);
    }
    return result;
  };
  const group = (table: LibrephotosTable, column: string) => Map.groupBy(rows(table), (row) => key(row[column]));
  const owners = index('api_user', 'id');
  const photos = index('api_photo', 'id');
  const sourceFiles = index('api_file', 'hash');
  const details = index('api_photometadata', 'photo_id');
  const captions = index('api_photo_caption', 'photo_id');
  const tags = index('api_tag', 'id');
  const photoFiles = group('api_photo_files', 'photo_id');
  const photoTags = group('api_tag_photos', 'photo_id');
  if (rows('api_file_embedded_media').length > 0) return refuse('LIBREPHOTOS_COMPANIONS_REVIEW_REQUIRED');
  const losses: ImportManifest['losses'] = [];
  const loss = (code: string, entityId?: string) => {
    losses.push({ code, ...(entityId === undefined ? {} : { entityId }), acknowledged: false });
  };
  if (archive.length > 0) loss('LIBREPHOTOS_SOURCE_METADATA_ARCHIVED');
  if (rows('api_person').length > 0 || rows('api_face').length > 0) loss('LIBREPHOTOS_PEOPLE_ARCHIVED');
  if (
    rows('api_albumuser_shared_to').length > 0 ||
    rows('api_photo_shared_to').length > 0 ||
    rows('api_libraryshare').length > 0 ||
    rows('api_albumusershare').length > 0 ||
    rows('api_photoshare').length > 0 ||
    rows('api_photo').some((photo) => photo.public === 1n)
  )
    loss('LIBREPHOTOS_SHARING_RESTRICTED');
  const proofs = new Map(input.files.map((file) => [file.id, file]));
  if (proofs.size !== input.files.length) return refuse('LIBREPHOTOS_FILE_EVIDENCE_MISMATCH');
  const classified = new Map<string, ReturnType<typeof classifyLibrephotosFile>>();
  const manifestFiles: ImportManifest['files'] = [];
  const checked = new Set<string>();
  const evidence = (id: string, path: string, role: 'original' | 'sidecar') => {
    const proof = proofs.get(id);
    if (!proof || proof.path !== path || proof.role !== role) return refuse('LIBREPHOTOS_FILE_EVIDENCE_MISMATCH');
    const { modifiedAt, ...file } = proof;
    importTimestampSchema.parse(modifiedAt);
    checked.add(id);
    return { ...importFileSchema.parse(file), modifiedAt };
  };
  for (const [id, row] of sourceFiles) {
    const file = classifyLibrephotosFile(row, input.sourceRoot, []);
    classified.set(id, file);
    const { modifiedAt: _modifiedAt, ...proof } = evidence(
      `file:${id}`,
      file.path,
      file.role as 'original' | 'sidecar',
    );
    manifestFiles.push(proof);
  }
  for (const row of rows('api_filecopy')) {
    const copy = normalizeLibrephotosFileCopy(row, input.sourceRoot);
    const original = classified.get(copy.fileId);
    if (!original) return refuse('LIBREPHOTOS_RELATIONSHIPS_INVALID');
    const proof = evidence(`copy:${copy.id}`, copy.path, original.role as 'original' | 'sidecar');
    const primary = proofs.get(`file:${copy.fileId}`)!;
    if (proof.sha256 !== primary.sha256 || proof.bytes !== primary.bytes)
      return refuse('LIBREPHOTOS_FILE_COPY_CHANGED');
    archive.push({
      table: 'frameleaf_file_copy_verification',
      value: {
        copy_id: BigInt(copy.id),
        file_id: copy.fileId,
        path: copy.path,
        sha256: proof.sha256,
        bytes: proof.bytes,
        modified_at: proof.modifiedAt,
      },
    });
  }
  if (rows('api_filecopy').length > 0) loss('LIBREPHOTOS_DUPLICATE_PATHS_ARCHIVED');
  if (checked.size !== proofs.size) return refuse('LIBREPHOTOS_FILE_EVIDENCE_MISMATCH');
  const referenced = new Set<string>();
  const reviewed = new Set<string>();
  const assets: Manifest['assets'] = [];
  for (const [id, row] of photos) {
    const owner = owners.get(key(row.owner_id));
    if (!owner) return refuse('LIBREPHOTOS_OWNER_INVALID');
    const photo = normalizeLibrephotosPhoto({
      photo: row,
      owner,
      metadata: details.get(id),
      caption: captions.get(id),
      tags: (photoTags.get(id) ?? []).map((link) => {
        const tag = tags.get(key(link.tag_id));
        return tag ?? refuse('LIBREPHOTOS_RELATIONSHIPS_INVALID');
      }),
    });
    const linked = (photoFiles.get(id) ?? []).map((link) => {
      const fileId = key(link.file_id);
      if (!sourceFiles.has(fileId)) return refuse('LIBREPHOTOS_RELATIONSHIPS_INVALID');
      referenced.add(fileId);
      return fileId;
    });
    if (new Set(linked).size !== linked.length || !photo.mainFileId || !linked.includes(photo.mainFileId))
      return refuse('LIBREPHOTOS_PRIMARY_ORIGINAL_REQUIRED');
    const primary = classified.get(photo.mainFileId)!;
    if (primary.role !== 'original') return refuse('LIBREPHOTOS_PRIMARY_ORIGINAL_REQUIRED');
    const type = primary.kind === 'video' ? 'VIDEO' : 'IMAGE';
    if (
      (row.video === 1n) !== (type === 'VIDEO') ||
      linked.some((fileId) => {
        const file = classified.get(fileId)!;
        return file.role === 'original' && (file.kind === 'video') !== (type === 'VIDEO');
      })
    )
      return refuse('LIBREPHOTOS_MEDIA_RELATIONSHIP_REVIEW_REQUIRED');
    const fileIds = linked.map((fileId) => `file:${fileId}`);
    if (fileIds.filter((fileId) => proofs.get(fileId)!.role === 'sidecar').length > 1)
      return refuse('LIBREPHOTOS_SIDECAR_REVIEW_REQUIRED');
    const primaryId = `file:${photo.mainFileId}`;
    let takenAt = photo.metadata.takenAt;
    let fallback = false;
    if (!photo.localDateTime) {
      takenAt = proofs.get(primaryId)!.modifiedAt;
      fallback = true;
      loss('LIBREPHOTOS_CAPTURE_TIME_FALLBACK', id);
    } else if (!takenAt) {
      if (!Object.hasOwn(input.reviewedCaptureOffsets, id)) return refuse('LIBREPHOTOS_CAPTURE_OFFSET_REVIEW_REQUIRED');
      const offset = input.reviewedCaptureOffsets[id];
      if (!Number.isSafeInteger(offset) || Math.abs(offset) > 840) return refuse('LIBREPHOTOS_CAPTURE_OFFSET_INVALID');
      reviewed.add(id);
      const [seconds, fraction] = photo.localDateTime.split('.', 2);
      takenAt = new Date(Date.parse(seconds + 'Z') - offset * 60_000)
        .toISOString()
        .replace(/\.\d{3}Z$/u, () => (fraction ? `.${fraction}Z` : 'Z'));
      archive.push({
        table: 'frameleaf_capture_offset_review',
        value: { photo_id: id, offset_minutes: BigInt(offset) },
      });
    }
    if (
      photo.review.some(
        (code) =>
          ![
            'CAPTURE_TIME_UNKNOWN',
            'CAPTURE_OFFSET_UNKNOWN',
            'MANUAL_CAPTURE_RULE_MISMATCH',
            'PHOTO_METADATA_MISSING',
          ].includes(code),
      )
    )
      return refuse('LIBREPHOTOS_METADATA_REVIEW_REQUIRED');
    const { title, ...metadata } = photo.metadata;
    if (title) loss('LIBREPHOTOS_TITLE_ARCHIVED', id);
    const trashed = photo.state.inTrash || photo.state.removed;
    assets.push({
      id,
      ownerId: photo.ownerId,
      type,
      fileIds,
      primaryFileId: primaryId,
      ...(fallback ? {} : { localDateTime: photo.localDateTime }),
      fileModifiedAt: proofs.get(primaryId)!.modifiedAt,
      originalFileNames: Object.fromEntries(
        fileIds
          .filter((fileId) => proofs.get(fileId)!.role === 'original')
          .map((fileId) => [fileId, posix.basename(proofs.get(fileId)!.path)]),
      ),
      // Owner 2026-11-04: a hidden photo imports Locked.
      visibility: trashed ? 'trash' : photo.state.hidden ? 'locked' : photo.state.archived ? 'archive' : 'timeline',
      metadata: {
        ...metadata,
        takenAt,
        ...(fallback ? { timeZone: 'UTC' } : {}),
        latitude: metadata.latitude ?? null,
        longitude: metadata.longitude ?? null,
        ...(trashed ? { deletedAt: auditTime(row.trashed_at) } : {}),
      },
    });
  }
  if (
    referenced.size !== sourceFiles.size ||
    [photoFiles, photoTags, details, captions].some((records) => records.keys().some((id) => !photos.has(id)))
  )
    return refuse('LIBREPHOTOS_RELATIONSHIPS_INVALID');
  if (Object.keys(input.reviewedCaptureOffsets).some((id) => !reviewed.has(id)))
    return refuse('LIBREPHOTOS_CAPTURE_OFFSET_REVIEW_CHANGED');
  const byAsset = new Map(assets.map((asset) => [asset.id, asset]));
  const albums: ImportManifest['albums'] = [];
  const memberships = group('api_albumuser_photos', 'albumuser_id');
  const members = group('api_albumuser_shared_to', 'albumuser_id');
  const sourceAlbums = index('api_albumuser', 'id');
  if (memberships.keys().some((id) => !sourceAlbums.has(id))) return refuse('LIBREPHOTOS_RELATIONSHIPS_INVALID');
  for (const [id, row] of sourceAlbums) {
    const ownerId = key(row.owner_id);
    if (!owners.has(ownerId) || typeof row.title !== 'string') return refuse('LIBREPHOTOS_ALBUM_INVALID');
    const visibleTo = new Set(
      (members.get(id) ?? []).map((member) => {
        const userId = key(member.user_id);
        if (!owners.has(userId) || !['viewer', 'contributor'].includes(String(member.role)))
          return refuse('LIBREPHOTOS_ALBUM_ACCESS_REVIEW_REQUIRED');
        return userId;
      }),
    );
    const partitions = new Map<string, string[]>([[ownerId, []]]);
    let archivedMembership = false;
    for (const link of memberships.get(id) ?? []) {
      const asset = byAsset.get(key(link.photo_id));
      if (!asset) return refuse('LIBREPHOTOS_RELATIONSHIPS_INVALID');
      if (asset.ownerId !== ownerId && !visibleTo.has(asset.ownerId)) {
        archivedMembership = true;
        continue;
      }
      if (!partitions.has(asset.ownerId)) partitions.set(asset.ownerId, []);
      partitions.get(asset.ownerId)!.push(asset.id);
    }
    if (archivedMembership) loss('LIBREPHOTOS_PRIVATE_ALBUM_MEMBERSHIP_ARCHIVED', id);
    if (partitions.size > 1) loss('LIBREPHOTOS_ALBUM_PARTITIONED', id);
    for (const [partitionOwner, assetIds] of partitions)
      albums.push({
        id: partitionOwner === ownerId ? `album:${id}` : `album:${id}:owner:${partitionOwner}`,
        ownerId: partitionOwner,
        name: row.title,
        assetIds,
        members: [],
      });
  }
  const membershipsByStack = group('api_photo_stacks', 'photostack_id');
  const sourceStacks = index('api_photostack', 'id');
  const stackClaims = group('api_photo_stacks', 'photo_id');
  if (membershipsByStack.keys().some((id) => !sourceStacks.has(id)))
    return refuse('LIBREPHOTOS_STACK_RELATIONSHIPS_INVALID');
  const stacks: Manifest['stacks'] = [];
  for (const [id, row] of sourceStacks) {
    const ownerId = key(row.owner_id),
      primaryAssetId = key(row.primary_photo_id);
    const assetIds = (membershipsByStack.get(id) ?? []).map((link) => key(link.photo_id));
    if (
      !owners.has(ownerId) ||
      !assetIds.includes(primaryAssetId) ||
      assetIds.some((id) => byAsset.get(id)?.ownerId !== ownerId)
    )
      return refuse('LIBREPHOTOS_STACK_RELATIONSHIPS_INVALID');
    if (
      assetIds.length < 2 ||
      assetIds.some(
        (id) =>
          stackClaims.get(id)!.length > 1 || byAsset.get(id)!.visibility !== byAsset.get(primaryAssetId)!.visibility,
      )
    ) {
      loss('LIBREPHOTOS_STACK_ARCHIVED', id);
      continue;
    }
    stacks.push({ id, ownerId, primaryAssetId, assetIds });
  }
  const userSchema = z.object({
    id: z.bigint().positive(),
    username: z.string().min(1),
    first_name: z.string(),
    last_name: z.string(),
    is_active: z.union([z.literal(0n), z.literal(1n)]),
  });
  const users = owners
    .values()
    .map((row) => {
      const result = userSchema.safeParse(row);
      if (!result.success) return refuse('LIBREPHOTOS_OWNER_INVALID');
      const user = result.data;
      return {
        id: String(user.id),
        name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username,
      };
    })
    .toArray();
  return {
    manifest: parseImportManifest({
      format: 'frameleaf-library-import',
      version: 4,
      source: input.source,
      inventory: input.inventory,
      users,
      files: manifestFiles,
      assets,
      albums,
      stacks,
      losses,
    }),
    archive,
  };
}
