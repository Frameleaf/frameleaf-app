import { BadRequestException } from '@nestjs/common';
import { access, constants, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';
import { type PhotographyWatermark, PhotographyWatermarkSchema } from 'src/dtos/photography-rendition.dto.js';

const transparent = '#00000000';
const fontRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../resources/fonts');
const fonts = {
  script: { name: 'Great Vibes', file: 'great-vibes.ttf' },
  serif: { name: 'Noto Serif', file: 'noto-serif.ttf' },
  sans: { name: 'Google Sans', file: 'google-sans.ttf' },
};
const escape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const canvas = (width: number, height: number, background = transparent) =>
  sharp({ create: { width, height, channels: 4, background } });

/** Use after current asset ownership/Locked checks. No original is modified. */
export async function readPhotographyLogo(path: string): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > 512_000) throw new BadRequestException('Logo must be at most 512 KB');
    const buffer = Buffer.alloc(512_001);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const input = buffer.subarray(0, bytesRead);
    await preparePhotographyLogo(input);
    return input;
  } finally {
    await file.close();
  }
}

/** Validate the decoder content and fully decode before producing transparent, metadata-free variants. */
export async function preparePhotographyLogo(
  input: Buffer,
): Promise<{ original: Buffer; light: Buffer; dark: Buffer }> {
  if (input.length === 0 || input.length > 512_000) throw new BadRequestException('Logo must be at most 512 KB');
  try {
    const source = sharp(input, { failOn: 'warning', limitInputPixels: 16_000_000 });
    const metadata = await source.metadata();
    if (
      !['png', 'jpeg', 'webp'].includes(metadata.format ?? '') ||
      (metadata.pages ?? 1) !== 1 ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 4096 ||
      metadata.height > 4096
    )
      throw new Error('Unsupported logo');
    const { data, info } = await source
      .autoOrient()
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alpha = data.some((value, index) => index % 4 === 3 && value < 255);
    let left = info.width,
      top = info.height,
      right = -1,
      bottom = -1;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const offset = (y * info.width + x) * 4;
        const visible = alpha ? data[offset + 3] > 0 : [0, 1, 2].some((c) => Math.abs(data[offset + c] - data[c]) > 8);
        if (visible) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    if (right < left) {
      if (alpha) throw new Error('Empty logo');
      left = 0;
      top = 0;
      right = info.width - 1;
      bottom = info.height - 1;
    }
    const cropped = await sharp(data, { raw: info })
      .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const original = await sharp(cropped.data, { raw: cropped.info }).png().toBuffer();
    // Opaque uploads retain artwork contrast; only real transparency supplies a monochrome silhouette.
    if (!alpha)
      return {
        original,
        light: await sharp(original).greyscale().negate({ alpha: false }).toColourspace('srgb').png().toBuffer(),
        dark: await sharp(original).greyscale().toColourspace('srgb').png().toBuffer(),
      };
    const monochrome = async (color: number) => {
      const output = Buffer.from(cropped.data);
      for (let i = 0; i < output.length; i += 4) {
        output[i] = color;
        output[i + 1] = color;
        output[i + 2] = color;
      }
      return sharp(output, { raw: cropped.info }).png().toBuffer();
    };
    return { original, light: await monochrome(255), dark: await monochrome(0) };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('Logo must be a complete single-frame PNG, JPEG or WebP within 4096 pixels per edge');
  }
}

