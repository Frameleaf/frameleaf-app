import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * FL-652: Boards annotations. Rectangles, arrows and text drawn over a picture, each with a short note.
 * They are kept beside the asset as one versioned document and never written into the file: saving
 * them changes no bytes and runs no edit. Every position is a fraction of the picture (0..1), measured
 * from its top-left corner, so the drawing fits any preview size.
 */
export const ASSET_ANNOTATION_LIMIT = 200;
export const ASSET_ANNOTATION_NOTE_MAX = 280;
export const ASSET_ANNOTATION_TEXT_MAX = 200;
/** Rounding slack, so a shape that touches the edge after float maths still fits the picture. */
const EDGE = 1e-6;

export const AssetAnnotationKindSchema = z.enum(['rect', 'arrow', 'text']).meta({ id: 'AssetAnnotationKind' });
export type AssetAnnotationKind = z.infer<typeof AssetAnnotationKindSchema>;
export const AssetAnnotationOriginSchema = z.enum(['eagle']).meta({ id: 'AssetAnnotationOrigin' });

const AssetAnnotationsVersionSchema = z.literal(1).meta({ id: 'AssetAnnotationsVersion' });
const fraction = z.number().min(0).max(1).meta({ format: 'double' });

export const AssetAnnotationGeometrySchema = z
  .strictObject({
    x: fraction.describe('Left edge of a rectangle, tail of an arrow, or the start of a text label'),
    y: fraction.describe('Top edge of a rectangle, tail of an arrow, or the baseline of a text label'),
    width: fraction.optional().describe('Rectangles only'),
    height: fraction.optional().describe('Rectangles only'),
    endX: fraction.optional().describe('Arrows only: where the arrow points'),
    endY: fraction.optional().describe('Arrows only: where the arrow points'),
  })
  .meta({ id: 'AssetAnnotationGeometry' });

export const AssetAnnotationItemSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    kind: AssetAnnotationKindSchema,
    geometry: AssetAnnotationGeometrySchema,
    text: z.string().max(ASSET_ANNOTATION_TEXT_MAX).optional().describe('Text annotations only: the words drawn'),
    note: z.string().max(ASSET_ANNOTATION_NOTE_MAX).optional(),
    origin: AssetAnnotationOriginSchema.optional().describe('Set when the annotation was brought over from Eagle'),
  })
  .superRefine((item, context) => {
    const { x, y, width, height, endX, endY } = item.geometry;
    const issue = (message: string) => context.addIssue({ code: 'custom', message, path: ['geometry'] });
    const hasSize = width !== undefined || height !== undefined;
    const hasEnd = endX !== undefined || endY !== undefined;
    if (item.kind === 'rect') {
      if (width === undefined || height === undefined || hasEnd) issue('A rectangle has a width and height only');
      else if (width <= 0 || height <= 0 || x + width > 1 + EDGE || y + height > 1 + EDGE)
        issue('A rectangle must sit inside the picture');
    } else if (item.kind === 'arrow') {
      if (endX === undefined || endY === undefined || hasSize) issue('An arrow has an end point only');
    } else if (hasSize || hasEnd) {
      issue('Text has a position only');
    }
    if (item.text !== undefined && item.kind !== 'text')
      context.addIssue({ code: 'custom', message: 'Only text annotations carry text', path: ['text'] });
  })
  .meta({ id: 'AssetAnnotationItem' });
export type AssetAnnotationItem = z.infer<typeof AssetAnnotationItemSchema>;

export const AssetAnnotationItemsSchema = z
  .array(AssetAnnotationItemSchema)
  .max(ASSET_ANNOTATION_LIMIT)
  .refine((items) => new Set(items.map(({ id }) => id)).size === items.length, 'Annotation IDs must be unique');

/** Replaces the whole document: the list order is the numbering shown on the picture. */
export const AssetAnnotationsUpdateSchema = z
  .strictObject({
    version: AssetAnnotationsVersionSchema,
    sourceRevision: z
      .string()
      .min(1)
      .max(64)
      .describe(
        'The sourceRevision from the annotations the caller read. If the picture changed since then the request is refused with 409 and nothing is saved, unless this is the revision already stored with the annotations: they are then saved and stay marked as drawn on the older picture. After a 409, read the annotations again.',
      ),
    items: AssetAnnotationItemsSchema,
  })
  .meta({ id: 'AssetAnnotationsUpdateDto' });
export class AssetAnnotationsUpdateDto extends createZodDto(AssetAnnotationsUpdateSchema) {}

export const AssetAnnotationsSchema = z
  .object({
    version: AssetAnnotationsVersionSchema,
    sourceRevision: z.string().describe('Fingerprint of the picture the annotations were drawn on'),
    sourceChanged: z
      .boolean()
      .describe('True when the picture has changed (for example cropped) since the annotations were saved'),
    canEdit: z.boolean().describe('Whether the caller may replace these annotations; only the owner can'),
    items: z.array(AssetAnnotationItemSchema).max(ASSET_ANNOTATION_LIMIT),
    updatedAt: z.string().nullable().describe('When the annotations were last saved; null when there are none'),
  })
  .meta({ id: 'AssetAnnotationsDto' });
export class AssetAnnotationsDto extends createZodDto(AssetAnnotationsSchema) {}
