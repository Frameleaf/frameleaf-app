/**
 * Extra icon packs for the album and collection icon chooser, beside Material Design Icons.
 *
 * The packs come from the pinned `@iconify-json/*` dev dependencies. This module turns each icon
 * into a small drawable shape and is used three ways:
 *  - vite.config.ts writes one static asset per pack (`static/icon-packs/<prefix>.json`), fetched
 *    lazily by $lib/frameleaf/icon-catalogue.ts, never bundled as JS;
 *  - `node web/scripts/icon-packs.mjs` rewrites server/src/constants/icon-pack-names.json, the
 *    names the server accepts and serves (run it after bumping a pack version);
 *  - icon-packs.spec.ts fails when that server file no longer matches the installed packs.
 *
 * A stored icon from a pack is `<prefix>:<name>`, the Iconify id (`tabler:rollercoaster`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * A drawable icon. A plain string is one filled path on the 24 unit grid (the Material Design
 * Icons shape); anything else lists its filled path and its stroked paths by stroke width.
 * @typedef {string | { box?: number, fill?: string, strokes?: [width: number, path: string][] }} IconShape
 */

/**
 * IconOven fills the gaps the two full packs leave (instruments, wedding wear, zoo animals,
 * holidays). ponytail: a hand-picked list, not the whole 18,000 icon set; add names here.
 */
const ICONOVEN_ICONS = new Set([
  'accordion',
  'amphitheater',
  'angel-wings',
  'baby-footprint',
  'baby-onesie',
  'baby-pacifier',
  'baby-rattle',
  'baby-shower',
  'ballet-flat',
  'balloon-bunch',
  'bear',
  'birthday-crown',
  'bouquet',
  'camel',
  'canoe',
  'carousel-horse',
  'champagne-pop',
  'choir-singers',
  'circus-tent',
  'clarinet',
  'clown',
  'concert-hand',
  'concert-ticket',
  'crab',
  'cruise-ship',
  'diploma',
  'disco-ball',
  'diya-lamp',
  'dove-peace',
  'dreidel',
  'dress',
  'drum',
  'drum-kit',
  'easter-bunny',
  'family-photo',
  'fireworks-burst',
  'flute',
  'fox',
  'giraffe',
  'graduation-cap',
  'grandmother',
  'grandparents',
  'harp',
  'hot-spring',
  'igloo',
  'kaaba',
  'kiss',
  'lantern',
  'lion',
  'lotus',
  'luggage-cart',
  'maracas',
  'monkey',
  'octopus',
  'pagoda',
  'paper-lantern',
  'passport-stamp',
  'pinata',
  'reindeer',
  'sand-castle',
  'santa-hat',
  'santa-sleigh',
  'sparkler',
  'stage-lights',
  'swing-set',
  'tiara',
  'tiger',
  'toast-glasses',
  'travel-journal',
  'trombone',
  'turntable',
  'tuxedo',
  'ukulele',
  'ultrasound-baby',
  'wedding-chapel',
  'wedding-rings',
  'whale',
  'witch-hat',
  'xylophone',
  'yacht',
]);

/** @type {{ prefix: string, title: string, include: (name: string) => boolean }[]} */
export const ICON_PACKS = [
  { prefix: 'tabler', title: 'Tabler Icons', include: () => true },
  // The default style only: the rounded and sharp styles repeat every icon.
  { prefix: 'material-symbols', title: 'Material Symbols', include: (name) => !/-(rounded|sharp)$/.test(name) },
  { prefix: 'iconoven', title: 'IconOven', include: (name) => ICONOVEN_ICONS.has(name) },
];

const attributesOf = (/** @type {string} */ tag) =>
  Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));

const circlePath = ({ cx = 0, cy = 0, r }) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

const rectPath = ({ x = 0, y = 0, width, height, rx = 0, ry = rx }) => {
  const [w, h] = [Number(width), Number(height)];
  const [a, b] = [Math.min(Number(rx), w / 2), Math.min(Number(ry), h / 2)];
  const corner = (dx, dy) => (a > 0 && b > 0 ? `a${a} ${b} 0 0 1 ${dx * a} ${dy * b}` : '');
  return `M${Number(x) + a} ${y}h${w - 2 * a}${corner(1, 1)}v${h - 2 * b}${corner(-1, 1)}h${2 * a - w}${corner(-1, -1)}v${2 * b - h}${corner(1, -1)}Z`;
};

