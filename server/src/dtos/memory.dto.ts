import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { Memory, MemoryExport } from 'src/database.js';
import { HistoryBuilder } from 'src/decorators.js';
import { AssetResponseSchema, mapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AssetOrderWithRandomSchema,
  MemoryExportFormat,
  MemoryExportFormatSchema,
  MemoryExportStatus,
  MemoryExportStatusSchema,
  MemoryShowLessKindSchema,
  MemoryType,
  MemoryTypeSchema,
} from 'src/enum.js';
import { isoDateToDate, isoDatetimeToDate, nonEmptyPartial, stringToBool } from 'src/validation.js';

const MemorySearchSchema = z
  .object({
    id: z.uuidv4().optional().describe('Memory ID'),
    type: MemoryTypeSchema.optional(),
    for: isoDateToDate.optional().describe('Filter by date'),
    isTrashed: stringToBool.optional().describe('Include trashed memories'),
    isSaved: stringToBool.optional().describe('Filter by saved status'),
    isUpcoming: stringToBool.optional().describe('Filter by memories that have not been shown yet'),
    isHidden: stringToBool
      .optional()
      .describe('Only the memories the owner hid (true); hidden memories are left out otherwise')
      .meta(new HistoryBuilder().added('v3').getExtensions()),
    size: z.coerce.number().int().min(1).optional().describe('Number of memories to return'),
    page: z.coerce.number().int().min(1).optional().describe('Page number'),
    order: AssetOrderWithRandomSchema.optional(),
  })
  .meta({ id: 'MemorySearchDto' });

const OnThisDaySchema = z
  .object({
    year: z.int().min(1000).max(9999).describe('Year for on this day memory'),
  })
  .meta({ id: 'OnThisDayDto' });

const StoryPlaceSchema = z
  .object({
    city: z.string().nullable().describe('City'),
    state: z.string().nullable().describe('State or region'),
    country: z.string().nullable().describe('Country'),
  })
  .meta({ id: 'MemoryStoryPlaceDto' });

/**
 * An event story: a multi-day trip or occasion grouped from the owner's local capture time
 * and place. `year` is repeated from `startDate` so clients written against the original
 * `OnThisDayDto` shape keep working, and `kind` makes the union unambiguous.
 */
const EventStorySchema = z
  .object({
    kind: z.literal('event_story').describe('Discriminator for an event story'),
    year: z.int().min(1000).max(9999).describe('Year the event started'),
    startDate: z.string().describe("First local day of the event, 'yyyy-MM-dd'"),
    endDate: z.string().describe("Last local day of the event, 'yyyy-MM-dd'"),
    dayCount: z.int().min(1).describe('Number of distinct local days the event covers'),
    assetCount: z.int().min(0).describe('Number of assets the event held before the diversity pass'),
    place: StoryPlaceSchema.optional(),
    title: z.string().optional().describe('Place label for the event, when it has one'),
  })
  .meta({ id: 'EventStoryDto' });

const YearInReviewSchema = z
  .object({
    kind: z.literal('year_in_review').describe('Discriminator for a year in review recap'),
    year: z.int().min(1000).max(9999).describe('Calendar year being recapped'),
    assetCount: z.int().min(0).describe('Number of assets captured that year'),
    monthCount: z.int().min(0).describe('Number of distinct months represented'),
  })
  .meta({ id: 'YearInReviewDto' });

/**
 * A named person's or pet's birthday (FL-62). `date` is the calendar day in this year the birthday falls on
 * (29 February becomes 28 February outside leap years); clients compare it with their own local
 * date, so the memory is "today" in every time zone on the person's actual birthday.
 */
const BirthdaySchema = z
  .object({
    kind: z.literal('birthday').describe('Discriminator for a birthday'),
    year: z.int().min(1000).max(9999).describe('Year of this birthday'),
    date: z.string().describe("The birthday this year, 'yyyy-MM-dd'"),
    subject: z.enum(['person', 'pet']).describe("Whether the birthday is a person's or a pet's"),
    subjectId: z.uuidv4().describe("The owner's person or pet whose birthday it is"),
    name: z.string().describe('Their name when the memory was made'),
    age: z.int().min(0).nullable().describe('Age reached on this birthday'),
  })
  .meta({ id: 'BirthdayMemoryDto' });

/** A year with one person or pet the owner named (FL-62). */
const PersonRecapSchema = z
  .object({
    kind: z.literal('person_recap').describe('Discriminator for a person or pet recap'),
    year: z.int().min(1000).max(9999).describe('Calendar year being recapped'),
    subject: z.enum(['person', 'pet']).describe('Whether the recap is about a person or a pet'),
    subjectId: z.uuidv4().describe("The owner's person or pet"),
    name: z.string().describe('Their name when the memory was made'),
    assetCount: z.int().min(0).describe('Number of their photos and videos that year'),
  })
  .meta({ id: 'PersonRecapDto' });

/**
 * Union order is load-bearing: the two story shapes carry a required `kind` literal that
 * `on_this_day` data does not, so an existing `{ year }` payload only ever matches
 * `OnThisDayDto`.
 */
