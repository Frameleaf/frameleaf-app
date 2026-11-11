import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { capabilitiesField } from 'src/dtos/auth.dto.js';
import { PASSKEY_NAME_LENGTH } from 'src/utils/passkey.js';

/**
 * FL-836: passkeys (WebAuthn) for local accounts. The browser's ceremony data passes through as the
 * WebAuthn JSON objects (`PublicKeyCredentialCreationOptionsJSON`, `RegistrationResponseJSON`, …), so
 * they are open objects here; the server checks them with @simplewebauthn/server.
 */

const webAuthnObject = z.record(z.string(), z.unknown());

const PasskeyCredentialSchema = z
  .object({
    id: z.string().min(1).max(1400).describe('The credential id (base64url)'),
    rawId: z.string().min(1).max(1400).describe('The credential id (base64url)'),
    type: z.string().max(32).describe('`public-key`'),
    response: webAuthnObject.describe('The authenticator response, as the browser encodes it in JSON'),
    clientExtensionResults: webAuthnObject.optional().describe('Extension results'),
    authenticatorAttachment: z.string().max(32).optional().describe('`platform` or `cross-platform`'),
  })
  .meta({ id: 'PasskeyCredentialDto' });

const PasskeyOptionsResponseSchema = z
  .object({
    passkeysAvailable: z.boolean().describe('Whether passkeys work at the address the request was sent to'),
    reason: z
      .string()
      .nullable()
      .describe(
        'Why not, when unavailable: `insecure` (a plain http address) or `address` (not the server’s external domain or Frameleaf address). New values may appear.',
      ),
    options: webAuthnObject
      .nullable()
      .describe('The options to pass to the browser (WebAuthn JSON); null when unavailable'),
  })
  .meta({ id: 'PasskeyOptionsResponseDto' });

const PasskeyRegistrationOptionsSchema = z
  .object({
    password: z
      .string()
      .max(1000)
      .optional()
      .describe('The account password, unless it was checked in this session in the last 10 minutes'),
  })
  .meta({ id: 'PasskeyRegistrationOptionsDto' });

const passkeyName = z.string().trim().min(1).max(PASSKEY_NAME_LENGTH).describe('A name to tell passkeys apart');

const PasskeyRegisterSchema = z
  .object({
    credential: PasskeyCredentialSchema,
    name: passkeyName.optional(),
  })
  .meta({ id: 'PasskeyRegisterDto' });

const PasskeyUpdateSchema = z.object({ name: passkeyName }).meta({ id: 'PasskeyUpdateDto' });

const PasskeyLoginSchema = z
  .object({
    credential: PasskeyCredentialSchema,
    rememberMe: z.boolean().optional().describe('Keep the session after the browser closes'),
    capabilities: capabilitiesField,
  })
  .meta({ id: 'PasskeyLoginDto' });

const PasskeyResponseSchema = z
  .object({
    id: z.uuidv7().describe('Passkey ID'),
    name: z.string().describe('The name its owner gave it'),
    provider: z
      .string()
      .nullable()
      .describe('Where it is saved, such as `iCloud Keychain` or `1Password`, when the server knows it'),
    backedUp: z.boolean().describe('It syncs to the owner’s other devices'),
    rpId: z.string().describe('The address it was made on, and works at'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When it was added'),
    lastUsedAt: z.string().meta({ format: 'date-time' }).nullable().describe('When it last signed in'),
  })
  .meta({ id: 'PasskeyResponseDto' });

export class PasskeyCredentialDto extends createZodDto(PasskeyCredentialSchema) {}
export class PasskeyOptionsResponseDto extends createZodDto(PasskeyOptionsResponseSchema) {}
export class PasskeyRegistrationOptionsDto extends createZodDto(PasskeyRegistrationOptionsSchema) {}
export class PasskeyRegisterDto extends createZodDto(PasskeyRegisterSchema) {}
export class PasskeyUpdateDto extends createZodDto(PasskeyUpdateSchema) {}
export class PasskeyLoginDto extends createZodDto(PasskeyLoginSchema) {}
export class PasskeyResponseDto extends createZodDto(PasskeyResponseSchema) {}
