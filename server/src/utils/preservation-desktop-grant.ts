import { createHash, randomBytes } from 'node:crypto';

const LIFETIME = 5 * 60 * 1000;
const MAX_GRANTS = 256;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export const localDesktopCopyHost = (host: string | undefined, peer: string | undefined) => {
  if (
    host &&
    /^127\.0\.0\.1(?::[1-9][0-9]{0,4})?$/.test(host) &&
    Number(host.split(':')[1] ?? 80) <= 65_535 &&
    (peer === '127.0.0.1' || peer === '::ffff:127.0.0.1')
  ) {
    return host;
  }
};

export class PreservationDesktopGrants {
  private readonly grants = new Map<
    string,
    { ownerId: string; sessionId: string; packageId: string; host: string; expires: number }
  >();

  issue(ownerId: string, sessionId: string, packageId: string, host: string, now = Date.now()) {
    for (const [key, grant] of this.grants) {
      if (grant.expires <= now) {
        this.grants.delete(key);
      }
    }
    if (this.grants.size >= MAX_GRANTS) {
      return;
    }
    const token = randomBytes(32).toString('base64url');
    this.grants.set(digest(token), { ownerId, sessionId, packageId, host, expires: now + LIFETIME });
    return token;
  }

  take(token: string | undefined, packageId: string, host: string, now = Date.now()) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return;
    }
    const key = digest(token);
    const grant = this.grants.get(key);
    if (!grant || grant.packageId !== packageId || grant.host !== host || grant.expires <= now) {
      return;
    }
    this.grants.delete(key);
    return { ownerId: grant.ownerId, sessionId: grant.sessionId };
  }

  revokeSession(sessionId: string) {
    for (const [key, grant] of this.grants) {
      if (grant.sessionId === sessionId) {
        this.grants.delete(key);
      }
    }
  }
}
