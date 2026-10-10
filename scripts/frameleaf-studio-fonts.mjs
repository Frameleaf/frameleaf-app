#!/usr/bin/env node
/**
 * The title fonts the server bundles for native Studio clients (graph protocol 14.3.5).
 *
 * The seven title families come from exactly pinned `@fontsource/*` packages in the server's
 * dependencies. This script reads the installed packages and writes
 * `server/src/utils/studio-fonts.generated.ts`: for each family its package, version, licence and
 * copyright line as the package's own LICENSE states them, and for each bundled file its weight,
 * style, subset, size and SHA-256. The server serves only the files this catalogue names, by hash.
 *
 * Each WOFF2 file is also decoded to its sfnt (TrueType) form for clients that cannot load WOFF2:
 * decompression only, with no subsetting or merging, by the pinned `woff2-encoder` dev dependency
 * (MIT; Google's woff2 as WebAssembly). The decoded files are committed under
 * `server/resources/studio-fonts/` and listed beside their source. A decode is accepted only when
 * it has the tables, glyph count and untransformed table bytes of its WOFF2 source.
 *
 *   node scripts/frameleaf-studio-fonts.mjs            # verify the generated catalogue
 *   node scripts/frameleaf-studio-fonts.mjs --write    # regenerate it
 *
 * A family whose package does not declare and carry the SIL Open Font License 1.1 stops the run:
 * nothing is bundled on an unverified licence. `server/src/utils/studio-fonts.spec.ts` repeats the
 * hash check against the installed packages in the server unit tests.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

export const GENERATED_PATH = 'server/src/utils/studio-fonts.generated.ts';
export const DECODED_DIRECTORY = 'server/resources/studio-fonts';
const DECODER = 'woff2-encoder';
const DECODER_VERSION = '2.0.0';
const GENERATOR = 'scripts/frameleaf-studio-fonts.mjs';

/** Family name as a graph names it (the engine's font catalogue) and its package. */
export const FAMILIES = [
  ['Inter', '@fontsource/inter'],
  ['Inter Tight', '@fontsource/inter-tight'],
  ['Anton', '@fontsource/anton'],
  ['Bebas Neue', '@fontsource/bebas-neue'],
  ['Orbitron', '@fontsource/orbitron'],
  ['Playfair Display', '@fontsource/playfair-display'],
  ['Space Grotesk', '@fontsource/space-grotesk'],
];
/** The weights a title's `fontWeight` can ask for: normal, medium, semibold, bold. */
export const WEIGHTS = [400, 500, 600, 700];
export const SUBSETS = ['latin', 'latin-ext'];
const STYLES = ['normal', 'italic'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/* ------------------------------------------------------------------ */
/* WOFF2 and sfnt table directories (W3C WOFF2, section 5)              */
/* ------------------------------------------------------------------ */

const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ',
  'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS',
  'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc',
  'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
  'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

/** The tables of a WOFF2 file: tag, whether stored transformed, and the stored bytes after Brotli. */
export function woff2Tables(bytes) {
  if (bytes.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');
  const flavor = bytes.readUInt32BE(4);
  const numTables = bytes.readUInt16BE(12);
  const compressedSize = bytes.readUInt32BE(20);
  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const byte = bytes[at++];
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('bad UIntBase128');
  };
  const entries = [];
  for (let index = 0; index < numTables; index++) {
    const flags = bytes[at++];
    let tag;
    if ((flags & 0x3f) === 63) {
      tag = bytes.toString('latin1', at, at + 4);
      at += 4;
    } else {
      tag = KNOWN_TAGS[flags & 0x3f];
    }
    const version = flags >> 6;
    // glyf and loca are transformed at version 0; every other table at any version but 0.
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const origLength = base128();
    const length = transformed ? base128() : origLength;
    entries.push({ tag, transformed, length });
  }
  const data = brotliDecompressSync(bytes.subarray(at, at + compressedSize));
  let offset = 0;
  for (const entry of entries) {
    entry.data = data.subarray(offset, offset + entry.length);
    offset += entry.length;
  }
  if (offset !== data.length) throw new Error('WOFF2 table data does not fill the stream');
  return { flavor, tables: entries };
}

export function sfntTables(bytes) {
  const flavor = bytes.readUInt32BE(0);
  const numTables = bytes.readUInt16BE(4);
  const tables = new Map();
  for (let index = 0; index < numTables; index++) {
    const at = 12 + index * 16;
    const offset = bytes.readUInt32BE(at + 8);
    tables.set(bytes.toString('latin1', at, at + 4), bytes.subarray(offset, offset + bytes.readUInt32BE(at + 12)));
  }
  return { flavor, tables };
}

/**
 * A decode is the same font: the same flavour and set of tables, the same glyph count, and every
 * table WOFF2 stores untransformed byte for byte (but for the checksum adjustment in `head`, which
 * covers the whole file and is rewritten). Only `glyf`, `loca` and a transformed `hmtx` are rebuilt.
 */
export function assertLosslessDecode(woff2, sfnt, name) {
  const source = woff2Tables(woff2);
  const decoded = sfntTables(sfnt);
  if (source.flavor !== decoded.flavor) throw new Error(`${name}: decoded flavour differs`);
  const tags = source.tables.map((table) => table.tag).sort();
  if (tags.join() !== [...decoded.tables.keys()].sort().join()) throw new Error(`${name}: decoded tables differ`);
  for (const table of source.tables) {
    if (table.transformed) continue;
    const a = Buffer.from(table.data);
    const b = Buffer.from(decoded.tables.get(table.tag));
    if (table.tag === 'head') {
      a.writeUInt32BE(0, 8);
      b.writeUInt32BE(0, 8);
    }
    if (!a.equals(b)) throw new Error(`${name}: decoded table ${table.tag} differs`);
  }
  const glyphs = source.tables.find((table) => table.tag === 'maxp').data.readUInt16BE(4);
  if (decoded.tables.get('maxp').readUInt16BE(4) !== glyphs) throw new Error(`${name}: decoded glyph count differs`);
  const glyf = source.tables.find((table) => table.tag === 'glyf');
  if (glyf?.transformed && glyf.data.readUInt16BE(4) !== glyphs) throw new Error(`${name}: glyf count differs`);
  return { tables: tags.length, glyphs };
}

async function decoder(root) {
  const require = createRequire(path.join(root, 'server/package.json'));
  const directory = path.dirname(require.resolve(`${DECODER}/package.json`));
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const licence = await readFile(path.join(directory, 'LICENSE'), 'utf8');
  if (manifest.version !== DECODER_VERSION || manifest.license !== 'MIT' || !licence.startsWith('MIT License')) {
    throw new Error(`${DECODER}: expected the MIT-licensed ${DECODER_VERSION}`);
  }
  const { default: decompress } = await import(pathToFileURL(path.join(directory, 'dist/decompress.js')).href);
  return decompress;
}

export async function buildCatalogue(root) {
  const decompress = await decoder(root);
  const families = [];
  const decoded = new Map();
  for (const [family, packageName] of FAMILIES) {
    const directory = path.join(root, 'server/node_modules', packageName);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const licence = await readFile(path.join(directory, 'LICENSE'), 'utf8');
    if (manifest.license !== 'OFL-1.1' || !licence.includes('SIL OPEN FONT LICENSE Version 1.1')) {
      throw new Error(`${packageName}: not verifiably SIL OFL 1.1; the family is not bundled`);
    }
    const copyright = licence.split('\n')[0].trim();
    if (!copyright.startsWith('Copyright ')) throw new Error(`${packageName}: LICENSE has no copyright line`);
    const reserved = /with Reserved Font Name "([^"]+)"/.exec(copyright)?.[1] ?? null;
    const slug = packageName.split('/')[1];
    const present = new Set(await readdir(path.join(directory, 'files')));
    const files = [];
    for (const style of STYLES) {
      for (const weight of WEIGHTS) {
        for (const subset of SUBSETS) {
          const file = `${slug}-${subset}-${weight}-${style}.woff2`;
          if (!present.has(file)) continue;
          const bytes = await readFile(path.join(directory, 'files', file));
          const source = sha256(bytes);
          files.push({ file, weight, style, subset, format: 'woff2', size: bytes.length, sha256: source, decodedFrom: null });
          // The same font as sfnt, for a client that cannot load WOFF2.
          const sfnt = Buffer.from(await decompress(bytes));
          const name = file.replace(/\.woff2$/, '.ttf');
          const facts = assertLosslessDecode(bytes, sfnt, name);
          if (sfnt.readUInt32BE(0) !== 0x00_01_00_00) throw new Error(`${name}: not a TrueType font`);
          decoded.set(name, sfnt);
          files.push({
            file: name,
            weight,
            style,
            subset,
            format: 'ttf',
            size: sfnt.length,
            sha256: sha256(sfnt),
            decodedFrom: source,
            tables: facts.tables,
            glyphs: facts.glyphs,
          });
        }
      }
    }
    if (!files.some((entry) => entry.weight === 400 && entry.style === 'normal' && entry.subset === 'latin')) {
      throw new Error(`${packageName}: no regular Latin file`);
    }
    families.push({
      family,
      package: packageName,
      version: manifest.version,
      license: 'OFL-1.1',
      copyright,
      reservedFontName: reserved,
      licenseSha256: sha256(licence),
      files,
    });
  }
  return { families, decoded };
}

