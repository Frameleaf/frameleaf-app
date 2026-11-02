import { z } from 'zod';
import { importFilePathSchema } from 'src/library-import/manifest.js';

const id = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => value.length < 19 || value <= '9223372036854775807');
const role = z.enum(['original', 'image', 'video']);
const recordSchema = z.object({
  ente: z.object({
    fileID: id,
    type: z.enum(['image', 'video', 'livePhoto']),
    component: role,
    components: z.array(
      z.object({
        role,
        path: importFilePathSchema.refine((value) => !value.includes('/') && !/^[a-z][a-z0-9+.-]*:/iu.test(value)),
        size: z.number().int().safe().nonnegative(),
        hash: z
          .string()
          .regex(/^[A-Za-z0-9+/]{86}==$/)
          .refine((value) => Buffer.from(value, 'base64').toString('base64') === value),
      }),
    ),
  }),
});
const inventorySchema = z.object({
  id,
  ownerId: id,
  type: z.enum(['image', 'video', 'livephoto']),
  albumIds: z.array(id).min(1),
});
const albumSchema = z.object({ ente: z.object({ albumID: id, ownerID: id }) });
const refuse = (): never => {
  throw new Error('Ente source refused: ENTE_FILES_INVALID');
};

/** Joins portable sidecars to authenticated file inventory; caller proves complete exports, privacy and bytes. */
export const resolveEnteComponents = (record: unknown, inventory: unknown, albumRecord: unknown) => {
  const parsed = recordSchema.safeParse(record);
  const owner = inventorySchema.safeParse(inventory);
  const album = albumSchema.safeParse(albumRecord);
  if (!parsed.success || !owner.success || !album.success) return refuse();
  const source = parsed.data.ente;
  const evidence = owner.data;
  const live = source.type === 'livePhoto';
  if (
    source.fileID !== evidence.id ||
    (live ? evidence.type !== 'livephoto' : source.type !== evidence.type) ||
    !evidence.albumIds.includes(album.data.ente.albumID) ||
    new Set(evidence.albumIds).size !== evidence.albumIds.length ||
    source.components.length !== (live ? 2 : 1) ||
    new Set(source.components.map((entry) => entry.path)).size !== source.components.length ||
    new Set(source.components.map((entry) => entry.role)).size !== source.components.length ||
    source.components.every((entry) => entry.role !== source.component) ||
    source.components.some((entry) => (live ? entry.role === 'original' : entry.role !== 'original'))
  )
    return refuse();
  return source.components.map((entry) => ({
    albumId: album.data.ente.albumID,
    fileId: source.fileID,
    ownerId: evidence.ownerId,
    role: entry.role,
    path: entry.path,
    bytes: String(entry.size),
    sourceHash: entry.hash,
  }));
};