// Presentation attributes this renderer does not draw; an icon that needs one is left out.
const UNSUPPORTED = ['opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'clip-path', 'mask', 'stroke-dasharray'];

/**
 * Turn an Iconify SVG body into a shape, or undefined when it uses anything beyond plain
 * `currentColor` paths, circles and rectangles with round strokes (other elements, colours, opacity, even-odd fills).
 * @param {string} body
 * @param {number} box
 * @returns {IconShape | undefined}
 */
export const shapeOf = (body, box) => {
  /** @type {Record<string, string>[]} */
  const inherited = [{}];
  /** @type {string[]} */
  const fills = [];
  /** @type {Map<number, string[]>} */
  const strokes = new Map();
  let rest = body;
  for (const [tag, closing, element] of body.matchAll(/<(\/?)([\w-]+)[^>]*>/g)) {
    rest = rest.replace(tag, '');
    if (element === 'g') {
      if (closing) {
        inherited.pop();
      } else {
        inherited.push({ ...inherited.at(-1), ...attributesOf(tag) });
      }
      continue;
    }
    const attributes = { ...inherited.at(-1), ...attributesOf(tag) };
    const d = { path: () => attributes.d, circle: circlePath, rect: rectPath }[element]?.(attributes);
    const { fill = 'currentColor', stroke = 'none' } = attributes;
    const round = attributes['stroke-linecap'] === 'round' && attributes['stroke-linejoin'] === 'round';
    if (
      !d ||
      UNSUPPORTED.some((name) => Object.hasOwn(attributes, name)) ||
      (attributes['fill-rule'] ?? 'nonzero') !== 'nonzero' ||
      !['none', 'currentColor'].includes(fill) ||
      !['none', 'currentColor'].includes(stroke) ||
      (stroke !== 'none' && !round)
    ) {
      return;
    }
    if (fill !== 'none') {
      fills.push(d);
    }
    if (stroke !== 'none') {
      const width = Number(attributes['stroke-width'] ?? 1);
      strokes.set(width, [...(strokes.get(width) ?? []), d]);
    }
  }
  if (rest.trim() !== '' || (fills.length === 0 && strokes.size === 0)) {
    return;
  }
  const fill = fills.join('');
  if (strokes.size === 0 && box === 24) {
    return fill;
  }
  return {
    ...(box !== 24 && { box }),
    ...(fill && { fill }),
    ...(strokes.size > 0 && { strokes: [...strokes].map(([width, paths]) => [width, paths.join('')]) }),
  };
};

/**
 * Every pack with its drawable icons, names sorted.
 * @returns {{ prefix: string, title: string, version: string, license: string, icons: Record<string, IconShape> }[]}
 */
export const buildIconPacks = () =>
  ICON_PACKS.map(({ prefix, title, include }) => {
    const set = require(`@iconify-json/${prefix}/icons.json`);
    const info = require(`@iconify-json/${prefix}/info.json`);
    const { version } = require(`@iconify-json/${prefix}/package.json`);
    /** @type {Record<string, IconShape>} */
    const icons = {};
    for (const name of Object.keys(set.icons).sort()) {
      const { body, width = set.width ?? 16, height = set.height ?? 16, left = 0, top = 0 } = set.icons[name];
      const shape = include(name) && width === height && left === 0 && top === 0 ? shapeOf(body, width) : undefined;
      if (shape !== undefined) {
        icons[name] = shape;
      }
    }
    return { prefix, title, version, license: info.license.spdx, icons };
  });

/** What the server keeps: which names exist in which pack version, no geometry. */
export const iconPackNames = () =>
  Object.fromEntries(
    buildIconPacks().map(({ prefix, title, version, license, icons }) => [
      prefix,
      { title, version, license, names: Object.keys(icons) },
    ]),
  );

export const ICON_PACK_NAMES_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../server/src/constants/icon-pack-names.json',
);

export const readIconPackNames = () => JSON.parse(readFileSync(ICON_PACK_NAMES_FILE, 'utf8'));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = iconPackNames();
  writeFileSync(ICON_PACK_NAMES_FILE, `${JSON.stringify(names, null, 2)}\n`);
  for (const [prefix, pack] of Object.entries(names)) {
    console.log(`${prefix} ${pack.version}: ${pack.names.length} icons`);
  }
}
