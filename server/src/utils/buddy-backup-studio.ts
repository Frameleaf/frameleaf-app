import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import type { CloudBackupRestoreFile } from 'src/services/cloud-backup-restore.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetLockReason, MediaOperationDestination, StorageFolder, StudioExportScope } from 'src/enum.js';
import { readBuddyAssetFidelity } from 'src/utils/buddy-backup-fidelity.js';
import { studioBundleSourceKeys } from 'src/utils/studio-bundle.js';
import { embeddedSubtitleSealOf, sealStudioEmbeddedSubtitles } from 'src/utils/studio-embedded-subtitles.js';
import {
  STUDIO_IMPORT_MAX_BYTES,
  STUDIO_IMPORT_MAX_PER_PROJECT,
  STUDIO_IMPORT_TEXT_LIMITS,
  scanStudioVector,
  sniffStudioImport,
  validateStudioImportText,
} from 'src/utils/studio-imports.js';
import { canonicalJson, checkStudioEnvelope, studioEnvelopeDigest } from 'src/utils/studio-project.js';
import {
  StudioResourceKind,
  type StudioResourceReference,
  checkNestedSequences,
  extractStudioResourceReferences,
  isStudioIdentifier,
  studioReferenceKey,
} from 'src/utils/studio-resources.js';
import { sealStudioSidecar, sidecarSealOf } from 'src/utils/studio-subtitle-sidecar.js';

const uuid = z.uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const json = z.record(z.string(), z.unknown());
const path = z
  .string()
  .max(4096)
  .refine((value) => isAbsolute(value) && !value.includes('\0'));
