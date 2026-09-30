import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const Availability = z.enum(['off', 'not-linked', 'not-configured', 'paused-key-unloaded', 'ready']);
const DateTime = z.string().meta({ format: 'date-time' });
export const SafetyLookupSchema = z
  .object({
    hashes: z
      .array(
        z
          .string()
          .regex(/^[\dA-Fa-f]{64}$/)
          .toLowerCase(),
      )
      .min(1)
      .max(2000)
      .describe('SHA-256 hex hashes; inaccessible and foreign assets are omitted, including for administrators'),
  })
  .meta({ id: 'SafetyLookupDto' });
export class SafetyLookupDto extends createZodDto(SafetyLookupSchema) {}

const AssetSafety = z
  .object({
    id: z.uuid(),
    sha256: z.string(),
    onServerSince: DateTime.describe('When this current asset was registered on the server; not checksum proof'),
    lastIntegrityAt: DateTime.nullable(),
    integrityResult: z.enum(['unknown', 'passed', 'mismatched', 'missing', 'unreadable']),
    cloudBackup: z.object({
      state: z.enum(['unavailable', 'not-backed-up', 'completed']),
      since: DateTime.nullable().describe('Earliest retained complete backup run containing the current original hash'),
      lastVerifiedRunAt: DateTime.nullable().describe(
        'Last completed successful GET + SHA-256 run for this current indexed object; HEAD + size never qualifies',
      ),
    }),
  })
  .meta({ id: 'AssetSafetyDto' });
export const SafetyLookupResponseSchema = z
  .object({ cloudAvailability: Availability, assets: z.array(AssetSafety) })
  .meta({ id: 'SafetyLookupResponseDto' });
export class SafetyLookupResponseDto extends createZodDto(SafetyLookupResponseSchema) {}

export const SafetySummarySchema = z
  .object({
    cloudAvailability: Availability,
    total: z
      .int()
      .min(0)
      .describe(
        'Current own accessible, non-trashed server library; excludes deleted libraries. Device-only items are not known to the server',
      ),
    onServer: z
      .int()
      .min(0)
      .describe('Registered assets not marked offline or last checked missing; not a new filesystem verification'),
    onServerPercent: z.number().min(0).max(100).meta({ format: 'double' }),
    backedUp: z.int().min(0).nullable(),
    backedUpPercent: z
      .number()
      .min(0)
      .max(100)
      .meta({ format: 'double' })
      .nullable()
      .describe(
        'Retained completed original membership with current object presence; null if no configured accessible backup target',
      ),
    lastCompletedRunAt: DateTime.nullable().describe(
      'Latest qualifying completion containing at least one current own accessible asset',
    ),
    lastVerifiedRunAt: DateTime.nullable().describe(
      'Latest successful completed GET + SHA-256 run qualifying a current own accessible backed-up asset',
    ),
  })
  .meta({ id: 'SafetySummaryDto' });
export class SafetySummaryDto extends createZodDto(SafetySummarySchema) {}
