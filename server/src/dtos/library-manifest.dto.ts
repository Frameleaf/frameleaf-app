import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetAnnotationItemsSchema } from 'src/dtos/asset-annotation.dto.js';
import { BookmarkCreateDto, CaptureSourceDto } from 'src/dtos/bookmark.dto.js';
import { AlbumKind, AlbumKindSchema, LibraryScopeSchema } from 'src/enum.js';

const ids = z.array(z.uuidv4()).max(10_000);
const source = CaptureSourceDto.schema.strict();
const album = z.strictObject({
  id: z.uuidv4(),
  parentId: z.uuidv4().nullable(),
  albumName: z.string().max(2000),
  description: z.string().max(20_000).nullable(),
  kind: AlbumKindSchema,
  libraryScope: LibraryScopeSchema,
  icon: z.string().max(128).nullable().optional(),
  sortOrder: z.number().finite().nullable().optional(),
});
const tag = z.strictObject({
  id: z.uuidv4(),
  parentId: z.uuidv4().nullable(),
  value: z.string().max(4096),
  color: z.string().max(64).nullable().optional(),
});
const membership = { id: z.uuidv4(), albumIds: ids, tagIds: ids };
const checksum = z.discriminatedUnion('algorithm', [
  z.strictObject({ algorithm: z.literal('sha1'), value: z.string().regex(/^[a-f0-9]{40}$/) }),
  z.strictObject({ algorithm: z.literal('sha256'), value: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
const asset = z.strictObject({
  ...membership,
  file: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) =>
        !value.startsWith('/') &&
        !/^[a-z]:/i.test(value) &&
        !/[\\\p{Cc}]/u.test(value) &&
        value.split('/').every((segment) => segment !== '..' && segment !== '.' && segment !== ''),
      'Expected a relative archive entry',
    ),
  checksum,
  libraryScope: LibraryScopeSchema,
  description: z.string().max(20_000).optional(),
  rating: BookmarkCreateDto.schema.shape.rating,
  isFavorite: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  isLocked: z.boolean().optional(),
  sources: z.array(source).max(10_000).optional(),
  /** FL-652: Boards annotations drawn over the picture, in list order; positions are fractions (0..1). */
  annotations: AssetAnnotationItemsSchema.optional(),
});
const bookmark = BookmarkCreateDto.schema
  .extend({
    ...membership,
    source: source.nullable().optional(),
  })
  .strict();

/** Inventory references must form a complete, safe graph. */
const hierarchy = (
  rows: { id: string; parentId: string | null }[],
  path: string,
  context: z.RefinementCtx,
  maximumDepth = Infinity,
) => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<string, string[]>();
  const queue: [string, number][] = [];
  if (byId.size !== rows.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate IDs', path: [path] });
    return;
  }
  for (const row of rows) {
    if (row.parentId === null) queue.push([row.id, 1]);
    else {
      if (!byId.has(row.parentId)) context.addIssue({ code: 'custom', message: 'Unknown parent', path: [path] });
      const siblings = children.get(row.parentId) ?? [];
      siblings.push(row.id);
      children.set(row.parentId, siblings);
    }
  }
  let visited = 0;
  for (let index = 0; index < queue.length; index++) {
    const [id, depth] = queue[index];
    visited++;
    if (depth > maximumDepth)
      context.addIssue({ code: 'custom', message: 'Hierarchy exceeds maximum depth', path: [path] });
    for (const child of children.get(id) ?? []) queue.push([child, depth + 1]);
  }
  if (visited !== rows.length)
    context.addIssue({ code: 'custom', message: 'Cyclic or incomplete hierarchy', path: [path] });
};

export class LibraryManifestDto extends createZodDto(
  z
    .strictObject({
      version: z.literal(1),
      albums: z.array(album).max(10_000),
      tags: z.array(tag).max(10_000),
      assets: z.array(asset).max(10_000),
      bookmarks: z.array(bookmark).max(10_000),
      spaceAlbums: z
        .array(z.strictObject({ spaceId: z.uuidv4(), albumId: z.uuidv4() }))
        .max(10_000)
        .optional(),
    })
    .superRefine((manifest, context) => {
      hierarchy(manifest.albums, 'albums', context, 32);
      hierarchy(manifest.tags, 'tags', context);
      const albums = new Map(manifest.albums.map((row) => [row.id, row]));
      const tags = new Set(manifest.tags.map((row) => row.id));
      const assets = new Set(manifest.assets.map((row) => row.id));
      for (const [kind, rows] of [
        ['assets', manifest.assets],
        ['bookmarks', manifest.bookmarks],
      ] as const) {
        if (new Set(rows.map((row) => row.id)).size !== rows.length)
          context.addIssue({ code: 'custom', message: 'Duplicate IDs', path: [kind] });
        for (const row of rows) {
          if (row.albumIds.some((id) => !albums.has(id)) || row.tagIds.some((id) => !tags.has(id))) {
            context.addIssue({ code: 'custom', message: 'Unknown membership', path: [kind] });
          }
        }
      }
      for (const row of manifest.albums) {
        if (
          (row.kind === AlbumKind.Space && row.parentId !== null) ||
          (row.parentId && albums.get(row.parentId)?.kind === AlbumKind.Space)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Shared spaces are top-level links, not parents',
            path: ['albums'],
          });
        }
      }
      for (const row of manifest.bookmarks) {
        if (row.previewAssetId && !assets.has(row.previewAssetId))
          context.addIssue({ code: 'custom', message: 'Unknown preview', path: ['bookmarks'] });
      }
      for (const link of manifest.spaceAlbums ?? []) {
        if (albums.get(link.spaceId)?.kind !== AlbumKind.Space || albums.get(link.albumId)?.kind !== AlbumKind.Album) {
          context.addIssue({ code: 'custom', message: 'Invalid shared-space link', path: ['spaceAlbums'] });
        }
      }
    })
    .meta({ id: 'LibraryManifestDto' }),
) {}