const date = z.string().transform((value, context) => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    context.addIssue({ code: 'custom', message: 'Invalid Studio date' });
    return z.NEVER;
  }
  return parsed.toISOString();
});
const bytes = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().refine(isStudioIdentifier);
const file = z.object({ role: z.string(), path, sha256: sha, size: bytes, mtime: z.string().nullable() });
const identity = { id: uuid, projectId: uuid, createdAt: date };
export const buddyStudioRevisionSchema = z.object({
  ...identity,
  revision: z.number().int().positive(),
  authorId: uuid.nullable(),
  envelope: json,
  digest: sha,
  graphBytes: bytes,
  summary: json,
  restoredFromRevision: z.number().int().positive().nullable(),
});
export const buddyStudioCommentSchema = z.object({
  ...identity,
  authorId: uuid,
  revision: z.number().int().nonnegative(),
  timeNum: z.string().regex(/^\d+$/),
  timeDen: z.string().regex(/^[1-9]\d*$/),
  text: z.string().max(100_000),
  resolvedAt: date.nullable(),
  resolvedById: uuid.nullable(),
  updatedAt: date,
});
export const buddyStudioImportSchema = z.object({
  ...identity,
  ownerId: uuid,
  contentType: z.string().max(255),
  checksum: sha,
  sizeBytes: bytes.refine((value) => value > 0 && value <= STUDIO_IMPORT_MAX_BYTES),
  path,
  fileName: z.string().min(1).max(255),
  externalReferences: z.number().int().nonnegative().nullable(),
});
export const buddyStudioGeneratedSchema = z.object({
  projectId: uuid,
  id: identifier,
  ownerId: uuid,
  createdAt: date,
  sourceRevision: z.number().int().positive(),
  producer: identifier,
  checksum: sha,
  path,
  derivedFrom: z.array(z.string().min(1).max(256)).min(1).max(10_000),
});
export const buddyStudioSourceSchema = z.object({
  sourceEpoch: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .nullable()
    .default(null),
  versionId: uuid,
  key: z.string().min(1).max(256),
  kind: z.enum(StudioResourceKind),
  resourceId: z.string().min(1).max(256),
  assetId: uuid.nullable(),
  ownerId: uuid.nullable(),
  checksum: z.string().max(256).nullable(),
  sourceAccess: z.enum(['owner', 'shared', 'project', 'deployment', 'graph']),
  locked: z.boolean().nullable(),
  lockReason: z.enum(AssetLockReason).nullable(),
  sensitive: z.boolean().nullable(),
});
export const buddyStudioExportSchema = z.object({
  ...identity,
  ownerId: uuid,
  revision: z.number().int().positive(),
  revisionDigest: sha,
  state: z.literal('published'),
  version: z.number().int().positive(),
  scope: z.enum(StudioExportScope),
  destination: z.enum(MediaOperationDestination),
  settings: json,
  engineDigest: z.string().nullable(),
  outputPath: path.nullable(),
  outputChecksum: z.preprocess(
    (value) => (typeof value === 'string' ? value.replace(/^\\x/, '') : value),
    sha.nullable(),
  ),
  outputSizeInBytes: bytes.nullable(),
  outputContentType: z.string().nullable(),
  subtitlePath: path.nullable().default(null),
  subtitleChecksum: z.preprocess(
    (value) => (typeof value === 'string' ? value.replace(/^\\x/, '') : value),
    sha.nullable().default(null),
  ),
  subtitleSizeInBytes: bytes.nullable().default(null),
  subtitleRemovedAt: date.nullable().default(null),
  resultAssetId: uuid.nullable(),
  privacy: json.nullable(),
  publishedAt: date.nullable(),
  sources: z.array(buddyStudioSourceSchema).max(10_000),
});
export const buddyStudioProjectSchema = z.object({
  version: z.literal(1),
  id: uuid,
  ownerId: uuid,
  name: z.string().min(1).max(1000),
  currentRevision: z.number().int().nonnegative(),
  createdAt: date,
  archivedAt: date.nullable(),
  thumbnailAssetId: uuid.nullable(),
  duplicatedFromId: uuid.nullable(),
  importedFromDigest: sha.nullable(),
  revisions: z.array(buddyStudioRevisionSchema).max(100_000),
  comments: z.array(buddyStudioCommentSchema).max(100_000),
  imports: z.array(buddyStudioImportSchema).max(STUDIO_IMPORT_MAX_PER_PROJECT),
  generated: z.array(buddyStudioGeneratedSchema).max(10_000),
  exports: z.array(buddyStudioExportSchema).max(100_000),
  files: z.array(file).max(100_000),
});
export const buddyStudioSchema = z.object({
  version: z.literal(1),
  projects: z.record(uuid, buddyStudioProjectSchema),
});
export type BuddyStudioProject = z.infer<typeof buddyStudioProjectSchema>;
export type BuddyStudioSnapshot = z.infer<typeof buddyStudioSchema>;

export const buddyStudioPaths = (project: BuddyStudioProject) => [
  ...project.imports.map((row) => row.path),
  ...project.generated.map((row) => row.path),
  ...project.exports.flatMap((row) => [row.outputPath, row.subtitlePath].filter((path): path is string => !!path)),
];

/** Studio documents are a library-level collection; an item or album never pulls unrelated projects into view. */
export const buddyStudioProjectIds = (manifest: BuddyManifest, scope: string): string[] =>
  scope === 'library' && manifest.studio ? Object.keys(buddyStudioSchema.parse(manifest.studio).projects).sort() : [];

