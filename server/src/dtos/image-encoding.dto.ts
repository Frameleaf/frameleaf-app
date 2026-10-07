import z from 'zod';

/** Technical color metadata only; never EXIF, capture provenance or display brightness. */
export const ImageEncodingSchema = z
  .object({
    dynamicRange: z.enum(['unknown', 'sdr', 'hdr']),
    container: z.string().max(40).optional(),
    codec: z.string().max(40).optional(),
    bitDepth: z.int().min(1).max(32).optional(),
    colorPrimaries: z.int().min(0).max(65_535).optional(),
    transfer: z.union([z.int().min(0).max(65_535), z.literal('adaptive')]).optional(),
    referenceWhite: z
      .number()
      .meta({ format: 'double' })
      .positive()
      .optional()
      .describe('Processing reference white in cd/m²; not measured display brightness'),
    contentHeadroom: z.number().meta({ format: 'double' }).min(1).optional(),
    gainMap: z.string().max(80).describe('Gain-map interpretation; unknown values do not imply reconstruction support'),
    reconstructionAvailable: z
      .boolean()
      .describe('Decoder can reconstruct this source; does not imply a published HDR rendition or qualified display'),
    fallbackReason: z.string().max(80).optional(),
    renderingPolicy: z.string().max(80).optional(),
    inspectionStatus: z.enum(['identified', 'failed']).optional(),
    width: z.int().positive().optional(),
    height: z.int().positive().optional(),
  })
  .meta({ id: 'ImageEncodingInfo' });

export type ImageEncodingInfo = z.infer<typeof ImageEncodingSchema>;
export const unknownImageEncoding = (): ImageEncodingInfo => ({
  dynamicRange: 'unknown',
  gainMap: 'none',
  reconstructionAvailable: false,
});
