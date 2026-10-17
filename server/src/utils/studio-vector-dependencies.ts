/** Immutable declarations are hints until independently matched to verified parent bytes. */
import { createHash } from 'node:crypto';
import z from 'zod';
// eslint-disable-next-line no-restricted-imports -- Shared pure parser must also load in the verified worker without server aliases.
import {
  STUDIO_IMPORT_VECTOR_MAX_BYTES,
  StudioImportRefusal,
  scanStudioLottie,
  scanStudioSvg,
  sniffStudioImport,
} from './studio-imports.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const jsonLocation = z
  .object({
    format: z.literal('lottie-json'),
    entry: z
      .string()
      .regex(/^(?!.*(?:\\|\/\/|(?:^|\/)\.\.?\/|\/$))[^/][^\\]*$/)
      .nullable(),
    pointer: z.string().regex(/^\/(?:assets\/(?:0|[1-9]\d*)\/p|fonts\/list\/(?:0|[1-9]\d*)\/fPath)$/),
    role: z.enum(['image', 'font']),
  })
  .strict()
  .refine((value) => value.pointer.startsWith('/assets/') === (value.role === 'image'));
const svgLocation = z
  .object({
    format: z.literal('svg'),
    elementPath: z.array(z.int().min(0)).max(64),
    attribute: z.object({ namespace: z.string().max(256), localName: z.string().regex(/^[A-Za-z][\w.-]*$/) }).strict(),
    role: z.enum(['image', 'font']),
  })
  .strict();
const bindingSchema = z
  .object({
    parent: z.object({ kind: z.enum(['project-import', 'vector-graphic']), id: uuid, checksum: sha }).strict(),
    location: z.union([jsonLocation, svgLocation]),
    child: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('project-import'), id: uuid, checksum: sha }).strict(),
      z.object({ kind: z.literal('library-asset'), id: uuid, checksum: sha }).strict(),
      z.object({ kind: z.literal('font'), id: z.string().regex(/^[\w .:-]{1,128}$/), checksum: sha }).strict(),
    ]),
  })
  .strict()
  .refine((value) => (value.location.role === 'font') === (value.child.kind === 'font'));
const declarationSchema = z.object({ version: z.literal(1), bindings: z.array(bindingSchema).max(10_000) }).strict();
export type StudioVectorBinding = z.infer<typeof bindingSchema>;
export type StudioVectorLocation = StudioVectorBinding['location'];
export const studioVectorLocationKey = (location: StudioVectorLocation): string =>
  location.format === 'lottie-json'
    ? JSON.stringify([location.format, location.entry, location.pointer, location.role])
    : JSON.stringify([
        location.format,
        location.elementPath,
        location.attribute.namespace,
        location.attribute.localName,
        location.role,
      ]);

export function readStudioVectorBindings(graph: unknown): StudioVectorBinding[] {
  if (!graph || typeof graph !== 'object' || !Object.hasOwn(graph, 'studioVectorDependencies')) return [];
  const result = declarationSchema.parse((graph as { studioVectorDependencies: unknown }).studioVectorDependencies);
  const seen = new Set<string>();
  const parents = new Map<string, string>();
  for (const binding of result.bindings) {
    const tuple = `${binding.parent.kind}:${binding.parent.checksum}`;
    if (parents.has(binding.parent.id) && parents.get(binding.parent.id) !== tuple)
      throw new StudioImportRefusal('Contradictory vector parent');
    parents.set(binding.parent.id, tuple);
    const key = JSON.stringify([
      binding.parent.kind,
      binding.parent.id,
      binding.parent.checksum,
      studioVectorLocationKey(binding.location),
    ]);
    if (seen.has(key)) throw new StudioImportRefusal('Duplicate vector dependency location');
    seen.add(key);
  }
  return result.bindings;
}

