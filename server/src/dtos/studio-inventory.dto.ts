import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { StudioProjectImportSchema } from 'src/dtos/studio-project-import.dto.js';
import { AssetTypeSchema } from 'src/enum.js';
import { STUDIO_INVENTORY_KINDS } from 'src/utils/studio-inventory.js';

const StudioCapabilitySchema = z
  .enum(['analysisWorker', 'generationWorker', 'gpuWorker', 'renderWorker', 'restorationWorker', 'transcriptionWorker'])
  .describe('A Studio worker capability, as the command catalogue names it')
  .meta({ id: 'StudioWorkerCapability' });

const RationalSchema = z
  .object({
    num: z.int().describe('Numerator'),
    den: z.int().min(1).describe('Denominator, positive; the pair is reduced'),
  })
  .meta({ id: 'StudioRationalDto' });

const StudioResourceUsesSchema = z
  .object({
    redistribution: z.boolean().describe('May be copied to someone else (a bundle, a download)'),
    localRuntime: z.boolean().describe('May run on this server or a LAN worker'),
    hostedUse: z.boolean().describe('May run on Frameleaf Cloud'),
  })
  .meta({ id: 'StudioResourceUsesDto' });

const StudioResourceItemSchema = z
  .object({
    id: z.string().describe('The rights row id, e.g. font:Roboto or model:onnx-community/whisper-base_timestamped'),
    kind: z.enum(STUDIO_INVENTORY_KINDS).describe('What the resource is').meta({ id: 'StudioResourceItemKind' }),
    name: z.string().describe('The name a graph or a job uses: a font family, a model id'),
    license: z.string().nullable().describe('The licence, as reviewed; null when the review records none'),
    uses: StudioResourceUsesSchema,
    restrictions: z
      .record(z.string(), z.string())
      .describe('Why the owner withheld a use, by use name (redistribution, localRuntime, hostedUse)'),
    approvedOn: z.string().nullable().describe('The date the owner approved this exact row, or null'),
    capability: StudioCapabilitySchema.nullable().describe(
      'The worker capability that runs it (GET /ml-destinations/capabilities says whether one is available), or null when the editor alone uses it',
    ),
    producers: z
      .array(z.string())
      .describe('For a model: the generated-file producers it serves (transcript, tts, musicgen)'),
  })
  .meta({ id: 'StudioResourceItemDto' });

const StudioResourceInventorySchema = z
  .object({
    approval: z
      .object({ approvedBy: z.string(), approvedOn: z.string() })
      .nullable()
      .describe('The owner approval the allowed rows come from')
      .meta({ id: 'StudioResourceApprovalDto' }),
    distributionApproved: z
      .boolean()
      .describe('Whether the engine as a whole may be redistributed; false blocks every redistribution use'),
    items: z.array(StudioResourceItemSchema).describe('Every reviewed resource, sorted by id'),
  })
  .meta({ id: 'StudioResourceInventoryDto' });

export class StudioResourceInventoryDto extends createZodDto(StudioResourceInventorySchema) {}

const StudioProjectResourceUseSchema = z
  .object({
    kind: z
      .enum(['font', 'lut', 'model'])
      .describe('What the graph references')
      .meta({ id: 'StudioProjectResourceKind' }),
    name: z.string().describe('As written in the graph'),
    rightsId: z.string().describe('The rights row it resolves to'),
    license: z.string().nullable(),
    allowed: z.boolean().describe('Whether it may run on this server'),
    detail: z.string().nullable().describe('Why not, when it may not'),
  })
  .meta({ id: 'StudioProjectResourceUseDto' });

const StudioProjectInventorySchema = z
  .object({
    projectId: z.uuid(),
    revision: z.int().min(0).describe('The head revision the graph references were read from; 0 for an empty project'),
    keptFiles: z.array(StudioProjectImportSchema).describe('Files kept with the project (FL-103, FL-105)'),
    fonts: z.array(StudioProjectResourceUseSchema).describe('Font families the head graph names'),
    luts: z.array(StudioProjectResourceUseSchema).describe('Bundled LUTs the head graph names'),
    models: z.array(StudioProjectResourceUseSchema).describe('Models the head graph names'),
  })
  .meta({ id: 'StudioProjectInventoryDto' });

