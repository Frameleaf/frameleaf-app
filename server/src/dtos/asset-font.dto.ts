import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * FL-1359: fonts in Boards. A font is an asset of type OTHER in the design workspace. Its thumbnail and
 * preview are a specimen picture; these are the facts read from the file. The file itself is the asset's
 * original (`GET /assets/{id}/original`, served as `font/*`), which a shared link sends only when it
 * allows downloads.
 */
const face = {
  family: z.string().describe('Family name, for example "Source Serif 4"'),
  style: z.string().describe('Style name, for example "Bold Italic"'),
  weight: z
    .int()
    .nullable()
    .describe('Weight class from 1 to 1000 (400 is regular), or null when the file does not say'),
  italic: z.boolean(),
  glyphCount: z.int().describe('How many glyphs the face holds; 0 when unknown'),
};

const AssetFontFaceSchema = z.object(face).meta({ id: 'AssetFontFaceDto' });

const AssetFontAxisSchema = z
  .object({
    tag: z.string().describe('The axis tag, for example "wght"'),
    name: z.string().describe('The name the font gives the axis, for example "Weight"'),
    min: z.number().meta({ format: 'double' }),
    default: z.number().meta({ format: 'double' }),
    max: z.number().meta({ format: 'double' }),
  })
  .meta({ id: 'AssetFontAxisDto' });

const AssetFontInstanceSchema = z
  .object({
    name: z.string().describe('A named style of a variable font, for example "SemiBold"'),
    coordinates: z.record(z.string(), z.number().meta({ format: 'double' })).describe('Axis tag to value'),
  })
  .meta({ id: 'AssetFontInstanceDto' });

export const AssetFontSchema = z
  .object({
    ...face,
    axes: z.array(AssetFontAxisSchema).describe('Variable-font axes; empty for a static font'),
    instances: z.array(AssetFontInstanceSchema).describe('Named styles of a variable font'),
    features: z.array(z.string()).describe('OpenType feature tags the font offers, for example "liga"'),
    scripts: z
      .array(z.string())
      .describe('Writing systems the font covers, as lower-case names such as "latin", "cyrillic", "han"'),
    license: z.string().nullable().describe('The licence text the file carries, if any'),
    licenseUrl: z.string().nullable().describe('The licence link the file carries, if any'),
    faces: z.array(AssetFontFaceSchema).describe('Every face of a font collection; empty for a single font'),
    browserLoadable: z
      .boolean()
      .describe(
        'True when a browser can load the original itself (TTF, OTF, WOFF, WOFF2) for a live type tester. Collections and Type 1 fonts show the specimen picture only.',
      ),
    ready: z.boolean().describe('False until the file has been read; the facts are then placeholders from its name'),
  })
  .meta({ id: 'AssetFontResponseDto' });
export class AssetFontResponseDto extends createZodDto(AssetFontSchema) {}
