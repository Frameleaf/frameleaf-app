import { timingSafeEqual } from 'node:crypto';
import z from 'zod';

/**
 * Item-scoped, short-lived media URLs for Cast receivers (Google Cast, AirPlay-style receivers on the
 * home network). A receiver cannot carry the app's session token or cookies, so the app asks for a URL
 * that names exactly one item and one rendition, expires after `CAST_MEDIA_TTL_MS`, and is signed with
 * this server's own keyed-hash secret (`server-hmac.key`, purpose `CAST_MEDIA_PURPOSE`). The URL never
 * holds a session token: only the item, the account, the session (or API key) id it was issued to, the
 * rendition and the expiry. Every read re-checks that session, the account's access, the Locked and
 * hidden-content rules and the administrator's casting switch, so revoking any of them ends the URL.
 */
export const CAST_MEDIA_PURPOSE = 'cast-media-v1';
/** How long a Cast URL works after it was issued. */
export const CAST_MEDIA_TTL_MS = 15 * 60 * 1000;

export enum CastMediaKind {
  /** The original file (needs download permission). */
  Original = 'original',
  /** The edited preview image (a JPEG/WebP a receiver can show). */
  Preview = 'preview',
  /** The playable video stream (byte ranges supported). */
  Video = 'video',
}

const claimsSchema = z
  .object({
    v: z.literal(1),
    /** The item. */
    a: z.uuid(),
    /** The account it was issued to. */
    u: z.uuid(),
    /** The session it was issued from, or null for an API key. */
    s: z.uuid().nullable(),
    /** The API key it was issued with, or null for a session. */
    k: z.uuid().nullable(),
    /** The rendition. */
    m: z.enum(CastMediaKind),
    /** Expiry, epoch milliseconds. */
    e: z.int().positive(),
  })
  .strict();
export type CastMediaClaims = z.infer<typeof claimsSchema>;

/** Computes the keyed hash of a payload (the server key, with the cast purpose). */
export type CastMediaMac = (payload: string) => Promise<string>;

const constantTimeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** `<payload>.<mac>`: base64url JSON claims and their keyed hash. */
export const signCastMediaToken = async (claims: CastMediaClaims, mac: CastMediaMac): Promise<string> => {
  const payload = Buffer.from(JSON.stringify(claimsSchema.parse(claims))).toString('base64url');
  return `${payload}.${await mac(payload)}`;
};

/**
 * The claims of a token, or null when it is malformed, its signature does not match (any change to the
 * item, account, rendition or expiry breaks it) or it has expired.
 */
export const verifyCastMediaToken = async (
  token: string,
  mac: CastMediaMac,
  now = Date.now(),
): Promise<CastMediaClaims | null> => {
  if (token.length > 1024) {
    return null;
  }
  const [payload, signature, extra] = token.split('.', 3);
  if (!payload || !signature || extra !== undefined || !/^[\w-]+$/.test(payload)) {
    return null;
  }
  if (!constantTimeEqual(signature, await mac(payload))) {
    return null;
  }
  try {
    const claims = claimsSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return claims.success && claims.data.e > now ? claims.data : null;
  } catch {
    return null;
  }
};

/** The path of a Cast URL, relative to the server's origin (prefix the address the receiver can reach). */
export const castMediaPath = (token: string) => `/api/cast/${token}`;
