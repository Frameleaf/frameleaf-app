import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** FL-869 custom photo order and FL-881 text cards. */

export const TEXT_CARD_HEADING_MAX = 120;
export const TEXT_CARD_BODY_MAX = 2000;
export const ALBUM_ORDER_MAX_ASSETS = 10_000;

const afterAssetId = z
  .uuid()
  .nullable()
  .optional()
  .describe('Place after this photo in the album; null places at the start of the album');
const afterTextCardId = z.uuid().optional().describe('Place after this text card instead of after a photo');

const AlbumAssetOrderSchema = z
  .object({
    assetIds: z
      .array(z.uuid())
      .min(1)
      .max(ALBUM_ORDER_MAX_ASSETS)
      .describe('Photos to move, in the order they should appear. Ids not in the album are ignored.'),
    afterAssetId,
    afterTextCardId,
  })
  .refine(
    (value) => value.afterAssetId !== undefined || value.afterTextCardId !== undefined,
    'Say where the photos go: afterAssetId (null for the start) or afterTextCardId',
  )
  .refine((value) => !value.afterAssetId || !value.afterTextCardId, 'Use afterAssetId or afterTextCardId, not both')
  .refine(
    (value) => !value.afterAssetId || !value.assetIds.includes(value.afterAssetId),
    'A photo cannot be placed after itself',
  )
  .meta({ id: 'AlbumAssetOrderDto' });

const AlbumTextCardCreateSchema = z
  .object({
    heading: z.string().max(TEXT_CARD_HEADING_MAX).default('').describe('Heading, plain text'),
    body: z.string().max(TEXT_CARD_BODY_MAX).default('').describe('Short paragraph, plain text; new lines are kept'),
    afterAssetId,
    afterTextCardId,
  })
  .refine((value) => !value.afterAssetId || !value.afterTextCardId, 'Use afterAssetId or afterTextCardId, not both')
  .describe('Leave out afterAssetId and afterTextCardId to add the card at the end of the album')
  .meta({ id: 'AlbumTextCardCreateDto' });

const AlbumTextCardUpdateSchema = z
  .object({
    heading: z.string().max(TEXT_CARD_HEADING_MAX).optional().describe('Heading, plain text'),
    body: z.string().max(TEXT_CARD_BODY_MAX).optional().describe('Short paragraph, plain text; new lines are kept'),
    afterAssetId,
    afterTextCardId,
  })
  .refine((value) => !value.afterAssetId || !value.afterTextCardId, 'Use afterAssetId or afterTextCardId, not both')
  .describe('Leave out afterAssetId and afterTextCardId to keep the card where it is')
  .meta({ id: 'AlbumTextCardUpdateDto' });

const AlbumTextCardParamSchema = z.object({
  id: z.uuidv4().describe('Album ID'),
  cardId: z.uuid().describe('Text card ID'),
});

const AlbumTextCardResponseSchema = z
  .object({
    id: z.string().describe('Text card ID'),
    albumId: z.string().describe('Album ID'),
    heading: z.string().describe('Heading, plain text; show it as text, never as HTML'),
    body: z.string().describe('Short paragraph, plain text with new lines; show it as text, never as HTML'),
    position: z
      .number()
      .meta({ format: 'double' })
      .describe("Place in the album's custom order; compare with the photos' positions from sort=custom"),
    afterAssetId: z
      .string()
      .nullable()
      .describe('The photo just before the card in the album, or null when the card comes first'),
    createdById: z.string().nullable().describe('Who wrote the card, or null when that account was removed'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    createdAt: z.string().meta({ format: 'date-time' }).describe('Creation date'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    updatedAt: z.string().meta({ format: 'date-time' }).describe('Last update date'),
  })
  .meta({ id: 'AlbumTextCardResponseDto' });

export class AlbumAssetOrderDto extends createZodDto(AlbumAssetOrderSchema) {}
export class AlbumTextCardCreateDto extends createZodDto(AlbumTextCardCreateSchema) {}
export class AlbumTextCardUpdateDto extends createZodDto(AlbumTextCardUpdateSchema) {}
export class AlbumTextCardParamDto extends createZodDto(AlbumTextCardParamSchema) {}
export class AlbumTextCardResponseDto extends createZodDto(AlbumTextCardResponseSchema) {}
export { AlbumTextCardResponseSchema };
