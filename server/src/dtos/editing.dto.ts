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

export enum VideoTrimMode {
  Precise = 'precise',
  Fast = 'fast',
}

const VideoTrimModeSchema = z
  .enum(VideoTrimMode)
  .describe(
    'Precise cuts are frame accurate and re-encode; fast cuts snap to keyframes and copy the streams when nothing else in the recipe needs a re-encode',
  )
  .meta({ id: 'VideoTrimMode' });

const TrimParametersSchema = z
  .object({
    startMs: z.int().min(0).describe('Trim start time in milliseconds'),
    endMs: z.int().min(1).describe('Trim end time in milliseconds'),
    mode: VideoTrimModeSchema.optional(),
  })
  .refine((parameters) => parameters.endMs > parameters.startMs, {
    error: 'Trim end time must be after the start time',
  })
  .meta({ id: 'TrimParameters' });

const StraightenParametersSchema = z
  .object({
    angle: z.number().meta({ format: 'double' }).min(-45).max(45).describe('Straighten angle in degrees'),
    fill: z
      .boolean()
      .optional()
      .describe(
        'Scale the straightened picture to fill its frame (the Frameleaf quick editor). Absent or false keeps the earlier behaviour: black corners, no zoom',
      ),
  })
  .meta({ id: 'StraightenParameters' });

const AdjustmentValueSchema = z.number().meta({ format: 'double' }).min(-100).max(100);
const PositiveAdjustmentValueSchema = z.number().meta({ format: 'double' }).min(0).max(100);

export enum VideoAdjustModel {
  Develop = 'develop',
}

const VideoAdjustModelSchema = z
  .enum(VideoAdjustModel)
  .describe(
    'develop: the values follow the photo develop model (exposure, whites, blacks, temperature…), as the Frameleaf quick editor writes them. Absent: the earlier video adjustment model.',
  )
  .meta({ id: 'VideoAdjustModel' });

/** The develop looks plus the video-only B&W look (prototype `develop.mjs` PRESETS, `scope: 'video'`). */
export enum VideoDevelopPreset {
  Original = 'Original',
  Vivid = 'Vivid',
  Natural = 'Natural',
  Warm = 'Warm',
  Cool = 'Cool',
  Mono = 'Mono',
  Silvertone = 'Silvertone',
  Noir = 'Noir',
  Fade = 'Fade',
  BlackAndWhite = 'B&W',
}

const VideoDevelopPresetSchema = z.enum(VideoDevelopPreset).meta({ id: 'VideoDevelopPreset' });

