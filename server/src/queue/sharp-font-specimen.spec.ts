import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { SharpOperations } from 'src/queue/sharp-operations.js';

/**
 * FL-1359. What this proves anywhere: the picture's size, the outputs and the plain-tile rung. That the
 * words are set in the font file itself needs fontconfig (Linux, as the server image); macOS's text
 * renderer ignores a font file, so that part is checked by `verify-formats.mjs` in the built image.
 */
describe('font specimen picture', () => {
  const anton = 'resources/studio-fonts/anton-latin-400-normal.ttf';
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'font-specimen-'));
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it.each([
    ['set in the font', anton],
    ['a plain tile when the font cannot be used', null],
  ])(
    'writes a preview and a thumbnail of a fixed-size picture: %s',
    async (_name, font) => {
      const outputs = [
        { path: join(directory, 'preview.jpeg'), size: 1440, format: 'jpeg' as const, quality: 80 },
        { path: join(directory, 'thumbnail.webp'), size: 250, format: 'webp' as const, quality: 80 },
      ];
      const thumbhash = await new SharpOperations().renderFontSpecimen(
        font,
        { family: 'Anton', text: 'Aa <b>&</b> Bb\nHandgloves 0123' },
        outputs,
      );

      expect(thumbhash.byteLength).toBeGreaterThan(4);
      const preview = await sharp(outputs[0].path).metadata();
      expect([preview.format, preview.width, preview.height]).toEqual(['jpeg', 1440, 1080]);
      const thumbnail = await sharp(outputs[1].path).metadata();
      expect([thumbnail.format, thumbnail.width, thumbnail.height]).toEqual(['webp', 250, 188]);
      // white paper with dark words on it, inside the margin
      const { channels } = await sharp(outputs[0].path).stats();
      expect(channels[0].max).toBeGreaterThan(250);
      expect(channels[0].min).toBeLessThan(60);
      const corner = await sharp(outputs[0].path)
        .extract({ left: 0, top: 0, width: 100, height: 100 })
        .raw()
        .toBuffer();
      expect(Math.min(...corner)).toBeGreaterThan(240);
    },
    120_000,
  );
});
