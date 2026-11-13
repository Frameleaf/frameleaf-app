import { BadRequestException } from '@nestjs/common';
import { endianness } from 'node:os';
import { inflateSync } from 'node:zlib';
import z from 'zod';
import type { AssetDevelopRecipe } from 'src/dtos/asset-develop.dto.js';
import { nativeBlendParams } from 'src/utils/darktable-controls.js';
import { DARKTABLE_NAMESPACE, type XmpNode, settingsFor } from 'src/utils/develop-import/xmp.js';

export const NATIVE_HISTORY_RENDERER_VERSION = 'native-history/1';
const hex = z
  .string()
  .max(4096)
  .regex(/^(?:[0-9a-f]{2})+$/);
const HistorySchema = z.strictObject({
  version: z.literal(1),
  orderVersion: z.literal(4),
  entries: z
    .array(
      z.strictObject({
        operation: z.string().max(24),
        version: z.int(),
        enabled: z.union([z.literal(0), z.literal(1)]),
        params: hex,
        blend: hex,
      }),
    )
    .min(1)
    .max(64),
});
export type NativeHistory = z.infer<typeof HistorySchema>;

// Layouts from darktable 20891f6c6fa7be995e5bf9dff9d1ee5062051773 src/iop/*.c and develop/blend.h.
// No module here can name an external resource; ICC filenames and all mask references are refused below.
const layouts: Record<string, [number, number]> = {
  rawprepare: [2, 32],
  demosaic: [6, 48],
  colorin: [7, 1044],
  colorout: [5, 520],
  gamma: [1, 8],
  temperature: [4, 20],
  highlights: [4, 48],
  channelmixerrgb: [3, 160],
  exposure: [7, 28],
  flip: [2, 4],
  sigmoid: [3, 56],
};
const required = [
  'rawprepare',
  'demosaic',
  'colorin',
  'colorout',
  'gamma',
  'temperature',
  'highlights',
  'channelmixerrgb',
  'exposure',
  'flip',
  'sigmoid',
];
const unsupported = () =>
  new BadRequestException({
    message: 'This recipe contains unsupported render fields',
    code: 'develop_renderer_unsupported',
  });
const check = (condition: unknown) => {
  if (!condition) throw unsupported();
};

