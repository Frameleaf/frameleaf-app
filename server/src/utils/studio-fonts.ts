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
