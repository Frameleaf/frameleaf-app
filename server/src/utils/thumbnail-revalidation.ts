import { NextFunction, Request, RequestHandler, Response } from 'express';
import { createHash } from 'node:crypto';
import { requestVia } from 'src/middleware/frameleaf-via.middleware.js';

/**
 * FL-1787: a thumbnail sent as "revalidate every time" (FL-1771: plain http, or an unlocked session)
 * comes back as a conditional request per tile. Answering each one costs the sign-in queries, the
 * access check and the asset lookup, only to say 304.
 *
 * This remembers, for a short time and in this process only, that the full path answered this exact
 * request (same credentials, same arrival, same URL) with this ETag. The same conditional request
 * inside that time gets its 304 here, before any database work. Nothing is ever sent from here but a
 * bodiless 304, so the browser still holds only what the full path gave it.
 *
 * A lock, sign-out or session removal forgets everything at once (`forgetThumbnailRevalidations`,
 * called by the session repository's writes).
 * Anything else that ends access (a share removed, an asset deleted, an elevation timing out) stops
 * the 304s when the entry runs out, at most `THUMBNAIL_REVALIDATION_TTL_MS` after the full path last
 * checked access (counted from the request's arrival, so a slow response never extends it).
 */
export const THUMBNAIL_REVALIDATION_TTL_MS = 30_000;
// ponytail: one Map, oldest dropped first; ~300 bytes an entry. An LRU if this ever shows in a profile.
const MAX_ENTRIES = 20_000;
const THUMBNAIL_PATH = /^\/api\/assets\/[\da-f-]{36}\/thumbnail$/i;
const REPLAYED_HEADERS = ['ETag', 'Last-Modified', 'Cache-Control'] as const;

type Entry = { etag: string; headers: [string, string][]; expiresAt: number };
const entries = new Map<string, Entry>();
// Bumped by every forget, so a request that signed in before a lock cannot record itself after it.
let generation = 0;

export const forgetThumbnailRevalidations = () => {
  generation++;
  entries.clear();
};

/** Everything the full path reads to decide who is asking and for what; any difference is a miss. */
const keyOf = (req: Request): string => {
  const hash = createHash('sha256');
  for (const [name, value] of Object.entries(req.headers)) {
    if (name === 'cookie' || name === 'authorization' || name.startsWith('x-')) {
      hash.update(`${name}\0${String(value)}\0`);
    }
  }
  return hash.update(`${requestVia(req) ?? ''}\0${req.secure}\0${req.originalUrl}`).digest('base64');
};

export const thumbnailRevalidation =
  (now: () => number = Date.now): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || req.headers.range || !THUMBNAIL_PATH.test(req.path)) {
      return next();
    }

    const key = keyOf(req);
    const entry = entries.get(key);
    if (entry && entry.expiresAt <= now()) {
      entries.delete(key);
    } else if (entry && req.headers['if-none-match'] === entry.etag) {
      for (const [name, value] of entry.headers) {
        res.setHeader(name, value);
      }
      res.status(304).end();
      return;
    }

    const startedIn = generation;
    // Access is checked as the request arrives, so the record runs out that long after then, never later.
    const expiresAt = now() + THUMBNAIL_REVALIDATION_TTL_MS;
    res.once('finish', () => {
      if (startedIn !== generation || expiresAt <= now()) {
        return;
      }
      const etag = res.getHeader('ETag');
      const cacheControl = String(res.getHeader('Cache-Control') ?? '');
      // Only what the full path served or confirmed, and never a decrypted Locked file (`no-store`).
      if (
        (res.statusCode !== 200 && res.statusCode !== 304) ||
        typeof etag !== 'string' ||
        /no-store/.test(cacheControl)
      ) {
        return;
      }
      if (entries.size >= MAX_ENTRIES) {
        entries.delete(entries.keys().next().value!);
      }
      const headers = REPLAYED_HEADERS.map((name) => [name, res.getHeader(name)] as const).filter(
        (pair): pair is [(typeof REPLAYED_HEADERS)[number], string] => typeof pair[1] === 'string',
      );
      entries.set(key, { etag, headers, expiresAt });
    });
    next();
  };
