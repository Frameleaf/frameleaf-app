import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import { z } from 'zod';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import type { CloudBackupRestoreFile } from 'src/services/cloud-backup-restore.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType, AssetType, ChecksumAlgorithm, StorageFolder } from 'src/enum.js';
import { EDITED_MASTER_LINEAGE_SUFFIX, getEditedMasterLineagePath } from 'src/utils/media-policy.js';

const uuid = z.uuid();
const hex = z.preprocess(
  (value) => (typeof value === 'string' ? value.replace(/^\\x/, '') : value),
  z.string().regex(/^(?:[a-f0-9]{2}){1,128}$/),
);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().transform((value, ctx) => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'Invalid version date' });
    return z.NEVER;
  }
  return parsed.toISOString();
});
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'));
const json = z.record(z.string(), z.unknown());
const edits = z.array(z.object({ action: z.string().min(1), parameters: json })).max(10_000);
const identity = { id: uuid, assetId: uuid, ownerId: uuid, createdAt: date };
const projection = z.object({
  path,
  type: z.enum(AssetFileType),
  isEdited: z.literal(true),
  isProgressive: z.boolean(),
  isTransparent: z.boolean(),
});
export const buddyVideoVersionSchema = z.object({
  ...identity,
  sourcePath: path,
  sourceChecksum: hex,
  recipe: edits,
  purpose: z.enum(['save', 'export', 'revert']),
  status: z.enum(['pending', 'ready', 'failed']),
  masterPath: path.nullable(),
  proxyPath: path.nullable(),
  files: z.array(projection).max(100),
});
export const buddyDevelopRevisionSchema = z.object({
  ...identity,
  revision: z.number().int().positive(),
  recipeVersion: z.number().int().positive(),
  recipe: json,
  label: z.string().nullable(),
  status: z.enum(['saved', 'queued', 'rendering', 'rendered', 'failed', 'cancelled']),
  rendererVersion: z.string().nullable(),
  masterPath: path.nullable(),
  previewPath: path.nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  isCurrent: z.boolean(),
  kind: z.enum(['recipe', 'external']),
  sourceChecksum: hex.nullable(),
  renditionChecksum: hex.nullable(),
  exportId: uuid.nullable(),
  fileName: z.string().nullable(),
  software: z.string().nullable(),
  renderedAt: date.nullable(),
});
export const buddyArtifactSchema = z.object({
  assetId: uuid,
  id: sha256,
  ownerId: uuid,
  kind: z.enum(['mask', 'fill']),
  path,
  bytes: z.coerce.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  createdAt: date,
});
export const buddyDevelopExportSchema = z.object({ ...identity, sourceChecksum: hex, fileName: z.string() });
export const buddyRestorationSchema = z.object({
  ...identity,
  revision: z.number().int().positive(),
  status: z.literal('restored'),
  mode: z.string(),
  upscale: z.number().int(),
  keepGrain: z.boolean(),
  workload: z.string(),
  destinationKind: z.string(),
  destinationName: z.string(),
  sourceType: z.enum(['image', 'video']),
  sourceChecksum: hex,
  sourceWidth: z.number().int(),
  sourceHeight: z.number().int(),
  sourceDurationSeconds: z.number().nullable(),
  previewRegion: json,
  resultPath: path,
  resultPreviewPath: path.nullable(),
  outputWidth: z.number().int().nullable(),
  outputHeight: z.number().int().nullable(),
  modelName: z.string().nullable(),
  modelVersion: z.string().nullable(),
  provenance: json,
  isCurrent: z.boolean(),
  reviewedAt: date.nullable(),
  restoredAt: date.nullable(),
});
const file = z.object({ role: z.string(), path, sha256, size: z.number().int().nonnegative(), mtime: date.nullable() });

/** Buddy-only, JSON-safe records. Claims, jobs, destinations and expiring previews are never replayed. */
export const buddyAssetFidelitySchema = z.object({
  version: z.literal(1),
  assetId: uuid,
  ownerId: uuid,
  source: z.object({ checksum: hex, checksumAlgorithm: z.enum(ChecksumAlgorithm), sha256, type: z.enum(AssetType) }),
  videoVersions: z.array(buddyVideoVersionSchema).max(10_000),
  videoSelection: z.object({ requestedVersionId: uuid.nullable(), currentVersionId: uuid.nullable() }).nullable(),
  edits,
  developRevisions: z.array(buddyDevelopRevisionSchema).max(10_000),
  artifacts: z.array(buddyArtifactSchema).max(64),
  developExports: z.array(buddyDevelopExportSchema).max(10_000),
  restorations: z.array(buddyRestorationSchema).max(10_000),
  projection: z.array(projection).max(100),
  files: z.array(file).max(100_000),
});
export type BuddyAssetFidelity = z.infer<typeof buddyAssetFidelitySchema>;

export const buddyFidelityPaths = (state: BuddyAssetFidelity) =>
  [
    ...state.videoVersions.flatMap((row) => [row.masterPath, row.proxyPath, ...row.files.map((file) => file.path)]),
    ...state.developRevisions.flatMap((row) => [row.masterPath, row.previewPath]),
    ...state.artifacts.map((row) => row.path),
    ...state.restorations.flatMap((row) => [row.resultPath, row.resultPreviewPath]),
    ...state.projection.map((row) => row.path),
  ].filter((value): value is string => !!value);

