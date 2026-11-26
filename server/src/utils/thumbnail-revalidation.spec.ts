import express from 'express';
import { EventEmitter } from 'node:events';
import request_ from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THUMBNAIL_REVALIDATION_TTL_MS,
  forgetThumbnailRevalidations,
  thumbnailRevalidation,
} from 'src/utils/thumbnail-revalidation.js';

const ID = '3fe388e4-2078-44d7-b36c-39d9dee3a657';
const ETAG = 'W/"1a2b-19ab"';
const NO_CACHE = 'private, no-cache, no-transform';

const request = (overrides: Record<string, unknown> = {}) => ({
  method: 'GET',
  path: `/api/assets/${ID}/thumbnail`,
  originalUrl: `/api/assets/${ID}/thumbnail?size=thumbnail&c=abc`,
  secure: false,
  headers: { cookie: 'immich_access_token=one', 'if-none-match': ETAG } as Record<string, string>,
  ...overrides,
});

const response = () => {
  const headers = new Map<string, string>();
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: (name: string, value: string) => void headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    end: vi.fn(),
  });
  return res;
};

describe('thumbnailRevalidation (FL-1787)', () => {
  let now: number;
  let handler: ReturnType<typeof thumbnailRevalidation>;

  /** One request through the middleware; when it reaches the full path, that path answers as given. */
  const run = (req = request(), full: { status?: number; etag?: string; cacheControl?: string } | null = {}) => {
    const res = response();
    const next = vi.fn();
    handler(req as never, res as never, next);
    if (next.mock.calls.length > 0 && full) {
      res.statusCode = full.status ?? 304;
      if (full.etag !== '') {
        res.setHeader('ETag', full.etag ?? ETAG);
      }
      res.setHeader('Cache-Control', full.cacheControl ?? NO_CACHE);
      res.emit('finish');
    }
    return { res, reachedFullPath: next.mock.calls.length > 0 };
  };

  beforeEach(() => {
    forgetThumbnailRevalidations();
    now = 1_000_000;
    handler = thumbnailRevalidation(() => now);
  });

  it('answers a repeated conditional request with a 304 without reaching the full path', () => {
    expect(run().reachedFullPath).toBe(true);

    const { res, reachedFullPath } = run();
    expect(reachedFullPath).toBe(false);
    expect(res.statusCode).toBe(304);
    expect(res.end).toHaveBeenCalledWith();
    expect(res.getHeader('ETag')).toBe(ETAG);
    expect(res.getHeader('Cache-Control')).toBe(NO_CACHE);
  });

  it('goes back to the full path once the entry has run out', () => {
    run();
    now += THUMBNAIL_REVALIDATION_TTL_MS;
    expect(run().reachedFullPath).toBe(true);
  });

  it('stops at once when a session is locked or removed', () => {
    run();
    forgetThumbnailRevalidations();
    expect(run().reachedFullPath).toBe(true);
  });

  it('does not record a request that signed in before a lock and finished after it', () => {
    const res = response();
    handler(request() as never, res as never, vi.fn());
    forgetThumbnailRevalidations();
    res.statusCode = 304;
    res.setHeader('ETag', ETAG);
    res.emit('finish');

    expect(run().reachedFullPath).toBe(true);
  });

  it.each([
    ['another session', request({ headers: { cookie: 'immich_access_token=two', 'if-none-match': ETAG } })],
    ['another API key', request({ headers: { 'x-api-key': 'k', 'if-none-match': ETAG } })],
    ['another shared link', request({ originalUrl: `/api/assets/${ID}/thumbnail?size=thumbnail&c=abc&key=x` })],
    ['another size', request({ originalUrl: `/api/assets/${ID}/thumbnail?size=preview&c=abc` })],
    ['another arrival', request({ frameleafVia: 'relay' })],
    ['a changed file', request({ headers: { cookie: 'immich_access_token=one', 'if-none-match': 'W/"old"' } })],
    ['no validator', request({ headers: { cookie: 'immich_access_token=one' } })],
  ])('sends %s to the full path', (_, req) => {
    run();
    expect(run(req, null).reachedFullPath).toBe(true);
  });

  it.each([
    ['a refusal', { status: 403 }],
    ['a redirect', { status: 302 }],
    ['a response without an ETag', { status: 200, etag: '' }],
    ['a decrypted Locked file', { status: 200, cacheControl: 'private, no-store' }],
  ])('never records %s', (_, full) => {
    run(request(), full);
    expect(run().reachedFullPath).toBe(true);
  });

  it('leaves other routes, methods and range requests alone', () => {
    for (const req of [
      request({ path: `/api/assets/${ID}/original` }),
      request({ method: 'HEAD' }),
      request({ headers: { cookie: 'immich_access_token=one', 'if-none-match': ETAG, range: 'bytes=0-' } }),
    ]) {
      run(req);
      expect(run(req).reachedFullPath).toBe(true);
    }
  });

  it("answers the browser's own revalidation of a sent file without running the route again", async () => {
    const route = vi.fn();
    const app = express();
    app.use(thumbnailRevalidation());
    app.get('/api/assets/:id/thumbnail', (_req, res) => {
      route();
      res.setHeader('Cache-Control', NO_CACHE);
      res.sendFile(import.meta.filename, { dotfiles: 'allow' });
    });
    const url = `/api/assets/${ID}/thumbnail?size=thumbnail`;

    const first = await request_(app).get(url).set('Cookie', 'immich_access_token=one').expect(200);
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();

    const again = await request_(app).get(url).set('Cookie', 'immich_access_token=one').set('If-None-Match', etag);
    expect(again.status).toBe(304);
    expect(again.headers.etag).toBe(etag);
    expect(again.headers['cache-control']).toBe(NO_CACHE);
    expect(route).toHaveBeenCalledTimes(1);

    // someone else with the same validator still goes through sign-in and the access check
    await request_(app).get(url).set('Cookie', 'immich_access_token=two').set('If-None-Match', etag).expect(304);
    expect(route).toHaveBeenCalledTimes(2);
  });
});
