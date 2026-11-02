import { createHash } from 'node:crypto';
import { z } from 'zod';

export const sourceKinds = [
  'immich',
  'photoprism',
  'librephotos',
  'photoview',
  'piwigo',
  'lychee',
  'pigallery2',
  'ente',
  'nextcloud',
  'synology',
] as const;
export type SourceKind = (typeof sourceKinds)[number];
const id = z.string().min(1).max(1024);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const importFilePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes('\\') &&
      [...value].every((character) => character >= ' ') &&
      !value.startsWith('/') &&
      !/^[a-z]:/iu.test(value) &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Unsafe bundle path',
  );
const metadata = z.strictObject({
  title: z.string().optional(),
  description: z.string().optional(),
  takenAt: z.iso.datetime({ offset: true }).optional(),
  timeZone: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  rating: z.number().int().min(0).max(5).optional(),
  tags: z.array(z.string()).optional(),
  favorite: z.boolean().optional(),
  deletedAt: z.iso.datetime({ offset: true }).optional(),
});

const manifestSchema = z.strictObject({
  format: z.literal('frameleaf-library-import'),
  version: z.literal(1),
  source: z.strictObject({ kind: z.enum(sourceKinds), version: id, identity: id, revision: id, schemaSha256: sha256 }),
  inventory: z.strictObject({
    complete: z.literal(true),
    ownershipComplete: z.literal(true),
    privacyComplete: z.literal(true),
    writersStopped: z.literal(true),
    revisionBefore: id,
    revisionAfter: id,
  }),
  users: z.array(z.strictObject({ id, name: z.string() })),
  files: z.array(
    z.strictObject({
      id,
      path: importFilePathSchema,
      bytes: z.string().regex(/^(0|[1-9]\d*)$/),
      sha256,
      role: z.enum(['original', 'sidecar', 'companion']),
    }),
  ),
  assets: z.array(
    z.strictObject({
      id,
      ownerId: id,
      fileIds: z.array(id).min(1),
      visibility: z.enum(['timeline', 'archive', 'hidden', 'locked', 'trash']),
      metadata,
    }),
  ),
  albums: z.array(
    z.strictObject({
      id,
      ownerId: id,
      name: z.string(),
      assetIds: z.array(id),
      members: z.array(z.strictObject({ userId: id, role: z.enum(['viewer', 'editor']) })),
    }),
  ),
  losses: z.array(z.strictObject({ code: id, entityId: id.optional(), acknowledged: z.boolean() })),
});
export type ImportManifest = z.infer<typeof manifestSchema>;

/** This validates bundle structure; source adapters must independently establish inventory evidence. */
export const parseImportManifest = (input: unknown): ImportManifest => {
  const value = manifestSchema.parse(input);
  const fail = (reason: string): never => {
    throw new Error(`Library import refused: ${reason}`);
  };
  if (
    value.source.revision !== value.inventory.revisionBefore ||
    value.source.revision !== value.inventory.revisionAfter
  ) {
    fail('SOURCE_CHANGED_DURING_EXPORT');
  }
  const indexes = {
    users: new Set<string>(),
    files: new Set<string>(),
    assets: new Set<string>(),
    albums: new Set<string>(),
  };
  for (const key of ['users', 'files', 'assets', 'albums'] as const) {
    for (const row of value[key]) {
      if (indexes[key].has(row.id)) fail('DUPLICATE_SOURCE_ID');
      indexes[key].add(row.id);
    }
  }
  const files = new Map(value.files.map((file) => [file.id, file]));
  const paths = new Set<string>();
  for (const file of value.files) {
    if (paths.has(file.path)) fail('DUPLICATE_FILE_PATH');
    paths.add(file.path);
  }
  const assets = new Map(value.assets.map((asset) => [asset.id, asset]));
  for (const asset of value.assets) {
    if (!indexes.users.has(asset.ownerId)) fail('UNKNOWN_OWNER');
    if (new Set(asset.fileIds).size !== asset.fileIds.length) fail('DUPLICATE_FILE_REFERENCE');
    if (asset.fileIds.some((fileId) => !files.has(fileId))) fail('UNKNOWN_FILE');
    if (asset.fileIds.every((fileId) => files.get(fileId)?.role !== 'original')) fail('MISSING_ORIGINAL');
  }
  for (const album of value.albums) {
    if (!indexes.users.has(album.ownerId)) fail('UNKNOWN_OWNER');
    if (new Set(album.assetIds).size !== album.assetIds.length) fail('DUPLICATE_ALBUM_MEMBERSHIP');
    if (new Set(album.members.map((member) => member.userId)).size !== album.members.length)
      fail('DUPLICATE_ALBUM_MEMBER');
    for (const member of album.members) if (!indexes.users.has(member.userId)) fail('UNKNOWN_ALBUM_MEMBER');
    for (const assetId of album.assetIds) {
      const asset = assets.get(assetId);
      if (!asset) fail('UNKNOWN_ALBUM_ASSET');
      // Cross-owner inclusion requires a richer permission contract before it can be represented safely.
      if (asset!.ownerId !== album.ownerId) fail('CROSS_OWNER_ALBUM_REQUIRES_PERMISSION_REVIEW');
    }
  }
  return value;
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};
export const manifestFingerprint = (manifest: ImportManifest): string =>
  createHash('sha256')
    .update(canonicalJson(parseImportManifest(manifest)))
    .digest('hex');
