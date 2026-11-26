import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * Import connection contracts (FL-920).
 *
 * Credentials go in and never come out: no response has a field for them. A connection's runs,
 * their review items and their choices use the Google Photos import's shapes (`TakeoutResponseDto`,
 * `TakeoutItemsResponseDto`, `TakeoutOptionsDto`, `TakeoutControlDto`), so one set of review screens
 * serves both. `provider` and `status` are plain strings: a new kind of source or a new status is a
 * new value the apps show as they can, not a new member of an enum they decode strictly.
 */

const RootsSchema = z
  .array(z.string().max(4096))
  .max(1000)
  .describe('The folders to import from, as the source names them; empty means everything it offers');

export class ImportConnectionCreateDto extends createZodDto(
  z
    .object({
      provider: z.string().min(1).max(64).describe('The kind of source, one of the providers this server lists'),
      displayName: z.string().trim().min(1).max(200).describe('What the owner calls this connection'),
      credentials: z
        .record(z.string(), z.unknown())
        .describe('What the source needs to sign in. Sealed on the server and never returned'),
      roots: RootsSchema.default([]),
      dailyCheck: z.boolean().default(false).describe('Look for new photos once a day and import them'),
    })
    .meta({ id: 'ImportConnectionCreateDto' }),
) {}

export class ImportConnectionUpdateDto extends createZodDto(
  z
    .object({
      displayName: z.string().trim().min(1).max(200).optional(),
      dailyCheck: z.boolean().optional(),
      credentials: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('New sign-in details; a connection waiting for a new sign-in becomes usable again'),
    })
    .meta({ id: 'ImportConnectionUpdateDto' }),
) {}

export class ImportConnectionRootsDto extends createZodDto(
  z.object({ roots: RootsSchema }).meta({ id: 'ImportConnectionRootsDto' }),
) {}

export class ImportConnectionParamsDto extends createZodDto(z.object({ id: z.uuid() })) {}
export class ImportConnectionRunParamsDto extends createZodDto(z.object({ id: z.uuid(), runId: z.uuid() })) {}

export class ImportConnectionFolderQueryDto extends createZodDto(
  z.object({
    path: z.string().max(4096).default('').describe('The folder to look inside; empty for the top'),
  }),
) {}

const ImportConnectionSchema = z
  .object({
    id: z.uuid(),
    provider: z.string().describe('The kind of source'),
    displayName: z.string(),
    status: z.string().describe('`active`, or `sign_in_required` once the source refused the saved sign-in'),
    roots: z.array(z.string()),
    dailyCheck: z.boolean(),
    lastScanAt: z.string().nullable().describe('When the latest scan started (ISO 8601)'),
    importedItems: z.int().describe('Photos and videos this connection brought in or found already in the library'),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'ImportConnectionResponseDto' });
export class ImportConnectionResponseDto extends createZodDto(ImportConnectionSchema) {}

export class ImportConnectionProvidersResponseDto extends createZodDto(
  z
    .object({ providers: z.array(z.string()).describe('The kinds of source this server can connect to') })
    .meta({ id: 'ImportConnectionProvidersResponseDto' }),
) {}

export class ImportConnectionFoldersResponseDto extends createZodDto(
  z
    .object({
      folders: z.array(
        z
          .object({
            path: z.string().describe('Passed back to list inside it, or kept as a root'),
            name: z.string(),
          })
          .meta({ id: 'ImportConnectionFolderDto' }),
      ),
    })
    .meta({ id: 'ImportConnectionFoldersResponseDto' }),
) {}

export class ImportConnectionStatisticsResponseDto extends createZodDto(
  z
    .object({
      total: z.int().describe('Connections on this server, across every account'),
      providers: z.array(
        z
          .object({
            provider: z.string(),
            connections: z.int(),
            dailyCheck: z.int().describe('Of those, how many check daily'),
          })
          .meta({ id: 'ImportConnectionProviderStatisticsDto' }),
      ),
    })
    .meta({ id: 'ImportConnectionStatisticsResponseDto' }),
) {}