/** Decode native hex/zlib fields with an output ceiling, never the source's claimed compression ratio. */
function decode(value: string) {
  check(value.length <= 8192);
  if (/^gz\d{2}[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    try {
      return inflateSync(Buffer.from(value.slice(4), 'base64'), { maxOutputLength: 2048 });
    } catch {
      throw unsupported();
    }
  }
  check(/^(?:[0-9a-f]{2})+$/i.test(value));
  return Buffer.from(value, 'hex');
}

/** Revalidate stored/client-supplied opaque descriptors on every render, before starting a process. */
export function validateNativeHistory(value: unknown): NativeHistory {
  const parsed = HistorySchema.safeParse(value);
  if (!parsed.success || endianness() !== 'LE') throw unsupported();
  const history = parsed.data;
  check(required.every((operation) => history.entries.some((entry) => entry.operation === operation)));
  for (const entry of history.entries) {
    const layout = layouts[entry.operation];
    check(layout && entry.version === layout[0] && entry.params.length === layout[1] * 2);
    const bytes = Buffer.from(entry.params, 'hex');
    const integer = (offset: number, min: number, max: number) => {
      const value = bytes.readInt32LE(offset);
      check(value >= min && value <= max);
      return value;
    };
    const number = (offset: number, min: number, max: number) => {
      const value = bytes.readFloatLE(offset);
      check(Number.isFinite(value) && value >= min && value <= max);
      return value;
    };
    const zero = (start: number, end: number) => check(bytes.subarray(start, end).every((value) => value === 0));
    const blend = Buffer.from(entry.blend, 'hex');
    check(blend.length === 420 && [0, 1, 2, 3, 4].includes(blend.readInt32LE(4)));
    check(blend.equals(nativeBlendParams(blend.readInt32LE(4))));
    switch (entry.operation) {
      case 'rawprepare': {
        for (const offset of [0, 4, 8, 12]) integer(offset, 0, 65_535);
        check(bytes.readUInt16LE(24) > 0);
        zero(26, 28);
        integer(28, 0, 0);
        break;
      }
      case 'colorin': {
        check([1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 20, 21, 26].includes(integer(0, 1, 26)));
        zero(4, 516);
        integer(516, 0, 3);
        integer(520, 0, 4);
        integer(524, 0, 1);
        check([3, 4, 21].includes(integer(528, 1, 26)));
        zero(532, 1044);
        break;
      }
      case 'colorout': {
        check([1, 2, 3, 4, 5, 6, 20, 21, 26].includes(integer(0, 1, 26)));
        zero(4, 516);
        integer(516, 0, 3);
        break;
      }
      case 'demosaic': {
        integer(0, 0, 3);
        number(4, 0, 1);
        integer(8, 0, 5);
        // Pinned demosaic.c flags: X-Trans = 1024, dual = 2048.
        check(
          [0, 1, 2, 3, 4, 5, 6, 7, 1024, 1025, 1026, 1027, 1028, 1029, 2049, 2053, 3074].includes(integer(12, 0, 3074)),
        );
        integer(16, 0, 4);
        number(20, 0, 1);
        number(24, 0, 1.5);
        number(28, 0, 1);
        number(32, 0, 1.5);
        integer(36, 1, 25);
        number(40, 0, 1);
        integer(44, 0, 1);
        break;
      }
      case 'temperature': {
        for (const offset of [0, 4, 8]) number(offset, 0.001, 16);
        number(12, 0, 16);
        integer(16, 0, 4);
        break;
      }
      case 'exposure': {
        integer(0, 0, 0);
        number(4, -1, 1);
        number(8, -18, 18);
        number(12, 0, 100);
        number(16, -18, 18);
        integer(20, 0, 1);
        integer(24, 0, 1);
        break;
      }
      case 'flip': {
        integer(0, -1, 7);
        break;
      }
      case 'highlights': {
        integer(0, 0, 5);
        number(4, 0, 1);
        number(8, 0, 1);
        number(12, 0, 1);
        number(16, 0, 2);
        number(20, 0, 0.5);
        integer(24, 1, 256);
        integer(28, 0, 11);
        number(32, 0, 1);
        number(36, 0, 8);
        integer(40, 0, 6);
        number(44, 0, 1);
        break;
      }
      case 'channelmixerrgb': {
        for (let offset = 0; offset < 96; offset += 4) number(offset, -16, 16);
        for (let offset = 96; offset < 120; offset += 4) integer(offset, 0, 1);
        integer(120, 0, 10);
        integer(124, 0, 11);
        integer(128, 0, 8);
        integer(132, 0, 4);
        number(136, -1, 2);
        number(140, -1, 2);
        number(144, 1000, 25_000);
        number(148, 0, 12);
        integer(152, 0, 1);
        integer(156, 0, 2);
        break;
      }
      case 'sigmoid': {
        number(0, 0.1, 10);
        number(4, -1, 1);
        number(8, 20, 1600);
        number(12, 0, 15);
        integer(16, 0, 1);
        number(20, 0, 100);
        for (const offset of [24, 32, 40]) {
          number(offset, 0, 0.99);
          number(offset + 4, -0.4, 0.4);
        }
        number(48, 0, 1);
        integer(52, 0, 4);
        break;
      }
      default: {
        for (let offset = 0; offset < bytes.length; offset += 4) number(offset, -1000, 1000);
      }
    }
  }
  return history;
}

const entriesIn = (node: XmpNode): XmpNode[] =>
  node.name === 'li' ? [node] : node.children.flatMap((child) => entriesIn(child));
const fieldsOf = (node: XmpNode) => {
  const fields = node.children.filter((child) => child.namespace === DARKTABLE_NAMESPACE);
  check(new Set(fields.map((child) => child.name)).size === fields.length);
  return { ...node.attributes, ...Object.fromEntries(fields.map((child) => [child.name, child.value])) };
};

export function readNativeHistory(nodes: XmpNode[]): NativeHistory {
  const settings = settingsFor(nodes, DARKTABLE_NAMESPACE);
  for (const name of [
    'xmp_version',
    'raw_params',
    'auto_presets_applied',
    'history_end',
    'iop_order_version',
    'iop_order_list',
    'history',
    'masks_history',
  ])
    check(settings.filter((node) => node.name === name).length <= 1);
  const value = (name: string) => settings.find((node) => node.name === name)?.value;
  check(
    value('xmp_version') === '5' &&
      value('raw_params') === '0' &&
      value('auto_presets_applied') === '1' &&
      value('iop_order_version') === '4' &&
      !value('iop_order_list'),
  );
  const masks = settings.find((node) => node.name === 'masks_history');
  check(!masks || entriesIn(masks).length === 0);
  const source = settings.find((node) => node.name === 'history');
  check(source);
  const entries = entriesIn(source!);
  check(entries.length > 0 && entries.length <= 64 && Number(value('history_end')) === entries.length);
  return validateNativeHistory({
    version: 1,
    orderVersion: 4,
    entries: entries.map((entry, index) => {
      const fields = fieldsOf(entry);
      check(fields.num === String(index) && fields.multi_priority === '0' && fields.blendop_version === '14');
      check(fields.enabled === '0' || fields.enabled === '1');
      return {
        operation: fields.operation,
        version: Number(fields.modversion),
        enabled: Number(fields.enabled),
        params: decode(fields.params ?? '').toString('hex'),
        blend: decode(fields.blendop_params ?? '').toString('hex'),
      };
    }),
  });
}

/** Source-bound bitmap artifacts are not defined on an imported native crop/orientation canvas. */
export function nativeHistoryForRecipe(recipe: AssetDevelopRecipe): NativeHistory | undefined {
  const imported = recipe.imported as { darktable?: { replay?: unknown } } | undefined;
  if (!imported?.darktable || !Object.hasOwn(imported.darktable, 'replay')) return;
  check(recipe.version === 1 && !recipe.keyFrame);
  const cleanup = recipe.cleanup as { enabled?: boolean }[] | undefined;
  const masks = recipe.masks as { enabled?: boolean; artifact?: unknown }[] | undefined;
  check(!cleanup?.some((operation) => operation.enabled) && !masks?.some((mask) => mask.enabled && mask.artifact));
  return validateNativeHistory(imported.darktable.replay);
}

/** Emit only validated numeric/hex fields. Never pass source XML, paths, metadata or module names through. */
export function nativeHistoryXmp(value: unknown): string {
  const history = validateNativeHistory(value);
  return `<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:darktable="http://darktable.sf.net/" darktable:xmp_version="5" darktable:raw_params="0" darktable:auto_presets_applied="1" darktable:history_end="${history.entries.length}" darktable:iop_order_version="4"><darktable:masks_history><rdf:Seq/></darktable:masks_history><darktable:history><rdf:Seq>${history.entries.map((entry, index) => `<rdf:li darktable:num="${index}" darktable:operation="${entry.operation}" darktable:enabled="${entry.enabled}" darktable:modversion="${entry.version}" darktable:params="${entry.params}" darktable:multi_name="" darktable:multi_name_hand_edited="0" darktable:multi_priority="0" darktable:blendop_version="14" darktable:blendop_params="${entry.blend}"/>`).join('')}</rdf:Seq></darktable:history></rdf:Description></rdf:RDF></x:xmpmeta>`;
}