export const readBuddyAssetFidelity = (manifest: BuddyManifest, assetId: string): BuddyAssetFidelity | null => {
  if (!manifest.assetFidelity) return null; // Earlier snapshots retain their original restore semantics.
  const state = buddyAssetFidelitySchema.parse(manifest.assetFidelity[assetId]);
  const asset = manifest.library.assets[assetId];
  if (
    state.assetId !== assetId ||
    state.ownerId !== asset?.owner ||
    state.source.sha256 !== asset.files.find((file) => file.role === 'original')?.sha256
  )
    throw new Error('Buddy version source binding changed');
  if (
    state.source.checksum.length !== (state.source.checksumAlgorithm === ChecksumAlgorithm.sha256File ? 64 : 40) ||
    (state.source.checksumAlgorithm === ChecksumAlgorithm.sha256File && state.source.checksum !== state.source.sha256)
  )
    throw new Error('Buddy version checksum binding changed');
  for (const row of [
    ...state.videoVersions,
    ...state.developRevisions,
    ...state.artifacts,
    ...state.developExports,
    ...state.restorations,
  ]) {
    if (row.assetId !== assetId || row.ownerId !== state.ownerId) throw new Error('Buddy version ownership changed');
  }
  const files = new Map(state.files.map((file) => [file.path, file]));
  const required = new Set(buddyFidelityPaths(state));
  const allowed = new Set([...required, ...[...required].map((path) => getEditedMasterLineagePath(path))]);
  if (
    files.size !== state.files.length ||
    [...required].some((path) => !files.has(path)) ||
    files.keys().some((path) => !allowed.has(path))
  )
    throw new Error('Buddy version file closure is incomplete');
  for (const file of files.values()) {
    if (manifest.contents[file.sha256]?.bytes !== file.size) throw new Error('Buddy version content is unavailable');
  }
  for (const id of [state.videoSelection?.currentVersionId, state.videoSelection?.requestedVersionId]) {
    if (id && state.videoVersions.every((row) => row.id !== id))
      throw new Error('Buddy video selection is unavailable');
  }
  for (const rows of [
    state.videoVersions,
    state.developRevisions,
    state.artifacts,
    state.developExports,
    state.restorations,
  ])
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('Duplicate Buddy version identity');
  for (const rows of [state.developRevisions, state.restorations])
    if (rows.filter((row) => row.isCurrent).length > 1) throw new Error('Ambiguous Buddy version selection');
  for (const artifact of state.artifacts)
    if (files.get(artifact.path)?.sha256 !== artifact.id || files.get(artifact.path)?.size !== artifact.bytes)
      throw new Error('Buddy develop artifact binding changed');
  for (const revision of state.developRevisions) {
    if (
      revision.renditionChecksum &&
      revision.masterPath &&
      files.get(revision.masterPath)?.sha256 !== revision.renditionChecksum
    )
      throw new Error('Buddy develop rendition binding changed');
    if (revision.exportId && state.developExports.every((row) => row.id !== revision.exportId))
      throw new Error('Buddy develop export is unavailable');
    // Disabled masks and cleanup operations remain editable after restore, so their artifacts
    // belong to the closure too. Render-only dependency helpers intentionally omit those.
    for (const [list, field, kind] of [
      [revision.recipe.masks, 'artifact', 'mask'],
      [revision.recipe.cleanup, 'fill', 'fill'],
    ] as const) {
      for (const item of Array.isArray(list) ? list : []) {
        const id: unknown = item && typeof item === 'object' ? item[field] : undefined;
        if (
          id !== undefined &&
          id !== null &&
          state.artifacts.every((artifact) => !(artifact.id === id && artifact.kind === kind))
        )
          throw new Error('Buddy develop recipe artifact closure is incomplete');
      }
    }
  }
  return state;
};

/** Preserve an unchanged canonical identity so versions saved after the snapshot remain usable. */
export const buddyRestoreChecksum = (
  state: BuddyAssetFidelity | null,
  current: { checksum: Buffer; checksumAlgorithm: ChecksumAlgorithm },
  sha256: string,
) =>
  state?.source.sha256 === sha256 &&
  state.source.checksum === current.checksum.toString('hex') &&
  state.source.checksumAlgorithm === current.checksumAlgorithm
    ? current
    : { checksum: Buffer.from(sha256, 'hex'), checksumAlgorithm: ChecksumAlgorithm.sha256File };

/** Copy retained versions privately; a scoped restore never overwrites a live version's shared path. */
export const buddyFidelityFiles = (manifest: BuddyManifest, assetId: string): CloudBackupRestoreFile[] => {
  const state = readBuddyAssetFidelity(manifest, assetId);
  if (!state) return [];
  const directory = join(
    StorageCore.getNestedFolder(StorageFolder.Thumbnails, state.ownerId, assetId),
    assetId,
    'buddy-versions',
    uuid.parse(manifest.snapshotId),
  );
  const target = (path: string): string => {
    if (path.endsWith(EDITED_MASTER_LINEAGE_SUFFIX)) {
      const master = path.slice(0, -EDITED_MASTER_LINEAGE_SUFFIX.length);
      if (state.files.every((file) => file.path !== master)) throw new Error('Buddy lineage master is unavailable');
      return getEditedMasterLineagePath(target(master));
    }
    return join(
      directory,
      `${createHash('sha256').update(path).digest('hex')}${extname(path).replaceAll(/[^a-zA-Z0-9.]/g, '')}`,
    );
  };
  return state.files.map((file, index) => ({
    fileKey: `${assetId}:version:${String(index).padStart(6, '0')}`,
    assetId,
    role: 'buddy-version',
    sha256: file.sha256,
    size: file.size,
    target: target(file.path),
    inPlace: true,
  }));
};