const MemoryDataSchema = z
  .union([EventStorySchema, YearInReviewSchema, BirthdaySchema, PersonRecapSchema, OnThisDaySchema])
  .describe('Memory data')
  .meta({ id: 'MemoryData' });

type MemoryData = z.infer<typeof MemoryDataSchema>;

const MemoryUpdateSchema = nonEmptyPartial({
  isSaved: z.boolean().describe('Is memory saved'),
  seenAt: isoDatetimeToDate.describe('Date when memory was seen'),
  memoryAt: isoDatetimeToDate.describe('Memory date'),
  isHidden: z
    .boolean()
    .describe('Hide the memory from the memories list; false restores it')
    .meta(new HistoryBuilder().added('v3').getExtensions()),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullable()
    .describe("The owner's own title for the memory; null returns to the generated one")
    .meta(new HistoryBuilder().added('v3').getExtensions()),
  assetOrder: z
    .array(z.uuidv4())
    .max(5000)
    .describe("The memory's items in the order the owner chose; items not listed follow in capture order")
    .meta(new HistoryBuilder().added('v3').getExtensions()),
}).meta({ id: 'MemoryUpdateDto' });

const MemoryCreateSchema = z
  .object({
    type: MemoryTypeSchema,
    data: MemoryDataSchema,
    memoryAt: isoDatetimeToDate.describe('Memory date'),
    assetIds: z.array(z.uuidv4()).optional().describe('Asset IDs to associate with memory'),
    isSaved: z.boolean().optional().describe('Is memory saved'),
    seenAt: isoDatetimeToDate.optional().describe('Date when memory was seen'),
    showAt: isoDatetimeToDate
      .optional()
      .describe('Date when memory should be shown')
      .meta(new HistoryBuilder().added('v2.6.0').stable('v2.6.0').getExtensions()),
    hideAt: isoDatetimeToDate
      .optional()
      .describe('Date when memory should be hidden')
      .meta(new HistoryBuilder().added('v2.6.0').stable('v2.6.0').getExtensions()),
  })
  .meta({ id: 'MemoryCreateDto' });

const MemoryStatisticsResponseSchema = z
  .object({
    total: z.int().describe('Total number of memories'),
  })
  .meta({ id: 'MemoryStatisticsResponseDto' });

const MemoryResponseSchema = z
  .object({
    id: z.uuidv4().describe('Memory ID'),
    createdAt: isoDatetimeToDate.describe('Creation date'),
    updatedAt: isoDatetimeToDate.describe('Last update date'),
    deletedAt: isoDatetimeToDate.optional().describe('Deletion date'),
    memoryAt: isoDatetimeToDate.describe('Memory date'),
    seenAt: isoDatetimeToDate.optional().describe('Date when memory was seen'),
    showAt: isoDatetimeToDate.optional().describe('Date when memory should be shown'),
    hideAt: isoDatetimeToDate.optional().describe('Date when memory should be hidden'),
    ownerId: z.uuidv4().describe('Owner user ID'),
    type: MemoryTypeSchema,
    data: MemoryDataSchema,
    isSaved: z.boolean().describe('Is memory saved'),
    isHidden: z
      .boolean()
      .describe('Hidden by the owner; shown only in the hidden memories list')
      .meta(new HistoryBuilder().added('v3').getExtensions()),
    title: z
      .string()
      .nullable()
      .describe("The owner's own title, when they set one")
      .meta(new HistoryBuilder().added('v3').getExtensions()),
    assets: z.array(AssetResponseSchema),
  })
  .meta({ id: 'MemoryResponseDto' });

/**
 * "Show less" on memories (FL-62): one of the owner's people or pets, a calendar date (`MM-dd`) or
 * a kind of memory that is no longer generated or shown.
 */
const MemoryShowLessSchema = z
  .object({
    kind: MemoryShowLessKindSchema,
    value: z.string().trim().min(1).max(64).describe("A person or pet id, a date as 'MM-dd', or a memory type"),
  })
  .meta({ id: 'MemoryShowLessDto' });

const MemoryShowLessResponseSchema = z
  .object({
    kind: MemoryShowLessKindSchema,
    value: z.string().describe("A person or pet id, a date as 'MM-dd', or a memory type"),
    name: z.string().nullable().describe("The person's or pet's name, for person and pet rules"),
    createdAt: isoDatetimeToDate.describe('When the rule was added'),
  })
  .meta({ id: 'MemoryShowLessResponseDto' });

export class MemoryShowLessDto extends createZodDto(MemoryShowLessSchema) {}
export class MemoryShowLessResponseDto extends createZodDto(MemoryShowLessResponseSchema) {}

/** The owner's curation of one memory (FL-62), kept beside the memory in the fork schema. */
export type MemoryCuration = {
  memoryId: string;
  hiddenAt: Date | null;
  title: string | null;
  assetOrder: string[] | null;
};