/** Same archive resource walker, with the retained import aliases used by portable bundles. */
export const buddyStudioAssetIds = (manifest: BuddyManifest, project: BuddyStudioProject): string[] => {
  const ids = new Set<string>();
  const imports = new Set(project.imports.map((row) => row.id));
  const generated = new Set(project.generated.map((row) => row.id));
  const references = new Map<
    number,
    Map<string, Pick<StudioResourceReference, 'kind' | 'id' | 'family' | 'source' | 'lutSource' | 'inlineLines'>>
  >();
  const add = (reference: Pick<StudioResourceReference, 'kind' | 'id' | 'source' | 'lutSource' | 'inlineLines'>) => {
    const { kind, id } = reference;
    if (
      (kind === StudioResourceKind.LibraryAsset ||
        kind === StudioResourceKind.EditedMaster ||
        (kind === StudioResourceKind.Audio && reference.source === 'asset')) &&
      !imports.has(id)
    ) {
      if (manifest.library.assets[id]?.owner !== project.ownerId)
        throw new Error('Buddy Studio requires a captured owned source');
      if (kind === StudioResourceKind.EditedMaster && !readBuddyAssetFidelity(manifest, id)?.projection.length)
        throw new Error('Buddy Studio edited source is unavailable');
      ids.add(id);
    } else if (kind === StudioResourceKind.RestoredVersion) {
      const state = Object.values(manifest.assetFidelity ?? {}).find((state) =>
        state.restorations.some((row) => row.id === id),
      );
      if (
        !state ||
        state.ownerId !== project.ownerId ||
        !readBuddyAssetFidelity(manifest, state.assetId)?.restorations.some((row) => row.id === id)
      )
        throw new Error('Buddy Studio restoration source is unavailable');
      ids.add(state.assetId);
    } else if (
      kind === StudioResourceKind.ProjectImport ||
      kind === StudioResourceKind.VectorGraphic ||
      (kind === StudioResourceKind.Audio && reference.source === 'import') ||
      (kind === StudioResourceKind.Lut && reference.lutSource === 'import') ||
      (kind === StudioResourceKind.Captions && !reference.inlineLines)
    ) {
      if (!imports.has(id)) throw new Error('Buddy Studio import closure is incomplete');
    } else if (
      (kind === StudioResourceKind.GeneratedIntermediate ||
        (kind === StudioResourceKind.Audio && reference.source === 'generated')) &&
      !generated.has(id)
    )
      throw new Error('Buddy Studio generated resource closure is incomplete');
  };
  for (const revision of project.revisions) {
    const extracted = extractStudioResourceReferences(revision.envelope.graph);
    if (extracted.violations.length > 0 || checkNestedSequences(extracted.sequences).refused.length > 0)
      throw new Error('Buddy Studio graph dependencies are invalid');
    const inputs = [...extracted.references, ...studioBundleSourceKeys(revision.envelope.graph)];
    references.set(revision.revision, new Map(inputs.map((reference) => [studioReferenceKey(reference), reference])));
    for (const reference of inputs) add(reference);
  }
  for (const row of project.generated)
    for (const key of row.derivedFrom) {
      const declared = references.get(row.sourceRevision)?.get(key);
      if (declared) {
        add(declared);
        continue;
      }
      const separator = key.indexOf(':');
      const kind = key.slice(0, separator) as StudioResourceKind;
      const id = key.slice(separator + 1);
      // Match the normal resolver's implicit media lineage. Audio, LUT and preset keys need
      // their complete source/family declaration in this revision; never guess those fields.
      if (
        separator < 1 ||
        !isStudioIdentifier(id) ||
        ![
          StudioResourceKind.LibraryAsset,
          StudioResourceKind.EditedMaster,
          StudioResourceKind.RestoredVersion,
          StudioResourceKind.ProjectImport,
          StudioResourceKind.GeneratedIntermediate,
        ].includes(kind)
      )
        throw new Error('Buddy Studio generated provenance is invalid');
      add({ kind, id });
    }
  for (const exported of project.exports) {
    if (!exported.outputPath && !exported.resultAssetId) throw new Error('Buddy Studio export output is unavailable');
    for (const source of exported.sources) {
      if (source.sourceAccess === 'shared' || (source.ownerId && source.ownerId !== project.ownerId))
        throw new Error('Buddy Studio requires owned export inputs');
      if (source.assetId) add({ kind: StudioResourceKind.LibraryAsset, id: source.assetId });
    }
    if (exported.resultAssetId) add({ kind: StudioResourceKind.LibraryAsset, id: exported.resultAssetId });
  }
  if (project.thumbnailAssetId) add({ kind: StudioResourceKind.LibraryAsset, id: project.thumbnailAssetId });
  return [...ids].sort();
};

