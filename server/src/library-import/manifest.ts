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
export const importTimestampSchema = z.iso.datetime({ offset: true }).refine((value) => !/\.\d{7}/.test(value));
export const importOriginalFileNameSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.includes('/') &&
      !value.includes('\\') &&
      [...value].every((character) => character >= ' ') &&
      value !== '.' &&
      value !== '..',
  );
const metadata = z
  .strictObject({
    title: z.string().optional(),
    description: z.string().optional(),
    takenAt: z.iso.datetime({ offset: true }).optional(),
    timeZone: z.string().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    rating: z.number().int().min(0).max(5).nullable().optional(),
    tags: z.array(z.string()).optional(),
    favorite: z.boolean().optional(),
    deletedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine(
    ({ latitude, longitude }) => (latitude === null) === (longitude === null),
    'Cleared coordinates must be paired',
  );

const legacyManifestSchema = z.strictObject({
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
      /** A Locked item that is also archived returns to the Archive when unlocked. */
      archived: z.literal(true).optional(),
      /** FL-1230: a private item in the source's Trash imports both trashed and Locked. */
      locked: z.literal(true).optional(),
      metadata,
    }),
  ),
  albums: z.array(
    z.strictObject({
      id,
      ownerId: id,
      name: z.string(),
      description: z.string().optional(),
      assetIds: z.array(id),
      members: z.array(z.strictObject({ userId: id, role: z.enum(['viewer', 'editor']) })),
    }),
  ),
  losses: z.array(z.strictObject({ code: id, entityId: id.optional(), acknowledged: z.boolean() })),
});
export const importFileSchema = legacyManifestSchema.shape.files.element;
const sealedManifestSchema = legacyManifestSchema.extend({
  version: z.literal(3),
  assets: z.array(
    legacyManifestSchema.shape.assets.element
      .extend({
        primaryFileId: id,
        localDateTime: z
          .string()
          .refine((value) => importTimestampSchema.safeParse(value + 'Z').success)
          .optional(),
        type: z.enum(['IMAGE', 'VIDEO']),
        fileModifiedAt: importTimestampSchema,
        originalFileNames: z
          .record(id, importOriginalFileNameSchema)
          .transform((names) =>
            Object.fromEntries(Object.entries(names).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
          ),
      })
      .refine(
        (asset) => asset.localDateTime === undefined || asset.metadata.timeZone === undefined,
        'Source wall clock and named time zone are alternatives',
      ),
  ),
});
const stackedManifestSchema = sealedManifestSchema.extend({
  version: z.literal(4),
  stacks: z.array(z.strictObject({ id, ownerId: id, primaryAssetId: id, assetIds: z.array(id).min(2) })),
});
const manifestSchema = z.discriminatedUnion('version', [
  legacyManifestSchema,
  legacyManifestSchema.extend({
    version: z.literal(2),
    assets: z.array(legacyManifestSchema.shape.assets.element.extend({ primaryFileId: id })),
  }),
  sealedManifestSchema,
  stackedManifestSchema,
  stackedManifestSchema.extend({
    version: z.literal(5),
    livePhotos: z.array(z.strictObject({ photoAssetId: id, videoAssetId: id })),
  }),
]);
export type ImportManifest = z.infer<typeof manifestSchema>;
/** The stored `asset.visibility`: Trash is a status and Locked an `asset_lock` row (FL-34), neither a visibility. */
export const storedVisibility = ({
  visibility,
  archived,
}: Pick<ImportManifest['assets'][number], 'visibility' | 'archived'>) =>
  visibility === 'locked' && archived
    ? 'archive'
    : visibility === 'trash' || visibility === 'locked'
      ? 'timeline'
      : visibility;

/** Whether the item imports Locked (an `asset_lock` row): a source's private item, in its Trash or not. */
export const importsLocked = ({
  visibility,
  locked,
}: Pick<ImportManifest['assets'][number], 'visibility' | 'locked'>) => visibility === 'locked' || locked === true;

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
  const referencedFiles = new Set<string>();
  for (const asset of value.assets) {
    if (!indexes.users.has(asset.ownerId)) fail('UNKNOWN_OWNER');
    if (asset.archived && asset.visibility !== 'locked') fail('ASSET_ARCHIVED_REQUIRES_LOCKED');
    if (asset.locked && asset.visibility !== 'trash') fail('ASSET_LOCKED_REQUIRES_TRASH');
    if (new Set(asset.fileIds).size !== asset.fileIds.length) fail('DUPLICATE_FILE_REFERENCE');
    if (asset.fileIds.some((fileId) => !files.has(fileId))) fail('UNKNOWN_FILE');
    const originals = asset.fileIds.filter((fileId) => files.get(fileId)?.role === 'original');
    if (originals.length === 0) fail('MISSING_ORIGINAL');
    if (
      'originalFileNames' in asset &&
      (Object.keys(asset.originalFileNames).length !== originals.length ||
        originals.some((id) => !Object.hasOwn(asset.originalFileNames, id)))
    )
      fail('ASSET_ORIGINAL_NAMES_INVALID');
    if ('primaryFileId' in asset) {
      if (!asset.fileIds.includes(asset.primaryFileId) || files.get(asset.primaryFileId)?.role !== 'original')
        fail('PRIMARY_ORIGINAL_INVALID');
    } else if (originals.length !== 1) {
      fail('PRIMARY_ORIGINAL_REQUIRED');
    }
    for (const fileId of asset.fileIds) referencedFiles.add(fileId);
  }
  if (value.files.some((file) => !referencedFiles.has(file.id))) fail('FILE_OWNER_RELATIONSHIP_REQUIRED');
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
  if (value.version === 4 || value.version === 5) {
    const grants = new Map<string, Map<string, 'viewer' | 'editor'>>();
    for (const album of value.albums) {
      for (const assetId of album.assetIds) {
        for (const member of album.members) {
          if (member.userId === album.ownerId) continue;
          let principals = grants.get(assetId);
          if (!principals) grants.set(assetId, (principals = new Map()));
          if (principals.get(member.userId) !== 'editor') principals.set(member.userId, member.role);
        }
      }
    }
    const access = (assetId: string) =>
      JSON.stringify([...(grants.get(assetId) ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const stackIds = new Set<string>(),
      claimed = new Set<string>();
    for (const stack of value.stacks) {
      if (stackIds.has(stack.id)) fail('DUPLICATE_SOURCE_ID');
      stackIds.add(stack.id);
      if (!indexes.users.has(stack.ownerId)) fail('STACK_OWNER_INVALID');
      if (new Set(stack.assetIds).size !== stack.assetIds.length || stack.assetIds.some((id) => !assets.has(id)))
        fail('STACK_ASSETS_INVALID');
      if (!stack.assetIds.includes(stack.primaryAssetId)) fail('STACK_PRIMARY_INVALID');
      if (stack.assetIds.some((id) => assets.get(id)!.ownerId !== stack.ownerId)) fail('STACK_OWNER_INVALID');
      const primary = assets.get(stack.primaryAssetId)!;
      const expectedAccess = access(primary.id);
      for (const assetId of stack.assetIds) {
        if (claimed.has(assetId)) fail('STACK_MEMBERSHIP_CONFLICT');
        claimed.add(assetId);
        const member = assets.get(assetId)!;
        if (
          member.visibility !== primary.visibility ||
          member.archived !== primary.archived ||
          member.locked !== primary.locked
        )
          fail('STACK_VISIBILITY_MISMATCH');
        if (access(assetId) !== expectedAccess) fail('STACK_ACCESS_MISMATCH');
      }
    }
  }
  if (value.version === 5) {
    const claimed = new Set<string>();
    for (const pair of value.livePhotos) {
      const photo = assets.get(pair.photoAssetId),
        video = assets.get(pair.videoAssetId);
      if (
        !photo ||
        !video ||
        !('type' in photo) ||
        !('type' in video) ||
        photo.type !== 'IMAGE' ||
        video.type !== 'VIDEO'
      )
        fail('LIVE_PHOTO_ASSETS_INVALID');
      if (claimed.has(pair.photoAssetId) || claimed.has(pair.videoAssetId)) fail('LIVE_PHOTO_MEMBERSHIP_CONFLICT');
      claimed.add(pair.photoAssetId);
      claimed.add(pair.videoAssetId);
      if (photo!.ownerId !== video!.ownerId) fail('LIVE_PHOTO_OWNER_INVALID');
      // A Locked photo locks its motion part too; the motion part stays hidden.
      if (
        photo!.visibility === 'trash' ||
        video!.visibility !== 'hidden' ||
        photo!.metadata.deletedAt !== undefined ||
        video!.metadata.deletedAt !== undefined
      )
        fail('LIVE_PHOTO_STATE_UNSUPPORTED');
      if (
        value.albums.some((album) => album.assetIds.includes(pair.videoAssetId)) ||
        value.stacks.some((stack) => stack.assetIds.includes(pair.videoAssetId))
      )
        fail('LIVE_PHOTO_MOTION_RELATIONSHIP_UNSUPPORTED');
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
