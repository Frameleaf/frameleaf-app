import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { HiddenContentFilter } from 'src/utils/hidden-content.js';
import { AuthApiKey, AuthSession, AuthSharedLink, AuthUser, UserAdmin } from 'src/database.js';
import { AuthCookie, UserMetadataKey } from 'src/enum.js';
import { UserMetadataItem } from 'src/types.js';
import { toEmail } from 'src/validation.js';

export type CookieResponse = {
  isSecure: boolean;
  rememberMe?: boolean;
  values: Array<{ key: AuthCookie; value: string | null }>;
};

export const pinCodeRegex = /^\d{6}$/;

export type AuthDto = {
  user: AuthUser;
  /** Internal durable worker authority; never populated from a request. */
  system?: true;
  apiKey?: AuthApiKey;
  sharedLink?: AuthSharedLink;
  session?: AuthSession;
  hideNsfwAssets?: boolean;
  hiddenContent?: HiddenContentFilter;
  suppressedContent?: HiddenContentFilter;
};

const LoginCredentialSchema = z
  .object({
    email: toEmail.describe('User email').meta({ example: 'testuser@email.com' }),
    password: z.string().describe('User password').meta({ example: 'password' }),
    rememberMe: z
      .boolean()
      .optional()
      .describe('Persist authentication cookies across browser sessions (default true)'),
  })
  .meta({ id: 'LoginCredentialDto' });

const LoginResponseSchema = z
  .object({
    accessToken: z.string().describe('Access token'),
    userId: z.uuidv4().describe('User ID'),
    userEmail: toEmail.describe('User email'),
    name: z.string().describe('User name'),
    profileImagePath: z.string().describe('Profile image path'),
    isAdmin: z.boolean().describe('Is admin user'),
    shouldChangePassword: z.boolean().describe('Should change password'),
    isOnboarded: z.boolean().describe('Is onboarded'),
  })
  .meta({ id: 'LoginResponseDto' });

export function mapLoginResponse(entity: UserAdmin, accessToken: string): LoginResponseDto {
  const onboardingMetadata = entity.metadata.find(
    (item): item is UserMetadataItem<UserMetadataKey.Onboarding> => item.key === UserMetadataKey.Onboarding,
  )?.value;

  return {
    accessToken,
    userId: entity.id,
    userEmail: entity.email,
    name: entity.name,
    isAdmin: entity.isAdmin,
    profileImagePath: entity.profileImagePath,
    shouldChangePassword: entity.shouldChangePassword,
    isOnboarded: onboardingMetadata?.isOnboarded ?? false,
  };
}

const LogoutResponseSchema = z
  .object({
    successful: z.boolean().describe('Logout successful'),
    redirectUri: z.string().describe('Redirect URI'),
  })
  .meta({ id: 'LogoutResponseDto' });

const SignUpSchema = LoginCredentialSchema.omit({ rememberMe: true })
  .extend({
    name: z.string().describe('User name').meta({ example: 'Admin' }),
  })
  .meta({ id: 'SignUpDto' });

const ChangePasswordSchema = z
  .object({
    password: z.string().describe('Current password').meta({ example: 'password' }),
    newPassword: z.string().min(8).describe('New password (min 8 characters)').meta({ example: 'password' }),
    invalidateSessions: z.boolean().default(false).optional().describe('Invalidate all other sessions'),
  })
  .meta({ id: 'ChangePasswordDto' });

/** FL-538: the single-use link an administrator emailed to choose a password. */
const PasswordLinkCheckSchema = z
  .object({
    token: z.string().min(1).max(200).describe('The token from the emailed link'),
  })
  .meta({ id: 'PasswordLinkCheckDto' });

const PasswordLinkCheckResponseSchema = z
  .object({
    name: z.string().describe('Name of the person the link is for'),
    email: z.string().describe('The email address they sign in with'),
  })
  .meta({ id: 'PasswordLinkCheckResponseDto' });

const PasswordLinkRedeemSchema = PasswordLinkCheckSchema.extend({
  newPassword: z.string().min(8).describe('The password they chose (min 8 characters)').meta({ example: 'password' }),
}).meta({ id: 'PasswordLinkRedeemDto' });

export class PasswordLinkCheckDto extends createZodDto(PasswordLinkCheckSchema) {}
export class PasswordLinkCheckResponseDto extends createZodDto(PasswordLinkCheckResponseSchema) {}
export class PasswordLinkRedeemDto extends createZodDto(PasswordLinkRedeemSchema) {}

const PinCodeSetupSchema = z
  .object({
    pinCode: z.string().regex(pinCodeRegex).describe('PIN code (4-6 digits)').meta({ example: '123456' }),
  })
  .meta({ id: 'PinCodeSetupDto' });