export class StudioProjectInventoryDto extends createZodDto(StudioProjectInventorySchema) {}

const StudioMediaFactsSchema = z
  .object({
    assetId: z.uuidv4(),
    type: AssetTypeSchema,
    mimeType: z.string().describe('The original file type'),
    width: z.int().nullable().describe('Display width in pixels, after rotation; null when unknown'),
    height: z.int().nullable().describe('Display height in pixels, after rotation; null when unknown'),
    durationSeconds: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Length in seconds; 0 for a still; null when unknown'),
    frameRate: RationalSchema.nullable().describe(
      'The exact average frame rate of the video stream (30000/1001, not 29.97); null for a still or when unknown',
    ),
    fps: z
      .number()
      .meta({ format: 'double' })
      .describe("frameRate as a float, the Studio media record's fps (graph protocol 3.5); 0 for a still"),
    frameCount: z.int().nullable().describe('Frames in the video stream when the container says; null otherwise'),
    hasAudio: z
      .boolean()
      .nullable()
      .describe('Whether the original has an audio track; null when it could not be read'),
    audioCodec: z.string().nullable().describe('The first audio track codec; its presence places a linked audio clip'),
    videoCodec: z.string().nullable(),
    source: z
      .enum(['probe', 'stored'])
      .describe(
        'probe: read from the original now; stored: the metadata extraction kept, when the original could not be read',
      )
      .meta({ id: 'StudioMediaFactsSource' }),
  })
  .meta({ id: 'StudioMediaFactsDto' });

export class StudioMediaFactsDto extends createZodDto(StudioMediaFactsSchema) {}

const StudioFontFileSchema = z
  .object({
    sha256: z.string().describe('SHA-256 of the file, lower-case hex; also its id in GET /studio/fonts/{sha256}'),
    file: z.string().describe('The file name, for display and diagnostics only'),
    weight: z.int().describe('CSS weight: 400 normal, 500 medium, 600 semibold, 700 bold'),
    style: z.enum(['normal', 'italic']).meta({ id: 'StudioFontStyle' }),
    subset: z.string().describe('The Unicode subset the file covers: latin or latin-ext'),
    format: z
      .enum(['woff2', 'ttf'])
      .describe(
        'woff2: the file as its package ships it; ttf: the same font decompressed to sfnt, nothing else changed',
      )
      .meta({ id: 'StudioFontFormat' }),
    decodedFrom: z
      .string()
      .nullable()
      .describe('For a ttf file: the sha256 of the woff2 file it was decoded from; null for a woff2 file'),
    size: z.int().describe('Length in bytes'),
    path: z.string().describe('The API path that serves the bytes, relative to the API root'),
  })
  .meta({ id: 'StudioFontFileDto' });

const StudioFontFamilySchema = z
  .object({
    family: z.string().describe('The family name a Studio graph writes in fontFamily'),
    package: z.string().describe('The package the files come from'),
    version: z.string().describe('The exact package version bundled'),
    license: z.string().describe('SPDX licence identifier, read from the package'),
    copyright: z.string().describe("The copyright line of the package's own licence file"),
    reservedFontName: z.string().nullable().describe('The Reserved Font Name the licence declares, or null'),
    files: z.array(StudioFontFileSchema).describe('Every bundled file of the family'),
  })
  .meta({ id: 'StudioFontFamilyDto' });

const StudioFontCatalogSchema = z
  .object({
    families: z.array(StudioFontFamilySchema).describe('The title font families bundled with this server'),
  })
  .meta({ id: 'StudioFontCatalogDto' });

export class StudioFontCatalogDto extends createZodDto(StudioFontCatalogSchema) {}

const StudioFontParamSchema = z
  .object({
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('SHA-256 of a catalogue file, lower-case hex'),
  })
  .meta({ id: 'StudioFontParamDto' });

export class StudioFontParamDto extends createZodDto(StudioFontParamSchema) {}