export const readBuddyStudioProject = (manifest: BuddyManifest, projectId: string): BuddyStudioProject => {
  const project = buddyStudioProjectSchema.parse(manifest.studio?.projects[projectId]);
  if (project.id !== projectId) throw new Error('Buddy Studio project identity changed');
  if (project.duplicatedFromId && manifest.studio?.projects[project.duplicatedFromId]?.ownerId !== project.ownerId)
    throw new Error('Buddy Studio project lineage is unavailable');
  for (const rows of [project.revisions, project.comments, project.imports, project.generated, project.exports]) {
    if (new Set(rows.map((row) => row.id)).size !== rows.length || rows.some((row) => row.projectId !== projectId))
      throw new Error('Buddy Studio child identity changed');
  }
  if ([...project.imports, ...project.generated, ...project.exports].some((row) => row.ownerId !== project.ownerId))
    throw new Error('Buddy Studio resource ownership changed');
  const revisions = new Map(project.revisions.map((row) => [row.revision, row]));
  let latestRevision = 0;
  for (const row of project.revisions) {
    latestRevision = Math.max(latestRevision, row.revision);
  }
  if (revisions.size !== project.revisions.length || project.currentRevision !== latestRevision)
    throw new Error('Buddy Studio head is unavailable');
  for (const revision of project.revisions) {
    const checked = checkStudioEnvelope(revision.envelope);
    if (
      !checked.ok ||
      checked.graphBytes !== revision.graphBytes ||
      studioEnvelopeDigest(checked.envelope) !== revision.digest ||
      (revision.restoredFromRevision !== null && !revisions.has(revision.restoredFromRevision))
    )
      throw new Error('Buddy Studio revision envelope changed');
  }
  if (
    project.comments.some((row) => row.revision !== 0 && !revisions.has(row.revision)) ||
    project.generated.some((row) => !revisions.has(row.sourceRevision))
  )
    throw new Error('Buddy Studio revision dependency is unavailable');
  const files = new Map(project.files.map((file) => [file.path, file]));
  const needed = new Set(buddyStudioPaths(project));
  if (files.size !== project.files.length || files.size !== needed.size || [...needed].some((path) => !files.has(path)))
    throw new Error('Buddy Studio retained file closure is incomplete');
  for (const file of project.files)
    if (manifest.contents[file.sha256]?.bytes !== file.size)
      throw new Error('Buddy Studio retained content is unavailable');
  for (const row of [...project.imports, ...project.generated])
    if (
      files.get(row.path)?.sha256 !== row.checksum ||
      ('sizeBytes' in row && files.get(row.path)?.size !== row.sizeBytes)
    )
      throw new Error('Buddy Studio retained resource binding changed');
  for (const row of project.exports) {
    const embedded = embeddedSubtitleSealOf(row.settings);
    if (embedded) {
      const revision = revisions.get(row.revision)!;
      const derived = sealStudioEmbeddedSubtitles(
        revision.envelope.graph as Record<string, unknown>,
        {
          revisionDigest: row.revisionDigest,
          manifestDigest: embedded.source.manifestDigest,
          engineDigest: embedded.source.engineDigest,
        },
        { inPoint: embedded.source.inPoint, outPoint: embedded.source.outPoint },
      );
      if (canonicalJson(derived) !== canonicalJson(embedded) || row.engineDigest !== embedded.source.engineDigest)
        throw new Error('Buddy embedded subtitle authority changed');
    }
    const seal = sidecarSealOf(row.settings);
    if (seal) {
      const revision = revisions.get(row.revision)!;
      const derived = sealStudioSidecar(
        revision.envelope.graph as Record<string, unknown>,
        { revisionDigest: row.revisionDigest, manifestDigest: seal.manifestDigest, engineDigest: seal.engineDigest },
        { inPoint: seal.inPoint, outPoint: seal.outPoint },
      );
      if (
        canonicalJson(derived) !== canonicalJson(seal) ||
        row.engineDigest !== seal.engineDigest ||
        !row.subtitlePath ||
        row.subtitleRemovedAt ||
        row.subtitleChecksum !== seal.expectedSrtSha256 ||
        String(row.subtitleSizeInBytes) !== seal.sizeInBytes ||
        files.get(row.subtitlePath)?.sha256 !== seal.expectedSrtSha256 ||
        String(files.get(row.subtitlePath)?.size) !== seal.sizeInBytes ||
        row.sources.some((source) => source.assetId && (!source.ownerId || source.sourceEpoch === null))
      )
        throw new Error('Buddy Studio required subtitle binding changed');
    } else if (row.subtitlePath || row.subtitleChecksum || row.subtitleSizeInBytes !== null || row.subtitleRemovedAt)
      throw new Error('Buddy Studio unexpected subtitle binding');
    if (
      revisions.get(row.revision)?.digest !== row.revisionDigest ||
      row.sources.some((source) => source.versionId !== row.id) ||
      new Set(row.sources.map((source) => source.key)).size !== row.sources.length ||
      (row.resultAssetId &&
        (manifest.library.assets[row.resultAssetId]?.files.find((file) => file.role === 'original')?.sha256 !==
          row.outputChecksum ||
          manifest.library.assets[row.resultAssetId]?.files.find((file) => file.role === 'original')?.size !==
            row.outputSizeInBytes)) ||
      (row.outputPath &&
        (files.get(row.outputPath)?.sha256 !== row.outputChecksum ||
          files.get(row.outputPath)?.size !== row.outputSizeInBytes))
    )
      throw new Error('Buddy Studio export binding changed');
  }
  buddyStudioAssetIds(manifest, project);
  return project;
};

