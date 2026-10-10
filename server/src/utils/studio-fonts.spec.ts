import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findStudioBundledFont, studioBundledFontFamilies, studioBundledFontPath } from 'src/utils/studio-fonts.js';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * The generated catalogue against the packages actually installed: the same check
 * `node scripts/frameleaf-studio-fonts.mjs` makes, run with the server unit tests so a package
 * update that changes a byte cannot ship behind a stale hash.
 */
describe('bundled Studio title fonts', () => {
  it('names files whose bytes have the recorded size and hash, in pinned OFL packages', () => {
    for (const family of studioBundledFontFamilies()) {
      const first = studioBundledFontPath(
        family,
        family.files.find((file) => file.format === 'woff2')!,
      );
      const root = dirname(dirname(first));
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        version: string;
        license: string;
      };
      expect(manifest.version, family.package).toBe(family.version);
      expect(manifest.license, family.package).toBe('OFL-1.1');
      const licence = readFileSync(join(root, 'LICENSE'), 'utf8');
      expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(licence.split('\n', 1)[0].trim()).toBe(family.copyright);
      expect(sha256(licence)).toBe(family.licenseSha256);
      for (const file of family.files) {
        const bytes = readFileSync(studioBundledFontPath(family, file));
        expect(bytes.length, file.file).toBe(file.size);
        expect(sha256(bytes), file.file).toBe(file.sha256);
        // wOF2, or sfnt version 1.0 for a decoded TrueType font
        expect(bytes.subarray(0, 4).toString('hex'), file.file).toBe(file.format === 'ttf' ? '00010000' : '774f4632');
        if (file.format === 'ttf') {
          // the decode keeps the table count and glyph count the generator recorded from the WOFF2
          expect(bytes.readUInt16BE(4), file.file).toBe(file.tables);
          expect(
            family.files.some((source) => source.sha256 === file.decodedFrom),
            file.file,
          ).toBe(true);
        }
      }
    }
  });

  it('finds a file only by a whole lower-case hash of the catalogue', () => {
    const [family] = studioBundledFontFamilies();
    const [file] = family.files;
    expect(findStudioBundledFont(file.sha256)?.file).toBe(file);
    expect(findStudioBundledFont(file.sha256.slice(0, 63))).toBeUndefined();
    expect(findStudioBundledFont(`${file.sha256} `)).toBeUndefined();
    expect(findStudioBundledFont(file.file)).toBeUndefined();
    expect(findStudioBundledFont('__proto__')).toBeUndefined();
  });

  it('pins every font package to an exact version in package.json', () => {
    const dependencies = (
      JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      }
    ).dependencies;
    for (const family of studioBundledFontFamilies()) {
      expect(dependencies[family.package], family.package).toBe(family.version);
    }
  });
});