/** TypeScript source as the server's formatter and linter leave it, so the file is stable under both. */
const literal = (value, indent = '') => {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    return `[\n${value.map((entry) => `${inner}${literal(entry, inner)},\n`).join('')}${indent}]`;
  }
  if (value && typeof value === 'object') {
    return `{\n${Object.entries(value)
      .map(([key, entry]) => {
        const line = `${inner}${key}: ${literal(entry, inner)},`;
        // The formatter moves a string that overflows the 120 column line under its key.
        return typeof entry === 'string' && line.length > 120
          ? `${inner}${key}:\n${inner}  ${literal(entry, inner)},\n`
          : `${line}\n`;
      })
      .join('')}${indent}}`;
  }
  if (typeof value === 'number') {
    return value >= 10_000 ? String(value).replace(/\B(?=(\d{3})+$)/g, '_') : String(value);
  }
  if (typeof value === 'string') {
    return value.includes("'") ? JSON.stringify(value) : `'${value}'`;
  }
  return String(value);
};

export const render = (families) =>
  [
    `// Generated by ${GENERATOR} from the installed @fontsource packages. Do not edit.`,
    '',
    `export const studioBundledFonts = ${literal(families)} as const;`,
    '',
  ].join('\n');

export async function main(argv, root) {
  const { families, decoded } = await buildCatalogue(root);
  const content = render(families);
  const target = path.join(root, GENERATED_PATH);
  const directory = path.join(root, DECODED_DIRECTORY);
  if (argv.includes('--write')) {
    await mkdir(directory, { recursive: true });
    for (const stale of await readdir(directory)) {
      if (stale.endsWith('.ttf') && !decoded.has(stale)) await rm(path.join(directory, stale));
    }
    for (const [name, bytes] of decoded) await writeFile(path.join(directory, name), bytes);
    await writeFile(target, content);
    return 0;
  }
  const stale = [];
  if ((await readFile(target, 'utf8').catch(() => null)) !== content) stale.push(GENERATED_PATH);
  const present = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.ttf'));
  for (const [name, bytes] of decoded) {
    const current = await readFile(path.join(directory, name)).catch(() => null);
    if (!current || !current.equals(bytes)) stale.push(`${DECODED_DIRECTORY}/${name}`);
  }
  for (const name of present) if (!decoded.has(name)) stale.push(`${DECODED_DIRECTORY}/${name} (not in the catalogue)`);
  if (stale.length > 0) {
    process.stderr.write(`Studio font catalogue is stale:\n  ${stale.join('\n  ')}\nRun: node ${GENERATOR} --write\n`);
    return 1;
  }
  process.stdout.write(`Studio font catalogue verified: ${families.length} families, ${decoded.size} decoded files.\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2), fileURLToPath(new URL('..', import.meta.url)));
}
