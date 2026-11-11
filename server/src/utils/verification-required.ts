import { ForbiddenException } from '@nestjs/common';
import { ACR_VERIFIED } from 'src/utils/sign-in-level.js';

/** Contract A.2: the body of a 403 that asks for more than the sign-in reached. */
export const VERIFICATION_REQUIRED = 'verification_required';
export const TWO_FACTOR_SETUP_REQUIRED = 'two_factor_setup_required';
/** How long a `transaction` lives (seconds). */
export const VERIFICATION_TRANSACTION_SECONDS = 600;

export type VerificationMethod = 'frameleaf' | 'totp' | 'recovery_code' | 'password';

export const verificationRequired = (methods: VerificationMethod[], transaction: string) =>
  new ForbiddenException({
    message: 'More is needed to sign in here. Confirm with your passkey or your authenticator.',
    error: 'Forbidden',
    statusCode: 403,
    code: VERIFICATION_REQUIRED,
    acr: ACR_VERIFIED,
    maxAge: null,
    methods,
    transaction,
  });

export const twoFactorSetupRequired = () =>
  new ForbiddenException({
    message: 'This server needs Two-Step Verification on every account. Set it up to continue.',
    error: 'Forbidden',
    statusCode: 403,
    code: TWO_FACTOR_SETUP_REQUIRED,
  });
