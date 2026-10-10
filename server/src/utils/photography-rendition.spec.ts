import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { PhotographyWatermarkSchema } from 'src/dtos/photography-rendition.dto.js';
import { preparePhotographyLogo, renderPhotographyRendition } from 'src/utils/photography-rendition.js';

const mark = (patch: object = {}) => PhotographyWatermarkSchema.parse({ text: 'North & <Studio>', ...patch });
const image = (width = 320, height = 240, background = '#204060') =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();
const pixels = (input: Buffer) => sharp(input).removeAlpha().raw().toBuffer();
const digest = (input: Buffer) => createHash('sha256').update(input).digest('hex');

describe('photography pixel renditions', () => {
  it('burns script/text/second-line pixels into a metadata-stripped sRGB JPEG without mutating the source', async () => {
    const source = await sharp(await image())
      .withExif({ IFD0: { Artist: 'Private studio' }, IFD3: { GPSLatitude: '47/1 0/1 0/1', GPSLatitudeRef: 'N' } })
      .png()
      .toBuffer();
    const before = digest(source);
    const clean = await renderPhotographyRendition(source, null);
    const proof = await renderPhotographyRendition(source, mark({ secondLine: 'PROOF', outline: true }));
    const metadata = await sharp(proof).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', space: 'srgb', width: 320, height: 240 });
    expect(metadata.icc).toBeInstanceOf(Buffer);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(await pixels(proof)).not.toEqual(await pixels(clean));
    expect(digest(source)).toBe(before);
  }, 15_000);
  it('applies EXIF orientation before sizing and signature placement', async () => {
    const source = await sharp(await image(400, 200))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const proof = await renderPhotographyRendition(source, mark({ size: 15, opacity: 100 }), undefined, 200);
    expect(await sharp(proof).metadata()).toMatchObject({ width: 100, height: 200 });
    const { data, info } = await sharp(proof).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let top = 0;
    let bottom = 0;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 3] > 100) {
          if (y < info.height / 2) {
            top++;
          } else {
            bottom++;
          }
        }
      }
    expect(bottom).toBeGreaterThan(top);
  });
  it.each([
    [240, 700],
    [700, 240],
  ])('tiles across the entire %i × %i output', async (width, height) => {
    const output = await renderPhotographyRendition(
      await image(width, height, '#000000'),
      mark({ pattern: 'tile', size: 10, opacity: 100, rotation: -24, spacing: 2 }),
    );
    const { data } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3; col++) {
        let count = 0;
        for (let y = Math.floor((row * height) / 3); y < ((row + 1) * height) / 3; y++)
          for (let x = Math.floor((col * width) / 3); x < ((col + 1) * width) / 3; x++)
            count += Number(data[(y * width + x) * 3] > 60);
        expect(count).toBeGreaterThan(5);
      }
  });
  it('fits long escaped studio names and exposes independent font/geometry/contrast controls in the pixels', async () => {
    const source = await image();
    const baseline = await renderPhotographyRendition(source, mark());
    for (const patch of [
      { font: 'serif' },
      { font: 'sans' },
      { pattern: 'centre' },
      { pattern: 'diagonal', rotation: 30 },
      { pattern: 'tile', spacing: 40 },
      { alignment: 'right', secondLine: 'PROOF' },
      { position: 'top-left' },
      { margin: 15 },
      { size: 12 },
      { opacity: 90 },
      { color: '#ff4400' },
      { backing: true },
      { outline: true },
      { secondLine: 'Proof • not retouched' },
    ]) {
      expect(await pixels(await renderPhotographyRendition(source, mark(patch)))).not.toEqual(await pixels(baseline));
    }
    await expect(
      renderPhotographyRendition(
        source,
        mark({ text: '<span foreground="red">' + 'Long Studio '.repeat(12), rotation: 90 }),
      ),
    ).resolves.toBeInstanceOf(Buffer);
  });
  it('validates actual logo bytes, preserves transparency, crops padding and makes light/dark variants', async () => {
    const logo = await sharp({ create: { width: 120, height: 100, channels: 4, background: '#00000000' } })
      .composite([
        { input: await image(20, 40, '#ff3300'), left: 30, top: 30 },
        { input: await image(20, 40, '#ff3300'), left: 70, top: 30 },
      ])
      .png()
      .toBuffer();
    const variants = await preparePhotographyLogo(logo);
    for (const output of Object.values(variants))
      expect(await sharp(output).metadata()).toMatchObject({ width: 60, height: 40, format: 'png', hasAlpha: true });
    const lightPixels = await sharp(variants.light).raw().toBuffer();
    expect(lightPixels[(20 * 60 + 30) * 4 + 3]).toBe(0);
    expect(lightPixels[(20 * 60 + 10) * 4 + 3]).toBe(255);
    const source = await image();
    const a = await renderPhotographyRendition(source, mark({ type: 'both', logoPosition: 'left' }), logo);
    const b = await renderPhotographyRendition(
      source,
      mark({ type: 'both', logoPosition: 'below', logoVariant: 'light' }),
      logo,
    );
    expect(await pixels(a)).not.toEqual(await pixels(b));
    expect(await pixels(await renderPhotographyRendition(source, mark({ type: 'logo' }), logo))).not.toEqual(
      await pixels(await renderPhotographyRendition(source, null)),
    );
    await expect(preparePhotographyLogo(Buffer.from('<svg/>'))).rejects.toThrow();
    await expect(preparePhotographyLogo(Buffer.alloc(512_001))).rejects.toThrow();
    await expect(preparePhotographyLogo(await image(4097, 2))).rejects.toThrow();
    await expect(preparePhotographyLogo(logo.subarray(0, 60))).rejects.toThrow();
    await expect(renderPhotographyRendition(source, mark({ type: 'logo' }))).rejects.toThrow();
  });
  it.each(['jpeg', 'png', 'webp'] as const)(
    'preserves opaque %s artwork contrast and transparent PNG shape in light/dark variants',
    async (format) => {
      const artwork = await sharp({ create: { width: 100, height: 60, channels: 3, background: '#ffffff' } })
        .composite([
          { input: await image(20, 40, '#101010'), left: 10, top: 10 },
          { input: await image(20, 40, '#101010'), left: 70, top: 10 },
        ])
        .ensureAlpha()
        .toFormat(format)
        .toBuffer();
      const variants = await preparePhotographyLogo(artwork);
      for (const variant of ['light', 'dark'] as const) {
        const { data, info } = await sharp(variants[variant]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const letter = data[(20 * info.width + 10) * 4];
        const gap = data[(20 * info.width + 40) * 4];
        expect(Math.abs(letter - gap)).toBeGreaterThan(150);
        expect(variant === 'light' ? letter > gap : letter < gap).toBe(true);
      }
      const transparent = await sharp({ create: { width: 80, height: 40, channels: 4, background: '#00000000' } })
        .composite([
          { input: await image(20, 40, '#101010'), left: 0, top: 0 },
          { input: await image(20, 40, '#101010'), left: 60, top: 0 },
        ])
        .png()
        .toBuffer();
      const transparentVariants = await preparePhotographyLogo(transparent);
      for (const variant of ['light', 'dark'] as const) {
        const data = await sharp(transparentVariants[variant]).raw().toBuffer();
        expect(data[(20 * 80 + 10) * 4]).toBe(variant === 'light' ? 255 : 0);
        expect(data[(20 * 80 + 10) * 4 + 3]).toBe(255);
        expect(data[(20 * 80 + 40) * 4 + 3]).toBe(0);
      }
    },
  );
  it('rejects unknown control fields and invalid output limits without falling back to a clean image', async () => {
    const source = await image();
    expect(() => mark({ css: 'hidden' })).toThrow();
    await expect(renderPhotographyRendition(source, mark(), undefined, 0)).rejects.toThrow();
    const final = await renderPhotographyRendition(source, null, undefined, 65_535);
    expect(await sharp(final).metadata()).toMatchObject({ width: 320, height: 240 });
    await expect(renderPhotographyRendition(Buffer.from('broken'), mark())).rejects.toThrow();
  });
});
