import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto.js';
import { UserResponseSchema } from 'src/dtos/user.dto.js';

/**
 * FL-83 (AL-30b): sharing individual items with people in this library, the prototype's "Share
 * with people in this library" (`SharedLinks.jsx:425-590`). The owner shares a set of items with
 * people ("Save sharing") or stops sharing them; each recipient sees those items in their own
 * Frameleaf, under Sharing › Shared with you.
 */

const MAX_ITEMS = 1000;
const MAX_PEOPLE = 100;

const ItemShareChangeSchema = z
  .object({
    assetIds: z.array(z.uuidv4()).min(1).max(MAX_ITEMS).describe('The items (your own) to share or stop sharing'),
    userIds: z
      .array(z.uuidv4())
      .min(1)
      .max(MAX_PEOPLE)
      .describe('The people in this library to share them with, or to stop sharing them with'),
  })
  .meta({ id: 'ItemShareChangeDto' });

const ItemShareQuerySchema = z
  .object({
    assetIds: z.array(z.uuidv4()).min(1).max(MAX_ITEMS).describe('The items (your own) to list the shares of'),
  })
  .meta({ id: 'ItemShareQueryDto' });

const ItemShareResponseSchema = z
  .object({
    id: z.uuidv4().describe('Share ID'),
    assetId: z.uuidv4().describe('The shared item'),
    sharedWith: UserResponseSchema.describe('Who the item is shared with'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When it was shared'),
  })
  .meta({ id: 'ItemShareResponseDto' });

const ItemShareChangeResponseSchema = z
  .object({
    shares: z.array(ItemShareResponseSchema).describe('Every share of these items after the change'),
    added: z.int().min(0).describe('Shares this change added'),
    removed: z.int().min(0).describe('Shares this change removed'),
    link: z
      .string()
      .nullable()
      .describe(
        'Where recipients open what is shared with them: the Public server URL when set, otherwise the direct-connection address (or a custom hostname pointed at it); null when the server has no address',
      ),
  })
  .meta({ id: 'ItemShareChangeResponseDto' });

const ItemShareReceivedSchema = z
  .object({
    id: z.uuidv4().describe('Share ID'),
    sharedAt: z.string().meta({ format: 'date-time' }).describe('When it was shared'),
    owner: UserResponseSchema.describe('Who shared it'),
    asset: AssetResponseSchema.describe('The shared item'),
  })
  .meta({ id: 'ItemShareReceivedDto' });

const ItemShareReceivedResponseSchema = z
  .object({
    items: z.array(ItemShareReceivedSchema).describe('Items shared with you, newest share first'),
    link: z.string().nullable().describe('The address of this list, as sent in share notifications'),
  })
  .meta({ id: 'ItemShareReceivedResponseDto' });

export class ItemShareChangeDto extends createZodDto(ItemShareChangeSchema) {}
export class ItemShareQueryDto extends createZodDto(ItemShareQuerySchema) {}
export class ItemShareResponseDto extends createZodDto(ItemShareResponseSchema) {}
export class ItemShareChangeResponseDto extends createZodDto(ItemShareChangeResponseSchema) {}
export class ItemShareReceivedDto extends createZodDto(ItemShareReceivedSchema) {}
export class ItemShareReceivedResponseDto extends createZodDto(ItemShareReceivedResponseSchema) {}
