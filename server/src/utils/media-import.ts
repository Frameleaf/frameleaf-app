import { BadRequestException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { parse } from 'tldts';
import type { MediaDownloadSession } from 'src/repositories/media-downloader.repository.js';
import type { MediaSubscription } from 'src/repositories/media-import.repository.js';

export const nextMediaCheck = (minutes: number, now = Date.now(), random = Math.random()) =>
  new Date(now + minutes * 60_000 + Math.floor(Math.min(60_000, minutes * 3000) * random));

export function subscriptionSince(
  subscription: Pick<
    MediaSubscription,
    'history' | 'historyComplete' | 'lastSuccessAt' | 'lastReconcileAt' | 'createdAt'
  >,
  now = Date.now(),
) {
  const baseline =
    subscription.history.mode === 'since'
      ? subscription.history.since!
      : subscription.history.mode === 'new'
        ? subscription.createdAt.toISOString()
        : null;
  if (
    !subscription.historyComplete ||
    !subscription.lastSuccessAt ||
    !subscription.lastReconcileAt ||
    now - subscription.lastReconcileAt.getTime() >= 7 * 86_400_000
  )
    return baseline;
  const overlap = new Date(subscription.lastSuccessAt.getTime() - 2 * 86_400_000).toISOString();
  return baseline && Date.parse(baseline) > Date.parse(overlap) ? baseline : overlap;
}

export const mediaSourceKey = (entry: { provider: string; postId: string; attachmentId: string }) =>
  createHash('sha256')
    .update(JSON.stringify([entry.provider, entry.postId, entry.attachmentId]))
    .digest('hex');

export function validateMediaSession(session: MediaDownloadSession) {
  const domains = session.domains;
  if (
    domains.length === 0 ||
    domains.length > 20 ||
    domains.some(
      (domain) =>
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(domain) ||
        !parse(domain, { allowPrivateDomains: true }).domain,
    )
  ) {
    throw new BadRequestException('Select the exact domains to connect');
  }
  if ((session.cookies?.length ?? 0) > 500) throw new BadRequestException('Too many cookies');
  for (const cookie of session.cookies ?? []) {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    if (domains.every((approved) => !(domain === approved || domain.endsWith(`.${approved}`))))
      throw new BadRequestException('Cookie domain was not approved');
    if (cookie.partitionKey)
      throw new BadRequestException('This extractor cannot use partitioned cookies; use provider authorization');
    if ([cookie.name, cookie.value, cookie.domain, cookie.path].some((value) => /[\r\n\t\0]/.test(value)))
      throw new BadRequestException('Invalid cookie');
  }
}

export function encryptMediaSession(key: Buffer, ownerId: string, connectionId: string, session: MediaDownloadSession) {
  validateMediaSession(session);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`media:v1:${ownerId}:${connectionId}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptMediaSession(
  key: Buffer,
  ownerId: string,
  connectionId: string,
  value: string,
): MediaDownloadSession {
  const bytes = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(`media:v1:${ownerId}:${connectionId}`));
  cipher.setAuthTag(bytes.subarray(12, 28));
  const session: MediaDownloadSession = JSON.parse(
    Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(),
  );
  validateMediaSession(session);
  return session;
}
