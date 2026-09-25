import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * FL-176: Frameleaf first-run setup. The saved progress is a strict, password-free payload: every
 * field is named here and any other key (a password included) is rejected, so nothing secret can
 * be persisted with the setup state.
 */
const FrameleafSetupFlowSchema = z.enum(['new', 'existing']).describe('Setup flow').meta({ id: 'FrameleafSetupFlow' });

const FrameleafSetupChoicesSchema = z
  .object({
    language: z.string().max(12).optional().describe('Language chosen on the welcome step'),
    signIn: z
      .enum(['frameleaf', 'local'])
      .meta({ id: 'FrameleafSetupSignIn' })
      .optional()
      .describe('How the administrator signs in'),
    linked: z.boolean().optional().describe('Whether the server is linked to a Frameleaf account'),
    accountCreated: z.boolean().optional().describe('Whether the local administrator exists'),
    signedIn: z.boolean().optional().describe('Whether the administrator signed in (existing library)'),
    restore: z
      .enum(['restore', 'fresh'])
      .meta({ id: 'FrameleafSetupRestore' })
      .optional()
      .describe('Choice for a found cloud backup'),
    adminName: z.string().max(120).optional().describe('Administrator name'),
    adminEmail: z.string().max(120).optional().describe('Administrator email'),
    layout: z.string().max(40).optional().describe('Folder layout preset, or "keep"'),
    model: z
      .enum(['light', 'balanced', 'best'])
      .meta({ id: 'FrameleafSetupModelTier' })
      .optional()
      .describe('Model tier'),
    processing: z
      .enum(['local', 'cloud', 'later'])
      .meta({ id: 'FrameleafSetupProcessing' })
      .optional()
      .describe('Where processing runs'),
    nightlyBackup: z.boolean().optional().describe('Nightly database backups'),
    updates: z.boolean().optional().describe('Check for Frameleaf updates'),
    map: z.boolean().optional().describe('Map tiles'),
    theme: z.enum(['dark', 'light']).meta({ id: 'FrameleafSetupTheme' }).optional().describe('Theme after setup'),
  })
  .strict()
  .meta({ id: 'FrameleafSetupChoicesDto' });

const FrameleafSetupProgressSchema = z
  .object({
    version: z.int().min(1).max(1).describe('Payload version (1)'),
    step: z.string().min(1).max(40).describe('Current step id'),
    reached: z.int().min(0).max(40).describe('Furthest step index reached'),
    choices: FrameleafSetupChoicesSchema,
  })
  .strict()
  .meta({ id: 'FrameleafSetupProgressDto' });

const FrameleafSetupUpdateSchema = z
  .object({
    flow: FrameleafSetupFlowSchema.optional(),
    progress: FrameleafSetupProgressSchema,
  })
  .strict()
  .meta({ id: 'FrameleafSetupUpdateDto' });

const FrameleafSetupResponseSchema = z
  .object({
    completed: z.boolean().describe('Whether Frameleaf setup is complete'),
    completedAt: z.string().nullable().describe('When setup was completed'),
    flow: FrameleafSetupFlowSchema,
    progress: FrameleafSetupProgressSchema.nullable(),
  })
  .meta({ id: 'FrameleafSetupResponseDto' });

const FrameleafSetupLibraryResponseSchema = z
  .object({
    items: z.int().describe('Photos and videos on the server'),
    people: z.int().describe('Named and unnamed people'),
    albums: z.int().describe('Albums'),
    bytes: z.int().describe('Size of the originals in bytes'),
    users: z.int().describe('Accounts on the server'),
  })
  .meta({ id: 'FrameleafSetupLibraryResponseDto' });

const FrameleafSetupStorageResponseSchema = z
  .object({
    path: z.string().describe('Where the library is stored'),
    writable: z.boolean().describe('Whether Frameleaf can write there'),
    freeBytes: z.int().describe('Free space in bytes'),
    totalBytes: z.int().describe('Total space in bytes'),
  })
  .meta({ id: 'FrameleafSetupStorageResponseDto' });

export type FrameleafSetupProgress = z.infer<typeof FrameleafSetupProgressSchema>;
export const frameleafSetupProgressSchema = FrameleafSetupProgressSchema;

export class FrameleafSetupUpdateDto extends createZodDto(FrameleafSetupUpdateSchema) {}
export class FrameleafSetupResponseDto extends createZodDto(FrameleafSetupResponseSchema) {}
export class FrameleafSetupLibraryResponseDto extends createZodDto(FrameleafSetupLibraryResponseSchema) {}
export class FrameleafSetupStorageResponseDto extends createZodDto(FrameleafSetupStorageResponseSchema) {}
