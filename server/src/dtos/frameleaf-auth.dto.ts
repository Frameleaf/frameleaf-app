import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** Sign in with Frameleaf (FL-158): a person's own Frameleaf account link and the sign-in handoff. */

const FrameleafAccountLinkResponseSchema = z
  .object({
    available: z.boolean().describe('Sign in with Frameleaf is available on this server (it is linked)'),
    linked: z.boolean(),
    email: z.string().nullable().describe('The linked Frameleaf account’s email'),
    linkedAt: z.string().nullable(),
    lastSignInAt: z.string().nullable(),
  })
  .meta({ id: 'FrameleafAccountLinkResponseDto' });

const FrameleafHandoffResponseSchema = z
  .object({
    code: z.string().describe('A single-use code for signing in on another address of this server'),
    expiresAt: z.string(),
    url: z
      .string()
      .nullable()
      .describe('Where to continue with the code: the home address asked for, when this server published it'),
  })
  .meta({ id: 'FrameleafHandoffResponseDto' });

const FrameleafHandoffRedeemSchema = z
  .object({
    code: z.string().min(16).max(200).describe('The code from POST oauth/frameleaf/handoff'),
    rememberMe: z.boolean().optional(),
  })
  .meta({ id: 'FrameleafHandoffRedeemDto' });

const FrameleafHandoffCreateSchema = z
  .object({
    returnTo: z
      .string()
      .max(2048)
      .optional()
      .describe('The home address to sign in on; only an address this server published for its home network'),
  })
  .meta({ id: 'FrameleafHandoffCreateDto' });

export class FrameleafAccountLinkResponseDto extends createZodDto(FrameleafAccountLinkResponseSchema) {}
export class FrameleafHandoffResponseDto extends createZodDto(FrameleafHandoffResponseSchema) {}
export class FrameleafHandoffCreateDto extends createZodDto(FrameleafHandoffCreateSchema) {}
export class FrameleafHandoffRedeemDto extends createZodDto(FrameleafHandoffRedeemSchema) {}
