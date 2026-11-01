import { z } from 'zod';
import { importFilePathSchema } from 'src/library-import/manifest.js';
import { PhotoprismRow } from 'src/library-import/photoprism.js';

const flag = z.union([z.literal(0n), z.literal(1n)]).transform((value) => value === 1n);
const fileSchema = z.object({
  file_uid: z.string().min(1),
  photo_uid: z.string().min(1),
  photo_id: z.bigint(),
  file_name: importFilePathSchema,
  file_root: z.enum(['/', 'sidecar']),
  file_size: z.bigint().min(0n),
  file_primary: flag,
  file_sidecar: flag,
  file_missing: flag,
  file_watermark: flag,
});

/** Root '/' is PhotoPrism's originals storage identifier, never the host filesystem root. Hash bytes independently. */
export const classifyPhotoprismFile = (row: PhotoprismRow) => {
  const result = fileSchema.safeParse(row);
  if (!result.success) throw new Error('PhotoPrism source refused: PHOTOPRISM_FILE_INVALID');
  const file = result.data;
  const originalTree = file.file_root === '/';
  if (originalTree && file.file_missing) throw new Error('PhotoPrism source refused: PHOTOPRISM_ORIGINAL_MISSING');
  if (originalTree && file.file_watermark)
    throw new Error('PhotoPrism source refused: PHOTOPRISM_ORIGINAL_WATERMARKED');
  return {
    id: file.file_uid,
    photoId: file.photo_uid,
    sourcePhotoId: file.photo_id.toString(),
    storage: originalTree ? 'originals' : 'sidecar',
    path: file.file_name,
    bytes: file.file_size.toString(),
    primary: file.file_primary,
    role: originalTree ? (file.file_sidecar ? 'sidecar' : 'original') : undefined,
    archive: row,
  };
};
