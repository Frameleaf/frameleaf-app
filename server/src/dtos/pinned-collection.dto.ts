import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const PIN_LIMIT = 50;
export const BUILTIN_PIN_IDS = [
  'favourites',
  'photos',
  'videos',
  'live-photos',
  'archive',
  'locked',
  'recently-deleted',
] as const;

const PinKindSchema = z.enum(['album', 'smart-album', 'saved-search', 'person', 'pet', 'memory', 'builtin']);

export const PinnedCollectionRefSchema = z
  .strictObject({
    id: z.uuid().describe('Opaque pin ID chosen by the client and retained across reorders'),
    kind: PinKindSchema,
    targetId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .nullable()
      .describe(
        'Target UUID, saved-search name, or built-in ID. Null retains an existing unavailable pin by its opaque ID',
      ),
  })
  .superRefine((pin, ctx) => {
    if (pin.targetId === null) {
      return;
    }
    const valid =
      pin.kind === 'builtin'
        ? (BUILTIN_PIN_IDS as readonly string[]).includes(pin.targetId)
        : pin.kind === 'saved-search' || z.uuidv4().safeParse(pin.targetId).success;
    if (!valid) {
      ctx.addIssue({ code: 'custom', path: ['targetId'], message: 'Invalid pin target' });
    }
  })
  .meta({ id: 'PinnedCollectionRef' });

export type StoredPinnedCollection = Omit<z.infer<typeof PinnedCollectionRefSchema>, 'targetId'> & { targetId: string };

const PinsUpdateSchema = z
  .strictObject({
    expectedRevision: z
      .uuid()
      .nullable()
      .describe('Revision returned by GET; null only when no pin list exists. A stale save returns 409'),
    pins: z
      .array(PinnedCollectionRefSchema)
      .max(PIN_LIMIT)
      .refine((pins) => new Set(pins.map(({ id }) => id)).size === pins.length, {
        message: 'Each pin ID may appear only once',
      })
      .describe('Replace the complete ordered list to add, remove or reorder pins; an empty list clears it'),
  })
  .meta({ id: 'PinnedCollectionsUpdateDto' });

export const PinnedCollectionSchema = z
  .object({
    id: z.uuid(),
    kind: PinKindSchema,
    targetId: z
      .string()
      .nullable()
      .describe('Null when unavailable; the inaccessible target identity is not disclosed'),
    unavailable: z.boolean(),
    title: z.string().nullable().describe('Current access-filtered title; null when unavailable'),
    count: z.int().min(0).nullable().describe('Current access-filtered item count; null when unavailable'),
    countCapped: z.boolean().describe('Whether a semantic saved-search count reached the existing smart-search cap'),
    coverAssetId: z.uuidv4().nullable().describe('Current readable cover asset; null when unavailable or empty'),
  })
  .meta({ id: 'PinnedCollection' });

export const PinnedCollectionsResponseSchema = z
  .object({
    revision: z.uuid().nullable(),
    pins: z
      .array(PinnedCollectionSchema)
      .describe('Complete replacement snapshot in user order, including unavailable pins'),
  })
  .meta({ id: 'PinnedCollectionsResponseDto' });

export class PinnedCollectionsUpdateDto extends createZodDto(PinsUpdateSchema) {}
export class PinnedCollectionsResponseDto extends createZodDto(PinnedCollectionsResponseSchema) {}