async function renderText(text: string, font: keyof typeof fonts, size: number, color: string, maxWidth: number) {
  const selected = fonts[font];
  await access(resolve(fontRoot, selected.file), constants.R_OK);
  return sharp({
    text: {
      text: `<span foreground="${color}">${escape(text)}</span>`,
      font: `${selected.name} ${Math.max(1, size)}`,
      fontfile: resolve(fontRoot, selected.file),
      width: maxWidth,
      height: Math.max(2, Math.round(size * 1.4)),
      wrap: 'none',
      rgba: true,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
}

async function watermarkImage(watermark: PhotographyWatermark, edge: number, logo?: Buffer) {
  const size = Math.max(2, Math.round(((edge * watermark.size) / 100) * (watermark.pattern === 'diagonal' ? 1.6 : 1)));
  const gap = Math.max(1, Math.round(size * 0.15));
  const pieces: { data: Buffer; width: number; height: number }[] = [];
  if (watermark.type !== 'logo') {
    const name = await renderText(
      watermark.text,
      watermark.font,
      size,
      watermark.color,
      Math.max(1, Math.round(edge * 0.9)),
    );
    pieces.push({ data: name.data, width: name.info.width, height: name.info.height });
  }
  if (watermark.secondLine) {
    const line = await renderText(
      watermark.secondLine,
      'sans',
      Math.max(2, size * 0.28),
      watermark.color,
      Math.max(1, Math.round(edge * 0.9)),
    );
    pieces.push({ data: line.data, width: line.info.width, height: line.info.height });
  }
  let text: Buffer | undefined;
  if (pieces.length > 0) {
    const width = Math.max(...pieces.map((piece) => piece.width));
    let top = 0;
    text = await canvas(width, pieces.reduce((sum, piece) => sum + piece.height, 0) + gap * (pieces.length - 1))
      .composite(
        pieces.map((piece) => {
          const position = {
            input: piece.data,
            left:
              watermark.alignment === 'left'
                ? 0
                : watermark.alignment === 'right'
                  ? width - piece.width
                  : Math.floor((width - piece.width) / 2),
            top,
          };
          top += piece.height + gap;
          return position;
        }),
      )
      .png()
      .toBuffer();
  }
  let logoImage: Buffer | undefined;
  if (watermark.type !== 'text') {
    if (!logo) throw new BadRequestException('The watermark requires an eligible logo');
    const variants = await preparePhotographyLogo(logo);
    logoImage = await sharp(variants[watermark.logoVariant])
      .resize({
        width: Math.max(1, Math.round(size * 3.2 * watermark.logoScale)),
        height: Math.max(1, Math.round(size * 1.4 * watermark.logoScale)),
        fit: 'inside',
      })
      .png()
      .toBuffer();
  }
  if (!text && !logoImage) throw new BadRequestException('Watermark has no visible content');
  let output = text ?? logoImage!;
  if (text && logoImage) {
    const a = await sharp(text).metadata(),
      b = await sharp(logoImage).metadata();
    const horizontal = ['left', 'right'].includes(watermark.logoPosition);
    const width = horizontal ? a.width! + b.width! + gap : Math.max(a.width!, b.width!);
    const height = horizontal ? Math.max(a.height!, b.height!) : a.height! + b.height! + gap;
    const logoFirst = ['left', 'above'].includes(watermark.logoPosition);
    const first = logoFirst
      ? { input: logoImage, width: b.width!, height: b.height! }
      : { input: text, width: a.width!, height: a.height! };
    const second = logoFirst
      ? { input: text, width: a.width!, height: a.height! }
      : { input: logoImage, width: b.width!, height: b.height! };
    output = await canvas(width, height)
      .composite([
        {
          input: first.input,
          left: horizontal ? 0 : Math.floor((width - first.width) / 2),
          top: horizontal ? Math.floor((height - first.height) / 2) : 0,
        },
        {
          input: second.input,
          left: horizontal ? first.width + gap : Math.floor((width - second.width) / 2),
          top: horizontal ? Math.floor((height - second.height) / 2) : first.height + gap,
        },
      ])
      .png()
      .toBuffer();
  }
  // Fit using the actual Pango-rendered glyph bounds, not character-count estimates.
  output = await sharp(output)
    .resize({
      width: Math.max(1, Math.round(edge * 0.9)),
      height: Math.max(1, Math.round(edge * 0.4)),
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const padding = Math.max(2, Math.round(size * 0.15));
  const layers: OverlayOptions[] = [];
  if (watermark.outline) {
    const outline = Buffer.from(data);
    for (let i = 0; i < outline.length; i += 4) {
      outline[i] = 0;
      outline[i + 1] = 0;
      outline[i + 2] = 0;
    }
    const radius = Math.max(1, Math.min(padding, Math.round(size * 0.035)));
    for (const x of [-radius, 0, radius])
      for (const y of [-radius, 0, radius])
        layers.push({ input: outline, raw: info, left: padding + x, top: padding + y });
  }
  layers.push({ input: data, raw: info, left: padding, top: padding });
  output = await canvas(
    info.width + padding * 2,
    info.height + padding * 2,
    watermark.backing ? '#00000088' : transparent,
  )
    .composite(layers)
    .png()
    .toBuffer();
  output = await sharp(output).rotate(watermark.rotation, { background: transparent }).png().toBuffer();
  const rotated = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < rotated.data.length; i += 4)
    rotated.data[i] = Math.round((rotated.data[i] * watermark.opacity) / 100);
  return sharp(rotated.data, { raw: rotated.info }).png().toBuffer();
}

/** Input is an approved edit/base proof; output never inherits EXIF/GPS/XMP or writes the source. */
export async function renderPhotographyRendition(
  input: string | Buffer,
  watermark: PhotographyWatermark | null,
  logo?: Buffer,
  maxEdge?: number,
): Promise<Buffer> {
  if (maxEdge !== undefined && (!Number.isSafeInteger(maxEdge) || maxEdge < 1 || maxEdge > 65_535))
    throw new BadRequestException('Invalid rendition size');
  const parsed = watermark === null ? null : PhotographyWatermarkSchema.parse(watermark);
  const base = await sharp(input, { failOn: 'warning', limitInputPixels: 200_000_000 })
    .autoOrient()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .removeAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  if (!parsed)
    return sharp(base.data).withIccProfile('srgb').jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
  const width = base.info.width,
    height = base.info.height,
    edge = Math.min(width, height);
  const margin = Math.round((edge * parsed.margin) / 100);
  let mark = await watermarkImage(parsed, edge, logo);
  mark = await sharp(mark)
    .resize({
      width: Math.max(1, width - 2 * margin),
      height: Math.max(1, height - 2 * margin),
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  const metadata = await sharp(mark).metadata();
  let overlay: OverlayOptions;
  if (parsed.pattern === 'tile') {
    const gap = Math.round((edge * parsed.spacing) / 100);
    const tileWidth = Math.min(width, metadata.width! + gap),
      tileHeight = Math.min(height, metadata.height! + gap);
    const cell = await canvas(tileWidth, tileHeight)
      .composite([
        {
          input: mark,
          left: Math.floor((tileWidth - metadata.width!) / 2),
          top: Math.floor((tileHeight - metadata.height!) / 2),
        },
      ])
      .png()
      .toBuffer();
    overlay = { input: cell, tile: true, gravity: 'centre' };
  } else {
    const centered = parsed.pattern !== 'signature' || parsed.position === 'center';
    const left = centered
      ? Math.floor((width - metadata.width!) / 2)
      : parsed.position.endsWith('left')
        ? margin
        : width - margin - metadata.width!;
    const top = centered
      ? Math.floor((height - metadata.height!) / 2)
      : parsed.position.startsWith('top')
        ? margin
        : height - margin - metadata.height!;
    overlay = { input: mark, left, top };
  }
  return sharp(base.data)
    .composite([overlay])
    .toColourspace('srgb')
    .withIccProfile('srgb')
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
}
