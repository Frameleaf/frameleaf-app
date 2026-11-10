import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractContainerPreview,
  hasDesignSignature,
  isFireworksPng,
  isRenderedDesign,
} from 'src/utils/design-preview.js';
import { stripPngMetadata } from 'src/utils/image-metadata-strip.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { describe, expect, it } from 'vitest';

const fixture = (name: string) => join('test/fixtures/formats/design', name);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
/** Width and height of a PNG or BMP, to tell the full picture from the small thumbnail beside it. */
const sizeOf = (image: Buffer) =>
  image.subarray(0, 4).equals(PNG)
    ? [image.readUInt32BE(16), image.readUInt32BE(20)]
    : [image.readInt32LE(18), image.readInt32LE(22)];

describe('design files (FL-1358)', () => {
  describe(extractContainerPreview.name, () => {
    it.each([
      ['document.sketch', 'previews/preview.png'],
      ['document.xd', 'preview.png, ahead of the smaller thumbnail.png'],
      ['document.fig', 'thumbnail.png'],
      ['painting.procreate', 'QuickLook/Thumbnail.png'],
      ['painting.kra', 'mergedimage.png, ahead of the smaller preview.png'],
      ['painting.ora', 'mergedimage.png, ahead of the smaller thumbnail'],
      ['drawing.cdr', 'metadata/thumbnails/thumbnail.bmp'],
    ])('reads the picture inside %s (%s)', async (name) => {
      const preview = await extractContainerPreview(fixture(name));
      expect(preview && sizeOf(preview)).toEqual([96, 72]);
    });

    it('finds nothing in a container without a preview, a file that is not a ZIP, or a format with no table entry', async () => {
      await expect(extractContainerPreview(fixture('no-preview.sketch'))).resolves.toBeNull();
      await expect(extractContainerPreview(fixture('no-preview.eps'))).resolves.toBeNull();
      await expect(extractContainerPreview(fixture('flat.psd'))).resolves.toBeNull();
    });

    it('does not take a file that is not a ZIP for one because of its name', async () => {
      // A .kra that is really a PDF: no preview, and no error either.
      const head = readFileSync(fixture('two-pages.pdf'));
      expect(hasDesignSignature('painting.kra', head)).toBe(false);
    });

    it('reports a file that cannot be read rather than calling it empty', async () => {
      await expect(extractContainerPreview(fixture('missing.sketch'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe(hasDesignSignature.name, () => {
    it('accepts every design fixture under its own name', () => {
      for (const name of [
        '16bit.psd',
        '32bit.psd',
        'cmyk.psd',
        'flat.psd',
        'layered-compatible.psd',
        'layered-no-composite.psd',
        'thumbnail-only.psd',
        'wide.psb',
        'two-pages.pdf',
        'pdf-compatible.ai',
        'tiff-preview.eps',
        'no-preview.eps',
        'layer.xcf',
        'document.sketch',
        'document.xd',
        'document.fig',
        'painting.procreate',
        'painting.kra',
        'painting.ora',
        'drawing.cdr',
      ]) {
        expect(hasDesignSignature(name, readFileSync(fixture(name)).subarray(0, 1029)), name).toBe(true);
      }
    });

    it('covers every extension in the design group, so a new one cannot skip its signature', () => {
      const junk = Buffer.from('this is not a design file at all');
      for (const extension of Object.keys(mimeTypes.design)) {
        expect(hasDesignSignature(`file${extension}`, junk), extension).toBe(false);
      }
    });

    it('accepts the older shapes of a format and does not judge other names', () => {
      expect(hasDesignSignature('old.ai', Buffer.from('%!PS-Adobe-3.0'))).toBe(true);
      expect(hasDesignSignature('old.sketch', Buffer.from('SQLite format 3\0'))).toBe(true);
      expect(hasDesignSignature('old.cdr', Buffer.from('RIFF....CDR'))).toBe(true);
      expect(hasDesignSignature('local.fig', Buffer.from('fig-kiwi'))).toBe(true);
      expect(hasDesignSignature('photo.jpg', Buffer.from('anything'))).toBe(true);
    });
  });

  it('knows which design files libvips opens itself', () => {
    expect(['a.psd', 'a.PSB', 'a.xcf', 'a.pdf', 'a.ai'].every((name) => isRenderedDesign(name))).toBe(true);
    expect(['a.sketch', 'a.eps', 'a.kra', 'a.jpg'].some((name) => isRenderedDesign(name))).toBe(false);
  });

  describe('Fireworks PNG', () => {
    it('is told from its private chunks', async () => {
      await expect(isFireworksPng(fixture('fireworks.png'))).resolves.toBe(true);
      // The same picture inside a container is an ordinary PNG, and a PSD is not a PNG at all.
      await expect(isFireworksPng(fixture('flat.psd'))).resolves.toBe(false);
      await expect(isFireworksPng('test/fixtures/formats/jpeg/baseline.jpg')).resolves.toBe(false);
    });

    it('keeps its editable data when metadata is stripped from a copy, and the bytes read are never changed', () => {
      const original = readFileSync(fixture('fireworks.png'));
      const before = Buffer.from(original);
      const stripped = stripPngMetadata(original);
      for (const chunk of ['mkBF', 'mkTS', 'mkBS', 'prVW', 'IDAT']) {
        expect(stripped.includes(chunk, 0, 'latin1'), chunk).toBe(true);
      }
      // Only the text chunk (the "Software" note) is left out of the copy.
      expect(stripped.includes('tEXt', 0, 'latin1')).toBe(false);
      expect(original.equals(before)).toBe(true);
      expect(stripped).not.toBe(original);
    });
  });
});
