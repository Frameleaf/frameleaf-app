import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MIN_PASSWORD_LENGTH } from 'src/dtos/auth.dto.js';

/**
 * FL-292 (NAPI-012): why setting up a new server from the Frameleaf app (or its first-run page) was
 * refused, so the app can explain it. Every refusal from `server/setup/*` and the first-run sign-up
 * carries one in `code`.
 */
export enum FrameleafSetupErrorCode {
  /** Only from the home network (never over remote access). */
  LanOnly = 'setup_lan_only',
  /** The server already has an administrator: it is set up. */
  Complete = 'setup_complete',
  /** This server has no Frameleaf Cloud address (FRAMELEAF_CLOUD_URL): set it up with a password. */
  CloudUnavailable = 'setup_cloud_unavailable',
  /** This server is already linked to a Frameleaf account. */
  AlreadyLinked = 'setup_already_linked',
  /** The link token is not a Frameleaf link token. */
  LinkTokenInvalid = 'setup_link_token_invalid',
  /** The link token was already used (here or by Frameleaf Cloud) or expired. Get a new one. */
  LinkTokenUsed = 'setup_link_token_used',
  /** Frameleaf Cloud refused or could not be reached; `message` says why. */
  LinkFailed = 'setup_link_failed',
}

const FrameleafSetupErrorCodeSchema = z
  .enum(FrameleafSetupErrorCode)
  .describe('Why setting up this server was refused')
  .meta({ id: 'FrameleafSetupErrorCode' });

const FrameleafSetupErrorSchema = z
  .object({
    message: z.string().describe('What went wrong, in words a person can act on'),
    error: z.string(),
    statusCode: z.int(),
    code: FrameleafSetupErrorCodeSchema,
  })
  .meta({ id: 'FrameleafSetupErrorDto' });

const FrameleafSetupLinkSchema = z
  .object({
    linkToken: z
      .string()
      .trim()
      .max(520)
      .describe('A single-use Frameleaf link token (fll_…) the app got from Frameleaf Cloud for this server'),
    serverName: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('The name the person chose for this server; it is linked under this name'),
  })
  .meta({ id: 'FrameleafSetupLinkDto' });

const FrameleafSetupLinkResponseSchema = z
  .object({
    instanceId: z.string().describe("This server's Frameleaf Cloud instance id"),
    account: z
      .string()
      .nullable()
      .describe(
        'The Frameleaf account that now owns this server; its first Sign in with Frameleaf creates the administrator',
      ),
  })
  .meta({ id: 'FrameleafSetupLinkResponseDto' });

const FrameleafSetupAdminSchema = z
  .object({
    email: z.email().describe('The administrator’s email'),
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
      .describe(`The administrator’s password (min ${MIN_PASSWORD_LENGTH} characters)`),
    name: z.string().trim().min(1).max(200).describe('The administrator’s name'),
  })
  .meta({ id: 'FrameleafSetupAdminDto' });

export class FrameleafSetupErrorDto extends createZodDto(FrameleafSetupErrorSchema) {}
export class FrameleafSetupLinkDto extends createZodDto(FrameleafSetupLinkSchema) {}
export class FrameleafSetupLinkResponseDto extends createZodDto(FrameleafSetupLinkResponseSchema) {}
export class FrameleafSetupAdminDto extends createZodDto(FrameleafSetupAdminSchema) {}
