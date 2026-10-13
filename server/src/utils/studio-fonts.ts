import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioBundledFonts } from 'src/utils/studio-fonts.generated.js';

/**
 * The title fonts bundled with the server for native Studio clients (graph protocol 14.3.5).
 *
 * The catalogue is generated from the pinned `@fontsource/*` packages by
 * `scripts/frameleaf-studio-fonts.mjs`. Each WOFF2 file of a package has a decoded sfnt twin in
 * `resources/studio-fonts`, the same font decompressed and nothing else, for clients that cannot
 * load WOFF2. A file is addressed by its SHA-256 and by nothing else: no
 * name, path or locator from a request ever reaches the file system, so only the files the
 * catalogue lists can be served.
 */
export type StudioBundledFontFamily = (typeof studioBundledFonts)[number];
export type StudioBundledFontFile = StudioBundledFontFamily['files'][number];

export const STUDIO_FONT_MEDIA_TYPES = { woff2: 'font/woff2', ttf: 'font/ttf' } as const;

const bySha256 = new Map<string, { family: StudioBundledFontFamily; file: StudioBundledFontFile }>();
for (const family of studioBundledFonts) {
  for (const file of family.files) {
    bySha256.set(file.sha256, { family, file });
  }
}

export const studioBundledFontFamilies = (): readonly StudioBundledFontFamily[] => studioBundledFonts;

/** The catalogue entry with this content hash, or undefined. The hash is compared whole, as text. */
export const findStudioBundledFont = (sha256: string) =>
  /^[a-f0-9]{64}$/.test(sha256) ? bySha256.get(sha256) : undefined;

const resolver = createRequire(import.meta.url);
/** `resources` sits beside `src` in a checkout and beside `dist` in a deployment. */
const decodedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../resources/studio-fonts');

/**
 * Where a catalogue file is: a WOFF2 inside its installed package, a decoded TTF in the server's
 * resources. Built from catalogue values only.
 */
export const studioBundledFontPath = (family: StudioBundledFontFamily, file: StudioBundledFontFile): string =>
  file.format === 'ttf'
    ? join(decodedRoot, file.file)
    : join(dirname(resolver.resolve(`${family.package}/package.json`)), 'files', file.file);

/** One file of a bundled family as a render reads it: where it is, and what it holds. */
export type StudioRenderFontFile = {
  /** File name, unique within the family; with the entry key it names the worker input. */
  file: string;
  weight: number;
  style: 'normal' | 'italic';
  subset: string;
  format: 'ttf';
  checksum: string;
  path: string;
};

export type StudioRenderFontEntry = { path: string; checksum: string; files: StudioRenderFontFile[] };

let renderCatalog: Readonly<Record<string, StudioRenderFontEntry>> | undefined;

/**
 * The bundled families as the render font catalogue: family name to its decoded TrueType files
 * (every platform's font loader reads sfnt; the WOFF2 twins are for clients that prefer them).
 * `path` and `checksum` are the family's regular Latin file, the one-file shape a manifest entry
 * had before `files` existed, so a reader of the old shape still gets a usable font.
 */
export const studioBundledRenderFonts = (): Readonly<Record<string, StudioRenderFontEntry>> => {
  if (!renderCatalog) {
    const catalog: Record<string, StudioRenderFontEntry> = {};
    for (const family of studioBundledFonts) {
      const files = family.files
        .filter((file) => file.format === 'ttf')
        .map((file) => ({
          file: file.file,
          weight: file.weight,
          style: file.style,
          subset: file.subset,
          format: 'ttf' as const,
          checksum: file.sha256,
          path: studioBundledFontPath(family, file),
        }));
      const regular =
        files.find((file) => file.weight === 400 && file.style === 'normal' && file.subset === 'latin') ?? files[0];
      catalog[family.family] = { path: regular.path, checksum: regular.checksum, files };
    }
    renderCatalog = catalog;
  }
  return renderCatalog;
};

/** The worker input id of one file of a font entry: the entry key, `#`, the file name. */
export const studioFontFileInputId = (entryKey: string, file: string) => `${entryKey}#${file}`;
