import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const PaletteSwatchSchema = z
  .object({
    hex: z.string().regex(/^#[a-f0-9]{6}$/),
    weight: z.number().min(0).max(1).meta({ format: 'double' }),
    oklab: z.tuple([
      z.number().min(0).max(1.000001).meta({ format: 'double' }),
      z.number().min(-0.5).max(0.5).meta({ format: 'double' }),
      z.number().min(-0.5).max(0.5).meta({ format: 'double' }),
    ]),
  })
  .meta({ id: 'PaletteSwatch' });
export const AssetPaletteSchema = z
  .object({
    version: z.literal(1).meta({ id: 'PaletteAlgorithmVersion' }),
    sourceRevision: z.string(),
    status: z.enum(['pending', 'ready', 'failed', 'unavailable']).meta({ id: 'PaletteStatus' }),
    swatches: z.array(PaletteSwatchSchema).max(8),
    hasTransparency: z.boolean(),
    representative: z.enum(['image', 'frame']).meta({ id: 'PaletteRepresentative' }),
  })
  .meta({ id: 'AssetPaletteDto' });
export class AssetPaletteDto extends createZodDto(AssetPaletteSchema) {}
