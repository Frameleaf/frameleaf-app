import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { stringToBool } from 'src/validation.js';

/**
 * FL-653: importing an Eagle library that is in a folder the server can open. An administrator
 * allows those folders (`FRAMELEAF_IMPORT_ROOTS`, the same list Google Photos imports use); the
 * server lists the `.library` folders in them, reads the chosen one's lists for the check, and
 * imports it with the tab closed. Paths are always relative to an allowed folder.
 */

const rootId = z
  .string()
  .regex(/^\d{1,4}$/)
  .describe('Which allowed import folder, as the list numbers them');
const libraryPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'Invalid folder')
  .describe('The `.library` folder, relative to the allowed import folder');

export class EagleLibraryLocationDto extends createZodDto(
  z
    .object({
      rootId,
      path: libraryPath,
      name: z.string().describe('The folder name, such as "Studio References.library"'),
    })
    .meta({ id: 'EagleLibraryLocationDto' }),
) {}

export class EagleLibrariesResponseDto extends createZodDto(
  z
    .object({
      /** How many import folders the administrator allowed; none means the choice can't be used. */
      roots: z.int().min(0),
      libraries: z.array(EagleLibraryLocationDto.schema),
    })
    .meta({ id: 'EagleLibrariesResponseDto' }),
) {}

export class EagleLibraryCheckDto extends createZodDto(
  z.object({ rootId, path: libraryPath }).meta({ id: 'EagleLibraryCheckDto' }),
) {}

const EagleFolderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    parentId: z.string().nullable().describe('The folder it is in; null at the top of the library'),
    description: z.string().optional(),
    color: z.string().optional(),
    icon: z.string().optional(),
  })
  .meta({ id: 'EagleFolderDto' });

const EagleItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    ext: z.string(),
    size: z.number().meta({ format: 'double' }),
    width: z.number().meta({ format: 'double' }),
    height: z.number().meta({ format: 'double' }),
    url: z.string(),
    annotation: z.string(),
    tags: z.array(z.string()),
    folders: z.array(z.string()),
    star: z.int(),
    isDeleted: z.boolean(),
    modificationTime: z.number().meta({ format: 'double' }),
    comments: z.array(
      z.object({
        id: z.string(),
        x: z.number().meta({ format: 'double' }),
        y: z.number().meta({ format: 'double' }),
        width: z.number().meta({ format: 'double' }),
        height: z.number().meta({ format: 'double' }),
        annotation: z.string(),
      }),
    ),
    present: z.boolean().describe('The item’s file is in the library folder'),
    unreadable: z.boolean().describe('The item’s details could not be read'),
  })
  .meta({ id: 'EagleItemDto' });

export class EagleImportCreateDto extends createZodDto(
  z
    .object({
      rootId,
      path: libraryPath,
      fingerprint: z.string().max(200).describe('From the check; the import refuses a library that changed since'),
      targetMode: z.enum(['top', 'inside']).meta({ id: 'EagleImportTargetMode' }),
      insideAlbumId: z.uuid().optional().describe('The collection to import into; a new one when left out'),
      existingTop: z.array(z.string().max(1000)).max(5000).default([]),
    })
    .meta({ id: 'EagleImportCreateDto' }),
) {}

export class EagleImportQueryDto extends createZodDto(
  z
    .object({
      outcomes: stringToBool.optional().describe('Include what became of every item, for the finish report'),
    })
    .meta({ id: 'EagleImportQueryDto' }),
) {}

export class EagleImportResponseDto extends createZodDto(
  z
    .object({
      id: z.uuid(),
      rootId: z.string(),
      path: z.string(),
      libraryName: z.string(),
      fingerprint: z.string(),
      status: z.enum(['running', 'stopping', 'stopped', 'finished']).meta({ id: 'EagleImportStatus' }),
      targetMode: z.enum(['top', 'inside']).meta({ id: 'EagleImportTargetMode' }),
      insideAlbumId: z.uuid().nullable(),
      rootAlbumId: z.uuid().nullable(),
      total: z.int(),
      done: z.int(),
      already: z.int(),
      collections: z.int(),
      failed: z.array(z.string()).describe('Eagle ids of items that could not be brought over this time'),
      recent: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          duplicate: z.boolean(),
          collections: z.array(z.string()),
        }),
      ),
      error: z.string().nullable(),
      outcomes: z
        .record(z.string(), z.object({ assetId: z.uuid(), duplicate: z.boolean() }))
        .optional()
        .describe('What became of every item, by Eagle id, when asked for'),
      createdAt: z.string().meta({ format: 'date-time' }),
      updatedAt: z.string().meta({ format: 'date-time' }),
    })
    .meta({ id: 'EagleImportResponseDto' }),
) {}

/** The library's lists, read on the server, for the check before importing. */
export class EagleLibraryResponseDto extends createZodDto(
  z
    .object({
      name: z.string(),
      folders: z.array(EagleFolderSchema).describe('Every folder, parents before their children'),
      smartFolders: z.array(z.string()),
      tagGroups: z.array(z.string()),
      changed: z.number().meta({ format: 'double' }).optional().describe('When Eagle last changed the library (ms)'),
      items: z.array(EagleItemSchema),
      fingerprint: z.string(),
      supported: z.array(z.string()).describe('File types this import brings over (lower case, no dot)'),
      earlierImport: EagleImportResponseDto.schema
        .nullable()
        .describe('Your earlier import of this library that has more to do, to carry on'),
    })
    .meta({ id: 'EagleLibraryResponseDto' }),
) {}

export class EagleImportListResponseDto extends createZodDto(
  z.object({ imports: z.array(EagleImportResponseDto.schema) }).meta({ id: 'EagleImportListResponseDto' }),
) {}
