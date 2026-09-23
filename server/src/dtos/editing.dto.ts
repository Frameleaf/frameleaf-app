import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export enum AssetEditAction {
  Crop = 'crop',
  Rotate = 'rotate',
  Mirror = 'mirror',
  Trim = 'trim',
  Straighten = 'straighten',
  Adjust = 'adjust',
  Filter = 'filter',
  Effect = 'effect',
  AutoEnhance = 'autoEnhance',
  Stabilize = 'stabilize',
  TextOverlay = 'textOverlay',
  Audio = 'audio',
  Speed = 'speed',
}

export const AssetEditActionSchema = z
  .enum(AssetEditAction)
  .describe('Type of edit action to perform')
  .meta({ id: 'AssetEditAction' });

export enum MirrorAxis {
  Horizontal = 'horizontal',
  Vertical = 'vertical',
}

const MirrorAxisSchema = z.enum(['horizontal', 'vertical']).describe('Axis to mirror along').meta({ id: 'MirrorAxis' });

const CropParametersSchema = z
  .object({
    x: z.int().min(0).describe('Top-Left X coordinate of crop'),
    y: z.int().min(0).describe('Top-Left Y coordinate of crop'),
    width: z.int().min(1).describe('Width of the crop'),
    height: z.int().min(1).describe('Height of the crop'),
  })
  .meta({ id: 'CropParameters' });

const RotateParametersSchema = z
  .object({
    angle: z
      .int()
      .min(0)
      .max(270)
      .refine((v) => [0, 90, 180, 270].includes(v), {
        error: 'Angle must be one of the following values: 0, 90, 180, 270',
      })
      .describe('Rotation angle in degrees'),
  })
  .meta({ id: 'RotateParameters' });

const MirrorParametersSchema = z
  .object({
    axis: MirrorAxisSchema,
  })
  .meta({ id: 'MirrorParameters' });

const TrimParametersSchema = z
  .object({
    startMs: z.int().min(0).describe('Trim start time in milliseconds'),
    endMs: z.int().min(1).describe('Trim end time in milliseconds'),
  })
  .refine((parameters) => parameters.endMs > parameters.startMs, {
    error: 'Trim end time must be after the start time',
  })
  .meta({ id: 'TrimParameters' });

const StraightenParametersSchema = z
  .object({
    angle: z.number().meta({ format: 'double' }).min(-45).max(45).describe('Straighten angle in degrees'),
  })
  .meta({ id: 'StraightenParameters' });

const AdjustmentValueSchema = z.number().meta({ format: 'double' }).min(-100).max(100);

const AdjustParametersSchema = z
  .object({
    brightness: AdjustmentValueSchema.optional(),
    contrast: AdjustmentValueSchema.optional(),
    whitePoint: AdjustmentValueSchema.optional(),
    highlights: AdjustmentValueSchema.optional(),
    shadows: AdjustmentValueSchema.optional(),
    blackPoint: AdjustmentValueSchema.optional(),
    saturation: AdjustmentValueSchema.optional(),
    warmth: AdjustmentValueSchema.optional(),
    tint: AdjustmentValueSchema.optional(),
    skinTone: AdjustmentValueSchema.optional(),
    blueTone: AdjustmentValueSchema.optional(),
    vignette: AdjustmentValueSchema.optional(),
    hdr: AdjustmentValueSchema.optional(),
  })
  .meta({ id: 'AdjustParameters' });

const LookParametersSchema = z
  .object({
    name: z.string().min(1).max(64).describe('Filter or effect name'),
    intensity: z
      .number()
      .meta({ format: 'double' })
      .min(0)
      .max(100)
      .default(100)
      .describe('Filter or effect intensity'),
  })
  .meta({ id: 'LookParameters' });

const ToggleParametersSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .meta({ id: 'ToggleParameters' });

const TextOverlayParametersSchema = z
  .object({
    text: z.string().min(1).max(200),
    x: z
      .number()
      .meta({ format: 'double' })
      .min(0)
      .max(1)
      .describe('Horizontal position as a percentage of video width'),
    y: z
      .number()
      .meta({ format: 'double' })
      .min(0)
      .max(1)
      .describe('Vertical position as a percentage of video height'),
    startMs: z.int().min(0).optional().describe('Overlay start time in milliseconds'),
    endMs: z.int().min(1).optional().describe('Overlay end time in milliseconds'),
    size: z
      .number()
      .meta({ format: 'double' })
      .min(0.02)
      .max(0.2)
      .default(0.06)
      .describe('Font size as a percentage of video height'),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)
      .default('#ffffff')
      .describe('Text color in hex format'),
  })
  .refine(
    (parameters) =>
      parameters.endMs === undefined || parameters.startMs === undefined || parameters.endMs > parameters.startMs,
    {
      error: 'Text overlay end time must be after the start time',
    },
  )
  .meta({ id: 'TextOverlayParameters' });