const AdjustParametersSchema = z
  .object({
    model: VideoAdjustModelSchema.optional(),
    exposure: z
      .number()
      .meta({ format: 'double' })
      .min(-2)
      .max(2)
      .optional()
      .describe('Exposure in EV (develop model)'),
    whites: AdjustmentValueSchema.optional(),
    blacks: AdjustmentValueSchema.optional(),
    temperature: AdjustmentValueSchema.optional(),
    vibrance: AdjustmentValueSchema.optional(),
    clarity: AdjustmentValueSchema.optional(),
    dehaze: AdjustmentValueSchema.optional(),
    grain: PositiveAdjustmentValueSchema.optional(),
    sharpen: PositiveAdjustmentValueSchema.optional(),
    noiseReduction: PositiveAdjustmentValueSchema.optional(),
    preset: VideoDevelopPresetSchema.optional(),
    presetStrength: PositiveAdjustmentValueSchema.optional().describe('Strength of the preset, 0 to 100'),
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

const StabilizeParametersSchema = z
  .object({
    enabled: z.boolean().default(true),
    cropEdges: z
      .boolean()
      .optional()
      .describe(
        'Crop the corrected edges 4% and scale back (the Frameleaf quick editor). Absent or false keeps the earlier uncropped render',
      ),
  })
  .meta({ id: 'StabilizeParameters' });

const ToggleParametersSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .meta({ id: 'ToggleParameters' });

export enum TextOverlayPosition {
  TopLeft = 'top-left',
  Top = 'top',
  TopRight = 'top-right',
  Left = 'left',
  Center = 'center',
  Right = 'right',
  BottomLeft = 'bottom-left',
  Bottom = 'bottom',
  BottomRight = 'bottom-right',
}

const TextOverlayPositionSchema = z
  .enum(TextOverlayPosition)
  .describe('Anchor on a 3 × 3 grid; when set, the text is aligned to it and x/y are ignored')
  .meta({ id: 'TextOverlayPosition' });

const TextOverlayParametersSchema = z
  .object({
    text: z.string().min(1).max(200),
    position: TextOverlayPositionSchema.optional(),
    shadow: z.boolean().optional().describe('Draw a soft drop shadow behind the text'),
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
      .min(0.01)
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
    limit: z
      .boolean()
      .optional()
      .describe(
        'Limit a gain above 1 so it cannot clip (the Frameleaf quick editor). Absent or false keeps the earlier unlimited gain',
      ),
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
  z.object({ action: AssetEditActionSchema.extract(['Stabilize']), parameters: StabilizeParametersSchema }),
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
    StabilizeParametersSchema,
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
    originalVideo: z
      .object({
        width: z.number().int().positive().describe('Displayed width of the original, after its rotation'),
        height: z.number().int().positive().describe('Displayed height of the original, after its rotation'),
        durationMs: z.number().int().positive().describe('Duration of the original in milliseconds'),
        colorPolicy: z
          .enum(['preserve', 'tone-map', 'unsupported'])
          .optional()
          .describe(
            "FL-113: what an edited version does with the original's colour. 'tone-map': an HDR original is rendered to SDR and kept as the reference; 'unsupported': this server cannot render an edited version (Dolby Vision profile 5), so saving is refused and the original stays unchanged",
          ),
        colorReason: z.string().optional().describe('Why, in plain words, for the person editing'),
      })
      .meta({ id: 'AssetEditsOriginalVideoDto' })
      .optional()
      .describe('Original video display raster and timeline, independent of the current edited version'),
    edits: z.array(AssetEditActionItemResponseSchema).describe('List of edit actions applied to the asset'),
  })
  .meta({ id: 'AssetEditsResponseDto' });

export class AssetEditActionItemResponseDto extends createZodDto(AssetEditActionItemResponseSchema) {}
export class AssetEditsCreateDto extends createZodDto(AssetEditsCreateSchema) {}
export class AssetEditsResponseDto extends createZodDto(AssetEditsResponseSchema) {}

const AssetEditKeyframesResponseSchema = z
  .object({
    keyframesMs: z
      .array(z.number().int().min(0))
      .describe(
        "Times of the original's video keyframes in milliseconds from its start, ascending. A fast trim starts at the last one at or before its in point.",
      ),
  })
  .meta({ id: 'AssetEditKeyframesResponseDto' });

export class AssetEditKeyframesResponseDto extends createZodDto(AssetEditKeyframesResponseSchema) {}
export type CropParameters = z.infer<typeof CropParametersSchema>;

const VideoEditVersionParamsSchema = z.object({
  id: z.uuid(),
  versionId: z.uuid(),
});

const VideoEditExportProfileSchema = z
  .enum(['master'])
  .describe('Export profile. Only the edited master is exported; the playback proxy is never offered for download.')
  .meta({ id: 'VideoEditExportProfile' });

const VideoEditVersionPurposeSchema = z
  .enum(['save', 'export', 'revert'])
  .describe('Why the version was created')
  .meta({ id: 'VideoEditVersionPurpose' });

const VideoEditVersionStatusSchema = z
  .enum(['pending', 'ready', 'failed'])
  .describe('Render status of the version')
  .meta({ id: 'VideoEditVersionStatus' });

const VideoEditExportSchema = z.object({ profile: VideoEditExportProfileSchema }).meta({ id: 'VideoEditExportDto' });

const VideoEditVersionResponseSchema = z
  .object({
    id: z.uuid().describe('Video edit version ID'),
    assetId: z.uuid().describe('Asset ID'),
    purpose: VideoEditVersionPurposeSchema,
    status: VideoEditVersionStatusSchema,
    createdAt: z.iso.datetime().describe('When the version was saved'),
    isCurrent: z.boolean().describe('Whether this version is the one currently published for playback'),
    isRequested: z.boolean().describe('Whether this version is the latest requested save or revert'),
    edits: z.array(AssetEditActionItemSchema).describe('The recipe rendered from the original'),
  })
  .meta({ id: 'VideoEditVersionResponseDto' });

export class VideoEditVersionParamsDto extends createZodDto(VideoEditVersionParamsSchema) {}
export class VideoEditExportDto extends createZodDto(VideoEditExportSchema) {}
export class VideoEditVersionResponseDto extends createZodDto(VideoEditVersionResponseSchema) {}
