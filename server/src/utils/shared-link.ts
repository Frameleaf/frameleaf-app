import { UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { CryptoRepository } from 'src/repositories/crypto.repository.js';

/** Compare secrets in constant time, including legacy plaintext shared-link passwords. */
export const sharedLinkSecretEqual = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export const getSharedLinkToken = (
  crypto: CryptoRepository,
  directory: string,
  sharedLink: { id: string; password: string },
) => crypto.serverKeyedHash(directory, 'shared-link-unlock', `${sharedLink.id}-${sharedLink.password}`);

export const requireSharedLinkUnlocked = async (
  crypto: CryptoRepository,
  directory: string,
  sharedLink: { id: string; password: string | null },
  tokens: string[],
): Promise<void> => {
  if (!sharedLink.password) {
    return;
  }
  const expected = await getSharedLinkToken(crypto, directory, { id: sharedLink.id, password: sharedLink.password });
  if (tokens.every((token) => !sharedLinkSecretEqual(token, expected))) {
    throw new UnauthorizedException('Password required');
  }
};