const AudioParametersSchema = z
  .object({
    muted: z.boolean().optional(),
    volume: z.number().meta({ format: 'double' }).min(0).max(2).optional().describe('Audio volume multiplier'),
  })
  .meta({ id: 'AudioParameters' });

const SpeedParametersSchema = z
  .object({
    rate: z.number().meta({ format: 'double' }).min(0.25).max(4).describe('Playback speed multiplier'),
    startMs: z.int().min(0).optional().describe('Speed segment start time in milliseconds'),
    endMs: z.int().min(1).optional().describe('Speed segment end time in milliseconds'),
  })
  .refine((parameters) => (parameters.startMs === undefined) === (parameters.endMs === undefined), {
    error: 'Speed segment start and end times must be provided together',
  })
  .refine(
    (parameters) =>
      parameters.endMs === undefined || parameters.startMs === undefined || parameters.endMs > parameters.startMs,
    {
      error: 'Speed segment end time must be after the start time',
    },
  )
  .meta({ id: 'SpeedParameters' });

const __AssetEditActionItemSchema = z.discriminatedUnion('action', [
  z.object({ action: AssetEditActionSchema.extract(['Crop']), parameters: CropParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Rotate']), parameters: RotateParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Mirror']), parameters: MirrorParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Trim']), parameters: TrimParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Straighten']), parameters: StraightenParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Adjust']), parameters: AdjustParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Filter']), parameters: LookParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Effect']), parameters: LookParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['AutoEnhance']), parameters: ToggleParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Stabilize']), parameters: ToggleParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['TextOverlay']), parameters: TextOverlayParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Audio']), parameters: AudioParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Speed']), parameters: SpeedParametersSchema }),
]);

const AssetEditParametersSchema = z
  .union([
    CropParametersSchema,
    RotateParametersSchema,
    MirrorParametersSchema,
    TrimParametersSchema,
    StraightenParametersSchema,
    AdjustParametersSchema,
    LookParametersSchema,
    ToggleParametersSchema,
    TextOverlayParametersSchema,
    AudioParametersSchema,
    SpeedParametersSchema,
  ])
  .describe('List of edit actions to apply');

// Select the action before parsing parameters: an untagged union can accept an
// unrelated all-optional shape and silently discard the requested edit values.
const AssetEditActionItemSchema = z
  .object({
    action: AssetEditActionSchema,
    parameters: z.record(z.string(), z.unknown()).meta({
      // Keep the existing wire contract while deferring parsing to the action discriminator.
      type: undefined,
      additionalProperties: undefined,
      propertyNames: undefined,
      description: AssetEditParametersSchema.description,
      anyOf: AssetEditParametersSchema.options.map((schema) => ({
        $ref: `#/components/schemas/${schema.meta()!.id}`,
      })),
    }),
  })
  .pipe(__AssetEditActionItemSchema)
  .meta({ id: 'AssetEditActionItemDto' });

export type AssetEditActionItem = z.infer<typeof __AssetEditActionItemSchema>;
export type AssetEditParameters = AssetEditActionItem['parameters'];

function uniqueEditActions(edits: z.infer<typeof AssetEditActionItemSchema>[]): boolean {
  const keys = new Set<string>();
  const multiInstanceActions = new Set<AssetEditAction>([
    AssetEditAction.Mirror,
    AssetEditAction.Speed,
    AssetEditAction.TextOverlay,
  ]);
  for (const edit of edits) {
    const key = multiInstanceActions.has(edit.action)
      ? `${edit.action}-${JSON.stringify(edit.parameters)}`
      : edit.action;
    if (keys.has(key)) {
      return false;
    }
    keys.add(key);
  }
  return true;
}

const AssetEditsCreateSchema = z
  .object({
    edits: z
      .array(AssetEditActionItemSchema)
      .min(1)
      .describe('List of edit actions to apply')
      .refine(uniqueEditActions, { error: 'Duplicate edit actions are not allowed' }),
  })
  .meta({ id: 'AssetEditsCreateDto' });

const AssetEditActionItemResponseSchema = z
  .object({
    action: AssetEditActionSchema,
    parameters: AssetEditParametersSchema,
    id: z.uuidv4().describe('Asset edit ID'),
  })
  .meta({ id: 'AssetEditActionItemResponseDto' });

const AssetEditsResponseSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID these edits belong to'),
    edits: z.array(AssetEditActionItemResponseSchema).describe('List of edit actions applied to the asset'),
  })
  .meta({ id: 'AssetEditsResponseDto' });

export class AssetEditActionItemResponseDto extends createZodDto(AssetEditActionItemResponseSchema) {}
export class AssetEditsCreateDto extends createZodDto(AssetEditsCreateSchema) {}
export class AssetEditsResponseDto extends createZodDto(AssetEditsResponseSchema) {}
export type CropParameters = z.infer<typeof CropParametersSchema>;