const PinCodeResetSchema = z.object({
  pinCode: z.string().regex(pinCodeRegex).optional().describe('New PIN code (4-6 digits)').meta({ example: '123456' }),
  password: z
    .string()
    .optional()
    .describe('User password (required if PIN code is not provided)')
    .meta({ example: 'password' }),
});

const SessionUnlockSchema = PinCodeResetSchema.meta({ id: 'SessionUnlockDto' });

const PinCodeChangeSchema = PinCodeResetSchema.extend({
  newPinCode: z.string().regex(pinCodeRegex).describe('New PIN code (4-6 digits)'),
}).meta({ id: 'PinCodeChangeDto' });

const ValidateAccessTokenResponseSchema = z
  .object({
    authStatus: z.boolean().describe('Authentication status'),
  })
  .meta({ id: 'ValidateAccessTokenResponseDto' });

export const OAuthCallbackSchema = z
  .object({
    url: z.string().min(1).describe('OAuth callback URL'),
    rememberMe: z
      .boolean()
      .optional()
      .describe('Persist authentication cookies across browser sessions (default true)'),
    state: z.string().optional().describe('OAuth state parameter'),
    codeVerifier: z.string().optional().describe('OAuth code verifier (PKCE)'),
  })
  .meta({ id: 'OAuthCallbackDto' });

const OAuthConfigSchema = z
  .object({
    redirectUri: z.string().describe('OAuth redirect URI'),
    state: z.string().optional().describe('OAuth state parameter'),
    codeChallenge: z.string().optional().describe('OAuth code challenge (PKCE)'),
  })
  .meta({ id: 'OAuthConfigDto' });

const OAuthAuthorizeResponseSchema = z
  .object({
    url: z.string().describe('OAuth authorization URL'),
  })
  .meta({ id: 'OAuthAuthorizeResponseDto' });

const OAuthBackchannelLogoutSchema = z
  .object({ logout_token: z.string().describe('OAuth logout token') })
  .meta({ id: 'OAuthBackchannelLogoutDto' });

const AuthStatusResponseSchema = z
  .object({
    pinCode: z.boolean().describe('Has PIN code set'),
    password: z.boolean().describe('Has password set'),
    isElevated: z.boolean().describe('Is elevated session'),
    expiresAt: z.string().optional().describe('Session expiration date'),
    pinExpiresAt: z.string().optional().describe('PIN expiration date'),
  })
  .meta({ id: 'AuthStatusResponseDto' });

export class LoginCredentialDto extends createZodDto(LoginCredentialSchema) {}
export class LoginResponseDto extends createZodDto(LoginResponseSchema) {}
export class LogoutResponseDto extends createZodDto(LogoutResponseSchema) {}
export class SignUpDto extends createZodDto(SignUpSchema) {}
export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}
export class PinCodeSetupDto extends createZodDto(PinCodeSetupSchema) {}
export class PinCodeResetDto extends createZodDto(PinCodeResetSchema) {}
export class SessionUnlockDto extends createZodDto(SessionUnlockSchema) {}
export class PinCodeChangeDto extends createZodDto(PinCodeChangeSchema) {}
export class ValidateAccessTokenResponseDto extends createZodDto(ValidateAccessTokenResponseSchema) {}
export class OAuthCallbackDto extends createZodDto(OAuthCallbackSchema) {}
/** FL-367: the details a provider check reads; nothing is saved. */
const OAuthCheckSchema = z
  .object({
    issuerUrl: z.url().describe('The provider address (issuer URL)'),
    clientId: z.string().min(1).describe('Client ID given by the provider'),
    clientSecret: z.string().optional().describe('Client secret; empty to use the saved one'),
    allowInsecureRequests: z.boolean().optional().describe('Allow a provider without a valid certificate'),
  })
  .meta({ id: 'OAuthCheckDto' });

const OAuthCheckResponseSchema = z
  .object({
    ok: z.boolean().describe('Whether the provider answered'),
    issuer: z.string().nullable().describe('The issuer the provider names, when it answered'),
    error: z.string().nullable().describe('Why the check failed, when it did'),
  })
  .meta({ id: 'OAuthCheckResponseDto' });

export class OAuthCheckDto extends createZodDto(OAuthCheckSchema) {}
export class OAuthCheckResponseDto extends createZodDto(OAuthCheckResponseSchema) {}
export class OAuthConfigDto extends createZodDto(OAuthConfigSchema) {}
export class OAuthAuthorizeResponseDto extends createZodDto(OAuthAuthorizeResponseSchema) {}
export class OAuthBackchannelLogoutDto extends createZodDto(OAuthBackchannelLogoutSchema) {}
export class AuthStatusResponseDto extends createZodDto(AuthStatusResponseSchema) {}
