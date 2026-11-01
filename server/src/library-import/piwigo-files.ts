import { z } from 'zod';
import { importFilePathSchema } from 'src/library-import/manifest.js';
import { type PiwigoRow } from 'src/library-import/piwigo-source.js';

const id = z.bigint().positive();
const imageSchema = z.object({ id, path: z.string() });
const formatSchema = z.array(z.object({ format_id: id, image_id: id, ext: z.string().regex(/^[a-zA-Z0-9]{1,255}$/u) }));
const refuse = (): never => {
  throw new Error('Piwigo source refused: PIWIGO_FILES_INVALID');
};

/** Local application-relative paths only; caller verifies storage containment, bytes, owners and download restrictions. */
export const resolvePiwigoOriginals = (image: PiwigoRow, formats: PiwigoRow[]) => {
  const parsedImage = imageSchema.safeParse(image);
  const parsedFormats = formatSchema.safeParse(formats);
  if (!parsedImage.success || !parsedFormats.success) return refuse();
  const source = parsedImage.data;
  const path = source.path.startsWith('./') ? source.path.slice(2) : source.path;
  if (
    !importFilePathSchema.safeParse(path).success ||
    /^[a-z][a-z0-9+.-]*:/iu.test(path) ||
    path.split('/').some((part) => ['_data', 'pwg_representative', 'pwg_format', 'pwg_high'].includes(part))
  )
    return refuse();
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (slash === -1 || dot <= slash + 1 || dot === path.length - 1) return refuse();
  const files = [{ imageId: String(source.id), formatId: null as string | null, path, role: 'original' as const }];
  const ids = new Set<bigint>();
  const paths = new Set<string>();
  for (const format of parsedFormats.data) {
    if (format.image_id !== source.id || ids.has(format.format_id)) return refuse();
    const formatPath = `${path.slice(0, slash + 1)}pwg_format/${path.slice(slash + 1, dot)}.${format.ext}`;
    if (!importFilePathSchema.safeParse(formatPath).success || paths.has(formatPath)) return refuse();
    ids.add(format.format_id);
    paths.add(formatPath);
    files.push({ imageId: String(source.id), formatId: String(format.format_id), path: formatPath, role: 'original' });
  }
  return files;
};
