import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ImmichHeader } from 'src/enum.js';

const normalizeHlsHeaders = (headers: unknown) => {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return headers;
  const values = headers as Record<string, unknown>;
  return {
    ...values,
    [ImmichHeader.HlsInitSegment]: Object.hasOwn(values, ImmichHeader.HlsInitSegment)
      ? values[ImmichHeader.HlsInitSegment]
      : values['x-immich-hls-msn'],
    [ImmichHeader.HlsPosition]: Object.hasOwn(values, ImmichHeader.HlsPosition)
      ? values[ImmichHeader.HlsPosition]
      : values['x-immich-hls-pos'],
  };
};

const HlsSessionParamSchema = z.object({
  id: z.uuidv4(),
  sessionId: z.uuidv4(),
});

export class HlsSessionParamDto extends createZodDto(HlsSessionParamSchema) {}

const HlsVariantParamSchema = z.object({
  id: z.uuidv4(),
  sessionId: z.uuidv4(),
  variantIndex: z.coerce.number().int().min(0),
});

export class HlsVariantParamDto extends createZodDto(HlsVariantParamSchema) {}

const HlsSegmentParamSchema = z.object({
  id: z.uuidv4(),
  sessionId: z.uuidv4(),
  variantIndex: z.coerce.number().int().min(0),
  filename: z.string().regex(/^(init\.mp4|seg_\d+\.m4s)$/, { error: 'Invalid HLS segment filename' }),
});

export class HlsSegmentParamDto extends createZodDto(HlsSegmentParamSchema) {}

const HlsSegmentHeaderSchema = z.object({
  // Lets the client hint at which segment will be loaded after init.mp4.
  [ImmichHeader.HlsInitSegment]: z.coerce.number().int().min(0).optional(),
});

export class HlsSegmentHeaderDto extends createZodDto(z.preprocess(normalizeHlsHeaders, HlsSegmentHeaderSchema)) {}

const HlsPlaylistHeaderSchema = z.object({
  // Lets the client hint at which segment will be loaded after the playlist.
  // A position rather than a segment index since indices aren't comparable across variants.
  [ImmichHeader.HlsPosition]: z.coerce.number().min(0).optional(),
});

export class HlsPlaylistHeaderDto extends createZodDto(z.preprocess(normalizeHlsHeaders, HlsPlaylistHeaderSchema)) {}