/** Reject duplicate JSON object keys, including escaped spellings, before JSON.parse loses them. */
function assertUnambiguousJson(text: string): void {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];
  let cursor = 0;
  const value = (depth: number): void => {
    if (depth > 64) throw new StudioImportRefusal('Lottie JSON depth exceeded');
    const token = tokens[cursor++];
    if (token === '{') {
      const keys = new Set<string>();
      if (tokens[cursor] === '}') {
        cursor++;
        return;
      }
      do {
        const key = JSON.parse(tokens[cursor++]) as unknown;
        if (typeof key !== 'string' || keys.has(key) || tokens[cursor++] !== ':')
          throw new StudioImportRefusal('Ambiguous Lottie JSON');
        keys.add(key);
        value(depth + 1);
        if (tokens[cursor] === '}') {
          cursor++;
          return;
        }
      } while (tokens[cursor++] === ',');
      throw new StudioImportRefusal('Invalid Lottie JSON');
    }
    if (token === '[') {
      if (tokens[cursor] === ']') {
        cursor++;
        return;
      }
      do {
        value(depth + 1);
        if (tokens[cursor] === ']') {
          cursor++;
          return;
        }
      } while (tokens[cursor++] === ',');
      throw new StudioImportRefusal('Invalid Lottie JSON');
    }
    if (token === undefined || ['}', ']', ':', ','].includes(token))
      throw new StudioImportRefusal('Invalid Lottie JSON');
  };
  value(0);
  if (cursor !== tokens.length) throw new StudioImportRefusal('Invalid Lottie JSON');
}

/** Only verified inline raster image bytes can bypass a declared external image dependency. */
export function assertStudioVectorImage(bytes: Uint8Array): void {
  const type = sniffStudioImport(bytes.subarray(0, 1024), undefined);
  if (type.kind !== 'image')
    throw new StudioImportRefusal('Vector image dependency must use a supported sanitized image path');
}

export function parseStudioLottieDependencies(text: string): {
  document: Record<string, unknown>;
  dependencies: StudioVectorLocation[];
} {
  if (Buffer.byteLength(text) > STUDIO_IMPORT_VECTOR_MAX_BYTES)
    throw new StudioImportRefusal('Vector byte limit exceeded');
  // Existing scanner establishes the animation shape and the legacy external reference policy.
  scanStudioLottie(text);
  assertUnambiguousJson(text);
  const document = JSON.parse(text) as Record<string, unknown>;
  if (document.assets !== undefined && !Array.isArray(document.assets))
    throw new StudioImportRefusal('Invalid Lottie assets');
  if (
    document.fonts !== undefined &&
    (!document.fonts || typeof document.fonts !== 'object' || Array.isArray(document.fonts))
  )
    throw new StudioImportRefusal('Invalid Lottie fonts');
  for (const slot of Object.values((document.slots ?? {}) as Record<string, { p?: { p?: unknown; u?: unknown } }>)) {
    if (typeof slot?.p?.p === 'string' || slot?.p?.u !== undefined)
      throw new StudioImportRefusal('Lottie image slot dependency requires supported image-slot admission');
  }
  const dependencies: StudioVectorLocation[] = [];
  for (const [index, raw] of (Array.isArray(document.assets) ? document.assets : []).entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StudioImportRefusal('Invalid Lottie asset');
    const asset = raw as Record<string, unknown>;
    if (asset.p === undefined) continue;
    if (typeof asset.p !== 'string' || (asset.u !== undefined && typeof asset.u !== 'string'))
      throw new StudioImportRefusal('Invalid Lottie image');
    if (asset.p.startsWith('data:')) {
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(asset.p);
      if (!match || asset.u) throw new StudioImportRefusal('Unsafe embedded Lottie image');
      const bytes = Buffer.from(match[2], 'base64');
      try {
        if (bytes.toString('base64') !== match[2]) throw new StudioImportRefusal('Noncanonical embedded image');
        assertStudioVectorImage(bytes);
        if (sniffStudioImport(bytes.subarray(0, 1024), undefined).contentType !== match[1])
          throw new StudioImportRefusal('Embedded image MIME mismatch');
      } finally {
        bytes.fill(0);
      }
    } else dependencies.push({ format: 'lottie-json', entry: null, pointer: `/assets/${index}/p`, role: 'image' });
  }
  const fonts = document.fonts as { list?: unknown } | undefined;
  if (fonts?.list !== undefined && !Array.isArray(fonts.list))
    throw new StudioImportRefusal('Invalid Lottie font list');
  for (const [index, raw] of (Array.isArray(fonts?.list) ? fonts.list : []).entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StudioImportRefusal('Invalid Lottie font');
    dependencies.push({ format: 'lottie-json', entry: null, pointer: `/fonts/list/${index}/fPath`, role: 'font' });
  }
  return { document, dependencies };
}

