import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * FL-292 (NAPI-012): why setting up a new server from the Frameleaf app (or its first-run page) was
 * refused, so the app can explain it. Every refusal from `server/setup/*` and the first-run sign-up
 * carries one in `code`; a refused code also says how many tries are left before it is replaced.
 */
export enum FrameleafSetupErrorCode {
  /** Only from the home network (never over remote access). */
  LanOnly = 'setup_lan_only',
  /** The server already has an administrator: it is set up. */
  Complete = 'setup_complete',
  /** No setup code was given. */
  CodeRequired = 'setup_code_required',
  /** The setup code is wrong; `attemptsLeft` says how many tries remain. */
  CodeInvalid = 'setup_code_invalid',
  /** Too many wrong tries: the server shows a new code on its console and in its log. */
  CodeReplaced = 'setup_code_replaced',
  /** Too many wrong tries for a code pinned with FRAMELEAF_SETUP_CODE: restart the server. */
  CodeLocked = 'setup_code_locked',
  /** The setup ticket is missing, used, expired or from another device. Enter the code again. */
  TicketInvalid = 'setup_ticket_invalid',
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
    attemptsLeft: z
      .int()
      .min(0)
      .optional()
      .describe('For setup_code_invalid: wrong tries left before the code is replaced'),
  })
  .meta({ id: 'FrameleafSetupErrorDto' });

// no shape checks here: an empty code, a short ticket or a malformed link token is refused with its
// own FrameleafSetupErrorCode (setup_code_required, setup_ticket_invalid, setup_link_token_invalid)
const setupCode = z
  .string()
  .trim()
  .max(32)
  .describe("The setup code shown on the server's console and in its log (XXXX-XXXX, the dash optional)");

const ticket = z
  .string()
  .trim()
  .max(256)
  .describe('The setup ticket POST server/setup/code returned, used once, from the same device');

const FrameleafSetupCodeSchema = z.object({ code: setupCode }).meta({ id: 'FrameleafSetupCodeDto' });

const FrameleafSetupTicketResponseSchema = z
  .object({
    ticket: z.string().describe('Proof the setup code was entered: use it once, from this device, before it expires'),
    expiresAt: z.string().meta({ format: 'date-time' }).describe('When the ticket stops working'),
  })
  .meta({ id: 'FrameleafSetupTicketResponseDto' });

const FrameleafSetupLinkSchema = z
  .object({
    ticket,
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
    ticket,
    email: z.email().describe('The administrator’s email'),
    password: z.string().min(8).describe('The administrator’s password (min 8 characters)'),
    name: z.string().trim().min(1).max(200).describe('The administrator’s name'),
  })
  .meta({ id: 'FrameleafSetupAdminDto' });

export class FrameleafSetupErrorDto extends createZodDto(FrameleafSetupErrorSchema) {}
export class FrameleafSetupCodeDto extends createZodDto(FrameleafSetupCodeSchema) {}
export class FrameleafSetupTicketResponseDto extends createZodDto(FrameleafSetupTicketResponseSchema) {}
export class FrameleafSetupLinkDto extends createZodDto(FrameleafSetupLinkSchema) {}
export class FrameleafSetupLinkResponseDto extends createZodDto(FrameleafSetupLinkResponseSchema) {}
export class FrameleafSetupAdminDto extends createZodDto(FrameleafSetupAdminSchema) {}
