import { z } from 'zod';
import { importFilePathSchema } from 'src/library-import/manifest.js';

const id = z.bigint().positive();
const sourceSchema = z.object({
  file: z.object({
    fileid: id,
    storage: id,
    path: importFilePathSchema,
    mimetype: id,
    size: z.bigint().nonnegative(),
    encrypted: z.literal(0n),
    permissions: z.bigint().nonnegative(),
  }),
  storage: z.object({ numeric_id: id, id: z.string().min(1), available: z.literal(1n) }),
  mount: z.object({
    storage_id: id,
    root_id: id,
    user_id: z.string().min(1),
    mount_point: z.string(),
    mount_id: z.null(),
    mount_provider_class: z.literal(String.raw`OC\Files\Mount\LocalHomeMountProvider`),
  }),
  root: z.object({ fileid: id, storage: id, path: z.literal(''), parent: z.literal(-1n), encrypted: z.literal(0n) }),
  owner: z.object({ uid: z.string().min(1) }),
  mimetype: z.object({ id, mimetype: z.string().regex(/^(image|video)\/[^/\s]+$/u) }),
});
const refuse = (): never => {
  throw new Error('Nextcloud source refused: NEXTCLOUD_ORIGINAL_INVALID');
};

/** Classifies qualified local home records; the caller binds storage roots and independently verifies bytes and containment. */
export const resolveNextcloudHomeOriginal = (input: unknown) => {
  const parsed = sourceSchema.safeParse(input);
  if (!parsed.success) return refuse();
  const { file, storage, mount, root, owner, mimetype } = parsed.data;
  if (
    file.storage !== storage.numeric_id ||
    mount.storage_id !== storage.numeric_id ||
    root.storage !== storage.numeric_id ||
    root.fileid !== mount.root_id ||
    mount.user_id !== owner.uid ||
    storage.id !== `home::${owner.uid}` ||
    mount.mount_point !== `/${owner.uid}/` ||
    file.mimetype !== mimetype.id ||
    !file.path.startsWith('files/') ||
    (file.permissions & 1n) === 0n
  )
    return refuse();
  return {
    fileId: String(file.fileid),
    ownerId: owner.uid,
    storageId: storage.id,
    storageKey: String(storage.numeric_id),
    path: file.path,
    bytes: String(file.size),
    mime: mimetype.mimetype,
    role: 'original' as const,
  };
};
