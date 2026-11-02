import { z } from 'zod';
import { importFilePathSchema } from 'src/library-import/manifest.js';

const id = z.bigint().positive();
const component = importFilePathSchema.refine((value) => !value.includes('/'));
const fileSchema = z.object({
  id,
  directoryId: id,
  name: component,
  type: z.enum(['PhotoEntity', 'VideoEntity', 'FileEntity', 'MDFileEntity']),
  metadataFilesize: z.bigint().nonnegative().optional(),
});
const directorySchema = z.object({ id, name: z.string(), path: z.string(), parentId: id.nullable() });
const refuse = (): never => {
  throw new Error('PiGallery2 source refused: PIGALLERY2_FILES_INVALID');
};

/** Paths are relative to the verified Media.folder; caller checks containment, graph integrity, owners and actual bytes. */
export const resolvePigallery2File = (table: 'media_entity' | 'file_entity', row: unknown, directory: unknown) => {
  if (!['media_entity', 'file_entity'].includes(table)) return refuse();
  const parsedFile = fileSchema.safeParse(row);
  const parsedDirectory = directorySchema.safeParse(directory);
  if (!parsedFile.success || !parsedDirectory.success) return refuse();
  const source = parsedFile.data;
  const folder = parsedDirectory.data;
  if (source.directoryId !== folder.id) return refuse();
  const media = table === 'media_entity';
  if (
    media
      ? !['PhotoEntity', 'VideoEntity'].includes(source.type) || source.metadataFilesize === undefined
      : !['FileEntity', 'MDFileEntity'].includes(source.type)
  )
    return refuse();
  let prefix = '';
  if (folder.path !== './') {
    if (!folder.path.endsWith('/')) return refuse();
    prefix = folder.path.slice(0, -1);
    if (!importFilePathSchema.safeParse(prefix).success) return refuse();
  }
  if (folder.name === '.') {
    if (prefix !== '' || folder.parentId !== null) return refuse();
  } else {
    if (!component.safeParse(folder.name).success) return refuse();
    prefix = prefix === '' ? folder.name : `${prefix}/${folder.name}`;
  }
  const path = prefix === '' ? source.name : `${prefix}/${source.name}`;
  if (!importFilePathSchema.safeParse(path).success) return refuse();
  return {
    id: `${table}:${source.id}`,
    directoryId: String(folder.id),
    path,
    bytes: media ? String(source.metadataFilesize) : null,
    role: media ? ('original' as const) : ('sidecar' as const),
  };
};