export const buddyStudioFiles = (manifest: BuddyManifest, projectId: string): CloudBackupRestoreFile[] => {
  const project = readBuddyStudioProject(manifest, projectId);
  const root = join(
    StorageCore.getFolderLocation(StorageFolder.Exports, project.ownerId),
    'buddy-projects',
    project.id,
    uuid.parse(manifest.snapshotId),
  );
  return project.files.map((file, index) => ({
    fileKey: `~studio:${project.id}:${String(index).padStart(6, '0')}`,
    assetId: null,
    role: 'buddy-studio',
    sha256: file.sha256,
    size: file.size,
    inPlace: true,
    target: join(
      root,
      `${createHash('sha256').update(file.path).digest('hex')}${extname(file.path).replaceAll(/[^a-zA-Z0-9.]/g, '')}`,
    ),
  }));
};

/** Reuse the complete upload validators: a valid header never excuses a malformed later caption/LUT/vector. */
export const validateBuddyStudioImport = async (item: BuddyStudioProject['imports'][number], target: string) => {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== item.sizeBytes) throw new Error('Buddy Studio import size changed');
    const head = Buffer.alloc(Math.min(1024, stat.size));
    await handle.read(head, 0, head.length, 0);
    const type = sniffStudioImport(head, item.contentType);
    if (type.contentType !== item.contentType) throw new Error('Buddy Studio import type changed');
    const limit = STUDIO_IMPORT_TEXT_LIMITS[type.kind];
    if (limit) {
      if (stat.size > limit.maxBytes) throw new Error('Buddy Studio text import is too large');
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) throw new Error('Buddy Studio import changed');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      const external = scanStudioVector(type, text) ?? null;
      if (external !== item.externalReferences || (external !== null && external !== 0))
        throw new Error('Buddy Studio import contains external resources');
      validateStudioImportText(type, text);
    }
  } finally {
    await handle.close();
  }
};
