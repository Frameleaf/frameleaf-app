import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { CastMediaKind } from 'src/utils/cast-media.js';

const CastMediaKindSchema = z
  .enum(CastMediaKind)
  .describe('Which rendition the receiver gets: the original file, the edited preview image, or the video stream')
  .meta({ id: 'CastMediaKind' });

const CastMediaUrlCreateSchema = z
  .object({
    kind: CastMediaKindSchema,
  })
  .meta({ id: 'CastMediaUrlCreateDto' });
export class CastMediaUrlCreateDto extends createZodDto(CastMediaUrlCreateSchema) {}

const CastMediaUrlResponseSchema = z
  .object({
    assetId: z.uuid().describe('The one item this URL serves'),
    kind: CastMediaKindSchema,
    path: z
      .string()
      .describe(
        'The signed URL path (`/api/cast/{token}`), relative to the server origin. Prefix the server address the Cast receiver can reach. Works without a session token or cookies until `expiresAt`; never contains a session token.',
      ),
    expiresAt: z.iso.datetime().describe('When the URL stops working (15 minutes after it was issued)'),
  })
  .meta({ id: 'CastMediaUrlResponseDto' });
export class CastMediaUrlResponseDto extends createZodDto(CastMediaUrlResponseSchema) {}

const CastMediaTokenParamSchema = z.object({
  token: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[\w-]+\.[\w-]+$/)
    .describe('The signed Cast token'),
});
export class CastMediaTokenParamDto extends createZodDto(CastMediaTokenParamSchema) {}
