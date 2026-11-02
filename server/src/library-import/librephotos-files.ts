import { z } from 'zod';
import { LibrephotosRow } from 'src/library-import/librephotos.js';
import { importFilePathSchema } from 'src/library-import/manifest.js';

const id = z.string().min(1).max(64);
const flag = z.union([z.literal(0n), z.literal(1n)]);
const fileSchema = z.object({
  hash: id,
  path: z.string(),
  type: z.union([z.literal(1n), z.literal(2n), z.literal(3n), z.literal(4n)]),
  missing: flag,
});
const copySchema = z.object({ id: z.bigint().positive(), file_id: id, path: z.string() });
const refuse = (code: string): never => {
  throw new Error(`LibrePhotos source refused: ${code}`);
};

const relativeSourcePath = (path: string, root: string) => {
  if (!root.startsWith('/') || !importFilePathSchema.safeParse(root.slice(1)).success)
    refuse('LIBREPHOTOS_FILE_ROOT_INVALID');
  if (!path.startsWith('/') || !importFilePathSchema.safeParse(path.slice(1)).success || !path.startsWith(`${root}/`))
    refuse('LIBREPHOTOS_FILE_PATH_INVALID');
  const relative = path.slice(root.length + 1);
  if (!importFilePathSchema.safeParse(relative).success) refuse('LIBREPHOTOS_FILE_PATH_INVALID');
  return relative;
};

/** Maps recorded Linux paths only; the caller verifies mounted roots, bytes, links and every file relationship. */
export const classifyLibrephotosFile = (row: LibrephotosRow, sourceRoot: string, embeddedParentIds: string[]) => {
  const parsed = fileSchema.safeParse(row);
  if (!parsed.success) refuse('LIBREPHOTOS_FILE_INVALID');
  const file = parsed.data!;
  if (file.missing === 1n) refuse('LIBREPHOTOS_FILE_MISSING');
  if (
    !z.array(id).safeParse(embeddedParentIds).success ||
    new Set(embeddedParentIds).size !== embeddedParentIds.length ||
    embeddedParentIds.includes(file.hash) ||
    (embeddedParentIds.length > 0 && file.type !== 2n)
  )
    refuse('LIBREPHOTOS_COMPANION_INVALID');
  const kind = ({ '1': 'image', '2': 'video', '3': 'metadata', '4': 'raw' } as const)[
    String(file.type) as '1' | '2' | '3' | '4'
  ];
  return {
    id: file.hash,
    path: relativeSourcePath(file.path, sourceRoot),
    kind,
    role: embeddedParentIds.length > 0 ? 'companion' : file.type === 3n ? 'sidecar' : 'original',
    companionOf: [...embeddedParentIds],
    archive: row,
  };
};

export const normalizeLibrephotosFileCopy = (row: LibrephotosRow, sourceRoot: string) => {
  const parsed = copySchema.safeParse(row);
  if (!parsed.success) refuse('LIBREPHOTOS_FILE_COPY_INVALID');
  const copy = parsed.data!;
  return { id: copy.id.toString(), fileId: copy.file_id, path: relativeSourcePath(copy.path, sourceRoot) };
};
