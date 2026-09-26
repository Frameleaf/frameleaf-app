import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { HEARTBEAT_FIELDS } from 'src/utils/frameleaf-cloud-link.js';

/**
 * Linking this server to a Frameleaf account (FL-154 status, FL-155 link lifecycle). Customer copy
 * says "Frameleaf Cloud"; nothing here names a GPU provider. No secret ever appears in a response:
 * the device code and link tokens stay on the server or are never kept.
 */

export const CloudLinkStateSchema = z
  .enum(['not-configured', 'unlinked', 'pending', 'linked', 'revoked'])
  .describe(
    'not-configured: FRAMELEAF_CLOUD_URL is unset and nothing is contacted; unlinked: configured but not linked; pending: waiting for approval of a device code; linked; revoked: Frameleaf Cloud ended the link',
  )
  .meta({ id: 'CloudLinkState' });

export const CloudLinkResultSchema = z
  .enum(['pending', 'approved', 'denied', 'expired'])
  .describe('How the current or last device authorization stands')
  .meta({ id: 'CloudLinkResult' });

export const CloudLinkRefusalSchema = z
  .enum(['instance-limit', 'server-refused', 'instance-id-taken', 'key-already-linked'])
  .describe(
    'Why Frameleaf Cloud refused the last link: instance-limit: the plan has no room for another server; server-refused: the server was removed from the account or the account is suspended; instance-id-taken: this server, or another one with its ID, is still registered; key-already-linked: this server’s key is already linked (a copied identity directory)',
  )
  .meta({ id: 'CloudLinkRefusal' });

export const CloudPermissionsSchema = z
  .object({
    allowRemoteEnable: z.boolean().describe('Frameleaf Cloud may turn remote access on or off'),
    allowBackupTrigger: z.boolean().describe('Frameleaf Cloud may start a cloud backup run'),
    allowEntitlementRefresh: z
      .boolean()
      .describe('Frameleaf Cloud may refresh the plan and rotate this server’s credentials'),
  })
  .meta({ id: 'CloudPermissionsDto' });

const CloudLinkPendingSchema = z
  .object({
    userCode: z.string().describe('The code to enter on the approval page, XXXX-XXXX'),
    verificationUri: z.string(),
    verificationUriComplete: z.string().describe('The approval page with the code filled in; shown as a QR code'),
    expiresAt: z.string(),
    intervalSeconds: z.int().describe('How often this server asks whether the code was approved'),
  })
  .meta({ id: 'CloudLinkPendingDto' });

export const CloudHeartbeatFieldSchema = z.enum(HEARTBEAT_FIELDS).meta({ id: 'CloudHeartbeatField' });

const CloudStatusResponseSchema = z
  .object({
    state: CloudLinkStateSchema,
    configured: z.boolean().describe('FRAMELEAF_CLOUD_URL is set'),
    cloudHost: z.string().nullable().describe('Host of the configured Frameleaf Cloud address'),
    instanceId: z.string().nullable().describe('This server’s instance ID, once its identity exists'),
    keyFingerprint: z.string().nullable().describe('RFC 7638 thumbprint of this server’s key'),
    account: z
      .object({ id: z.string().nullable(), label: z.string().nullable() })
      .nullable()
      .describe('The linked Frameleaf account'),
    dataRegion: z.string().nullable(),
    linkedAt: z.string().nullable(),
    lastContactAt: z.string().nullable(),
    pending: CloudLinkPendingSchema.nullable(),
    linkResult: CloudLinkResultSchema.nullable(),
    linkRefusal: CloudLinkRefusalSchema.nullable().describe(
      'Why Frameleaf Cloud refused the last link attempt, while unlinked; null when it gave no such reason',
    ),
    permissions: CloudPermissionsSchema,
    revoked: z.object({ at: z.string(), reason: z.string() }).nullable(),
    lastError: z.string().nullable().describe('The last link or check-in problem, in plain words'),
    heartbeatFields: z
      .array(CloudHeartbeatFieldSchema)
      .describe('Exactly the fields each check-in sends; the "What this server sends" panel lists them'),
    heartbeatFailures: z.int().describe('Check-ins that failed in a row'),
    cloneSuspected: z.boolean().describe('Frameleaf Cloud saw this server’s identity start from two places'),
    relinkRequested: z.boolean().describe('Frameleaf Cloud asked an administrator to link again'),
    linkTokenConfigured: z.boolean().describe('FRAMELEAF_LINK_TOKEN is set'),
    remoteAccessEnabled: z.boolean().describe('Remote access is switched on for this linked server'),
    signInClientId: z.string().nullable().describe('The OpenID client ID for Sign in with Frameleaf'),
    signInIssuer: z.string().nullable(),
    signInLinkedAccounts: z.int().describe('Accounts here linked to a Frameleaf account'),
    signInShowOnLocalLogin: z.boolean().describe('Sign in with Frameleaf is offered at home too'),
    signInButtonText: z.string().describe('The Sign in with Frameleaf button text'),
    allowOriginalsOverRelay: z
      .boolean()
      .describe('Originals, archives and database backups may be downloaded through the relay'),
    allowPasswordOverRelay: z.boolean().describe('Password sign-in is allowed away from home'),
  })
  .meta({ id: 'CloudStatusResponseDto' });

const CloudPermissionsUpdateSchema = CloudPermissionsSchema.partial().meta({ id: 'CloudPermissionsUpdateDto' });

export class CloudStatusResponseDto extends createZodDto(CloudStatusResponseSchema) {}
const CloudSignInUpdateSchema = z
  .object({
    showOnLocalLogin: z.boolean().optional().describe('Offer Sign in with Frameleaf on the login page at home'),
    buttonText: z.string().trim().min(1).max(100).optional().describe('The Sign in with Frameleaf button text'),
  })
  .meta({ id: 'CloudSignInUpdateDto' });

export class CloudSignInUpdateDto extends createZodDto(CloudSignInUpdateSchema) {}

const CloudRemoteAccessUpdateSchema = z
  .object({
    allowOriginalsOverRelay: z
      .boolean()
      .optional()
      .describe('Allow original downloads, archives and database backups through the relay'),
    allowPasswordOverRelay: z.boolean().optional().describe('Allow password sign-in away from home'),
  })
  .meta({ id: 'CloudRemoteAccessUpdateDto' });

export class CloudRemoteAccessUpdateDto extends createZodDto(CloudRemoteAccessUpdateSchema) {}
export class CloudPermissionsUpdateDto extends createZodDto(CloudPermissionsUpdateSchema) {}
