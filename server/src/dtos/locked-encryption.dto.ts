import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { pinCodeRegex } from 'src/dtos/auth.dto.js';

/** FL-721 (spec §2): ask for the passphrase again after this many hours; null means only after a restart. */
export const LOCKED_ASK_AGAIN_HOURS = [8, 24, 72] as const;
export type LockedAskAgainHours = (typeof LOCKED_ASK_AGAIN_HOURS)[number] | null;
export const LOCKED_ASK_AGAIN_DEFAULT = 72;

const ModeSchema = z
  .enum(['pin', 'advanced'])
  .describe('`pin`: the Locked PIN opens the files. `advanced`: a passphrase typed after every restart opens them.')
  .meta({ id: 'LockedEncryptionMode' });
const StateSchema = z
  .enum(['encrypting', 'on', 'decrypting'])
  .describe('`encrypting` while turning on, `on` once every file is encrypted, `decrypting` while turning off')
  .meta({ id: 'LockedEncryptionState' });
const AskAgainHoursSchema = z
  .int()
  .refine((hours) => (LOCKED_ASK_AGAIN_HOURS as readonly number[]).includes(hours), {
    message: 'askAgainHours must be 8, 24 or 72',
  })
  .nullable()
  .describe('Advanced Security: ask for the passphrase again after 8, 24 or 72 hours; null only after a restart');
const pinCode = z.string().regex(pinCodeRegex);
/** The same bounds as the Buddy Backup recovery passphrase. */
const passphrase = z.string().min(12).max(1024);
const recoveryKey = z.string().min(1).max(256);

const LockedEncryptionProgressSchema = z
  .object({
    done: z.int().nonnegative().describe('Items whose files are done'),
    total: z.int().nonnegative().describe('Items to do'),
  })
  .meta({ id: 'LockedEncryptionProgressDto' });

const LockedEncryptionStatusSchema = z
  .object({
    enabled: z.boolean().describe('Whether Locked encryption is on (or turning on or off) for you'),
    mode: ModeSchema.nullable(),
    status: StateSchema.nullable(),
    keyLoaded: z.boolean().describe('Whether your key is open on this server now'),
    expiresAt: z.string().nullable().describe('When the open key is asked for again; null while it stays open'),
    askAgainHours: AskAgainHoursSchema,
    recoveryKeyCreatedAt: z.string().nullable().describe('When the current recovery key was made'),
    progress: LockedEncryptionProgressSchema.nullable().describe('Progress while encrypting or decrypting'),
    counts: z
      .object({
        encrypted: z.int().nonnegative().describe('Locked items whose files are encrypted'),
        notEncryptable: z
          .int()
          .nonnegative()
          .describe('Locked items in a folder Frameleaf can’t change, which stay unencrypted'),
        missing: z
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Locked items that turning off, or taking an item out of Locked, is waiting on because their file is missing',
          ),
      })
      .meta({ id: 'LockedEncryptionCountsDto' }),
  })
  .meta({ id: 'LockedEncryptionStatusResponseDto' });

const LockedEncryptionEnableSchema = z
  .object({
    mode: ModeSchema,
    pinCode: pinCode.describe('Your Locked PIN'),
    passphrase: passphrase.optional().describe('Advanced Security only: at least 12 characters'),
  })
  .meta({ id: 'LockedEncryptionEnableDto' });

const LockedEncryptionDisableSchema = z
  .object({
    pinCode: pinCode.optional().describe('PIN mode: your Locked PIN'),
    passphrase: z.string().min(1).max(1024).optional().describe('Advanced Security: your passphrase'),
  })
  .meta({ id: 'LockedEncryptionDisableDto' });

const LockedEncryptionUnlockSchema = z
  .object({ passphrase: z.string().min(1).max(1024).describe('Your passphrase') })
  .meta({ id: 'LockedEncryptionUnlockDto' });

const LockedEncryptionPartnerUnlockSchema = z
  .object({
    ownerId: z.uuidv4().describe('The partner who shares their library with you and uses Advanced Security'),
    passphrase: z.string().min(1).max(1024).describe("That partner's passphrase"),
  })
  .meta({ id: 'LockedEncryptionPartnerUnlockDto' });

const LockedEncryptionUpdateSchema = z
  .object({
    mode: ModeSchema.optional().describe('Switch between PIN and Advanced Security'),
    askAgainHours: AskAgainHoursSchema.optional(),
    currentSecret: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe('Your PIN (PIN mode) or passphrase (Advanced Security); required to switch mode or passphrase'),
    newPassphrase: passphrase.optional().describe('The new passphrase, when switching to or within Advanced Security'),
    pinCode: pinCode.optional().describe('Your Locked PIN, when switching to PIN mode'),
  })
  .meta({ id: 'LockedEncryptionUpdateDto' });

const LockedEncryptionRecoveryKeySchema = z
  .object({
    secret: z.string().min(1).max(1024).describe('Your PIN (PIN mode) or passphrase (Advanced Security)'),
  })
  .meta({ id: 'LockedEncryptionRecoveryKeyDto' });

const LockedEncryptionRecoverSchema = z
  .object({
    recoveryKey: recoveryKey.describe('Your recovery key, FLRK- and 8 groups of 4 characters'),
    newPinCode: pinCode.optional().describe('A new Locked PIN'),
    newPassphrase: passphrase.optional().describe('Advanced Security: a new passphrase'),
  })
  .meta({ id: 'LockedEncryptionRecoverDto' });

const LockedEncryptionRecoveryKeyResponseSchema = z
  .object({
    recoveryKey: z.string().describe('Shown this once: FLRK- and 8 groups of 4 characters. It is never shown again.'),
  })
  .meta({ id: 'LockedEncryptionRecoveryKeyResponseDto' });

export class LockedEncryptionStatusResponseDto extends createZodDto(LockedEncryptionStatusSchema) {}
export class LockedEncryptionEnableDto extends createZodDto(LockedEncryptionEnableSchema) {}
export class LockedEncryptionDisableDto extends createZodDto(LockedEncryptionDisableSchema) {}
export class LockedEncryptionUnlockDto extends createZodDto(LockedEncryptionUnlockSchema) {}
export class LockedEncryptionPartnerUnlockDto extends createZodDto(LockedEncryptionPartnerUnlockSchema) {}
export class LockedEncryptionUpdateDto extends createZodDto(LockedEncryptionUpdateSchema) {}
export class LockedEncryptionRecoveryKeyDto extends createZodDto(LockedEncryptionRecoveryKeySchema) {}
export class LockedEncryptionRecoverDto extends createZodDto(LockedEncryptionRecoverSchema) {}
export class LockedEncryptionRecoveryKeyResponseDto extends createZodDto(LockedEncryptionRecoveryKeyResponseSchema) {}