/** The memory's items in the owner's order: listed ids first, the rest after them as they came. */
export const applyMemoryAssetOrder = <T extends { id: string }>(assets: T[], order: string[] | null | undefined) => {
  if (!order || order.length === 0) {
    return assets;
  }
  const position = new Map(order.map((id, index) => [id, index]));
  return assets
    .map((asset, index) => ({ asset, index }))
    .sort((a, b) => {
      const left = position.get(a.asset.id) ?? order.length + a.index;
      const right = position.get(b.asset.id) ?? order.length + b.index;
      return left - right;
    })
    .map(({ asset }) => asset);
};

/**
 * Private highlight export (FL-62).
 *
 * The response is the Activity page's contract for this kind of work (FL-104): a durable,
 * owner-scoped run with a status, a progress pair and a terminal outcome. It deliberately
 * mirrors the shape the media-health runs already expose rather than inventing a second
 * job vocabulary.
 */
const MemoryExportCreateSchema = z
  .object({
    format: MemoryExportFormatSchema.optional().describe('Export format, defaults to an archive of the originals'),
  })
  .meta({ id: 'MemoryExportCreateDto' });

const MemoryExportSearchSchema = z
  .object({
    memoryId: z.uuidv4().optional().describe('Only return exports of this memory'),
  })
  .meta({ id: 'MemoryExportSearchDto' });

export const MemoryExportResponseSchema = z
  .object({
    id: z.uuidv4().describe('Export ID'),
    memoryId: z.uuidv4().describe('Memory the export was requested for'),
    ownerId: z.uuidv4().describe('Owner user ID'),
    title: z.string().describe("The memory's title when the export was requested"),
    format: MemoryExportFormatSchema,
    status: MemoryExportStatusSchema,
    assetCount: z.int().min(0).describe('Number of assets in the export'),
    processedAssets: z.int().min(0).describe('Number of assets written so far'),
    sizeInBytes: z.int().min(0).nullable().describe('Size of the finished archive'),
    error: z.string().nullable().describe('Failure reason, when the export failed'),
    isDownloadable: z.boolean().describe('Whether the archive can be downloaded right now'),
    createdAt: isoDatetimeToDate.describe('When the export was requested'),
    updatedAt: isoDatetimeToDate.describe('Last update date'),
    startedAt: isoDatetimeToDate.nullable().describe('When the worker picked the export up'),
    finishedAt: isoDatetimeToDate.nullable().describe('When the export reached a terminal state'),
    expiresAt: isoDatetimeToDate.nullable().describe('When the archive is deleted'),
  })
  .meta({ id: 'MemoryExportResponseDto' });

export class MemoryExportCreateDto extends createZodDto(MemoryExportCreateSchema) {}
export class MemoryExportSearchDto extends createZodDto(MemoryExportSearchSchema) {}
export class MemoryExportResponseDto extends createZodDto(MemoryExportResponseSchema) {}

const TERMINAL_STATUSES = new Set<MemoryExportStatus>([
  MemoryExportStatus.Ready,
  MemoryExportStatus.Failed,
  MemoryExportStatus.Cancelled,
]);

export const isTerminalExportStatus = (status: MemoryExportStatus) => TERMINAL_STATUSES.has(status);

export const mapMemoryExport = (entity: MemoryExport): MemoryExportResponseDto => ({
  id: entity.id,
  memoryId: entity.memoryId,
  ownerId: entity.ownerId,
  title: entity.title,
  format: entity.format as MemoryExportFormat,
  status: entity.status as MemoryExportStatus,
  assetCount: entity.assetCount,
  processedAssets: entity.processedAssets,
  // bigint columns come back as strings through the driver
  sizeInBytes: entity.sizeInBytes === null ? null : Number(entity.sizeInBytes),
  error: entity.error,
  isDownloadable: entity.status === MemoryExportStatus.Ready && !!entity.path,
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
  startedAt: entity.startedAt ?? null,
  finishedAt: entity.finishedAt ?? null,
  expiresAt: entity.expiresAt ?? null,
});

export class MemorySearchDto extends createZodDto(MemorySearchSchema) {}
export class MemoryUpdateDto extends createZodDto(MemoryUpdateSchema) {}
export class MemoryCreateDto extends createZodDto(MemoryCreateSchema) {}
export class MemoryStatisticsResponseDto extends createZodDto(MemoryStatisticsResponseSchema) {}
export class MemoryResponseDto extends createZodDto(MemoryResponseSchema) {}

export const mapMemory = (entity: Memory, auth: AuthDto, curation?: MemoryCuration | null): MemoryResponseDto => {
  const assets = applyMemoryAssetOrder('assets' in entity ? entity.assets : [], curation?.assetOrder);
  return {
    id: entity.id,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    deletedAt: entity.deletedAt ?? undefined,
    memoryAt: entity.memoryAt,
    seenAt: entity.seenAt ?? undefined,
    showAt: entity.showAt ?? undefined,
    hideAt: entity.hideAt ?? undefined,
    ownerId: entity.ownerId,
    type: entity.type as MemoryType,
    data: entity.data as unknown as MemoryData,
    isSaved: entity.isSaved,
    isHidden: !!curation?.hiddenAt,
    title: curation?.title ?? null,
    assets: assets.map((asset) => mapAsset(asset, { auth })),
  };
};