/** No permissive SVG image admission until the separately reviewed sanitizer/capture path exists. */
export function assertStudioVectorParent(
  bytes: Uint8Array,
  contentType: string,
): ReturnType<typeof parseStudioLottieDependencies> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (contentType === 'image/svg+xml') {
    scanStudioSvg(text);
    throw new StudioImportRefusal('SVG dependency materialization requires supported sanitized SVG path');
  }
  if (!['application/json', 'application/x-lottie+json'].includes(contentType))
    throw new StudioImportRefusal('Unsupported vector parent');
  return parseStudioLottieDependencies(text);
}

export type StudioVectorAuthorizedInput = {
  key: string;
  kind: string;
  id: string;
  checksum: string | null;
  path?: string | null;
};
/** Shared server/worker completeness check; the reader supplies only currently authorized snapshots. */
export async function validateStudioVectorClosure(
  graph: unknown,
  entries: readonly StudioVectorAuthorizedInput[],
  read: (entry: StudioVectorAuthorizedInput, maximum: number) => Promise<Uint8Array>,
): Promise<void> {
  const bindings = readStudioVectorBindings(graph);
  if (bindings.length === 0) return;
  const inputs = new Map(entries.map((entry) => [entry.key, entry]));
  const verified = new Map<string, Uint8Array>();
  let allocated = 0;
  const bytesFor = async (kind: string, id: string, checksum: string): Promise<Uint8Array> => {
    const key = `${kind}:${id}`;
    const entry = inputs.get(key);
    if (!entry || entry.kind !== kind || entry.id !== id)
      throw new StudioImportRefusal('Unauthorized vector dependency');
    if (/^[a-f0-9]{64}$/.test(entry.checksum ?? '') && entry.checksum !== checksum)
      throw new StudioImportRefusal('Vector checksum changed');
    let bytes = verified.get(key);
    if (!bytes) {
      bytes = await read(entry, Math.min(STUDIO_IMPORT_VECTOR_MAX_BYTES, 32 * 1024 * 1024 - allocated));
      allocated += bytes.byteLength;
      if (bytes.byteLength > STUDIO_IMPORT_VECTOR_MAX_BYTES || allocated > 32 * 1024 * 1024)
        throw new StudioImportRefusal('Vector allocation limit exceeded');
      verified.set(key, bytes);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== checksum)
      throw new StudioImportRefusal('Vector dependency bytes changed');
    return bytes;
  };
  const groups = new Map<string, StudioVectorBinding[]>();
  for (const binding of bindings) {
    const key = `${binding.parent.kind}:${binding.parent.id}`;
    const group = groups.get(key) ?? [];
    group.push(binding);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const parent = group[0].parent;
    if (group.some((binding) => binding.parent.checksum !== parent.checksum))
      throw new StudioImportRefusal('Ambiguous vector parent checksum');
    const bytes = await bytesFor(parent.kind, parent.id, parent.checksum);
    const type = sniffStudioImport(bytes.subarray(0, 1024), undefined);
    if (type.kind !== 'vector') throw new StudioImportRefusal('Wrong vector parent MIME');
    const parsed = assertStudioVectorParent(bytes, type.contentType);
    const expected = new Set(parsed.dependencies.map((location) => studioVectorLocationKey(location)));
    if (
      expected.size !== group.length ||
      group.some((binding) => !expected.has(studioVectorLocationKey(binding.location)))
    )
      throw new StudioImportRefusal('Incomplete vector dependency declarations');
    for (const binding of group) {
      const child = await bytesFor(binding.child.kind, binding.child.id, binding.child.checksum);
      if (binding.location.role === 'image') assertStudioVectorImage(child);
      // A font is admitted only by the existing catalog/rights resolver, never by a guessed MIME.
    }
  }
}
