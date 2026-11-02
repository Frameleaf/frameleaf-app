import { z } from 'zod';
import { importFilePathSchema } from 'src/library-import/manifest.js';

const id = z.string().min(1);
const photoSchema = z.object({ id, live_photo_short_path: z.string().nullable() });
const variantSchema = z.array(
  z.object({
    id: z.bigint().positive(),
    photo_id: id,
    type: z.bigint().min(0n).max(8n),
    short_path: z.string(),
    storage_disk: z.string().nullable(),
    filesize: z.bigint().nonnegative(),
  }),
);
const refuse = (): never => {
  throw new Error('Lychee source refused: LYCHEE_FILES_INVALID');
};

/** Resolves local disk-relative source records; caller proves containment, original bytes and ownership independently. */
export const resolveLycheeOriginals = (photo: unknown, variants: unknown) => {
  const parsedPhoto = photoSchema.safeParse(photo);
  const parsedVariants = variantSchema.safeParse(variants);
  if (!parsedPhoto.success || !parsedVariants.success) return refuse();
  const source = parsedPhoto.data;
  const ids = new Set<bigint>();
  const types = new Set<bigint>();
  const paths = new Set<string>();
  const files: {
    photoId: string;
    variantId: string | null;
    storage: 'images';
    path: string;
    bytes: string | null;
    role: 'original' | 'companion';
  }[] = [];
  const addPath = (path: string) => {
    if (!importFilePathSchema.safeParse(path).success || /^[a-z][a-z0-9+.-]*:/iu.test(path) || paths.has(path))
      return refuse();
    paths.add(path);
  };
  for (const variant of parsedVariants.data) {
    if (variant.photo_id !== source.id || ids.has(variant.id) || types.has(variant.type)) return refuse();
    ids.add(variant.id);
    types.add(variant.type);
    if (variant.type > 1n) continue;
    if (variant.storage_disk !== 'images') return refuse();
    addPath(variant.short_path);
    files.push({
      photoId: source.id,
      variantId: String(variant.id),
      storage: 'images',
      path: variant.short_path,
      bytes: String(variant.filesize),
      role: 'original',
    });
  }
  if (files.length === 0) return refuse();
  if (source.live_photo_short_path) {
    if (!types.has(1n)) return refuse();
    addPath(source.live_photo_short_path);
    files.push({
      photoId: source.id,
      variantId: null,
      storage: 'images',
      path: source.live_photo_short_path,
      bytes: null,
      role: 'companion',
    });
  }
  return files;
};
