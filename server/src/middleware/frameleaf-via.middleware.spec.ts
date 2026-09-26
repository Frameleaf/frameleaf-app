import type { Request, Response } from 'express';
import {
  FRAMELEAF_VIA_UNVERIFIED,
  type FrameleafRequest,
  frameleafViaMiddleware,
  readFrameleafArrival,
  requestVia,
  stripFrameleafHeaders,
} from 'src/middleware/frameleaf-via.middleware.js';

const secret = 'edge-secret-0123456789abcdef';

const call = (headers: Record<string, string | string[]>, edgeSecret: string | null = secret) => {
  const request = { headers: { ...headers } } as unknown as Request;
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const next = vi.fn();
  frameleafViaMiddleware(edgeSecret)(request, response as unknown as Response, next);
  return { request: request as FrameleafRequest, response, next };
};

/** A request the middleware let through. */
const run = (headers: Record<string, string | string[]>, edgeSecret: string | null = secret) => {
  const { request, response, next } = call(headers, edgeSecret);
  expect(response.status).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledTimes(1);
  return request;
};

/** A request the middleware refused. */
const refused = (headers: Record<string, string | string[]>, edgeSecret: string | null = secret) => {
  const { response, next } = call(headers, edgeSecret);
  expect(next).not.toHaveBeenCalled();
  expect(response.status).toHaveBeenCalledWith(403);
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: FRAMELEAF_VIA_UNVERIFIED }));
};

describe('frameleafViaMiddleware (FL-161)', () => {
  it('marks a request the edge worker vouched for, with its forwarded values', () => {
    const request = run({
      'x-frameleaf-via': 'relay',
      'x-frameleaf-via-auth': secret,
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'r.label.frameleaf-direct.net',
    });

    expect(request.frameleafVia).toBe('relay');
    expect(requestVia(request)).toBe('relay');
    expect(request.frameleafForwarded).toEqual({
      for: '203.0.113.9',
      proto: 'https',
      host: 'r.label.frameleaf-direct.net',
    });
  });

  it.each(['lan', 'wan', 'relay'] as const)('accepts via %s', (via) => {
    expect(run({ 'x-frameleaf-via': via, 'x-frameleaf-via-auth': secret }).frameleafVia).toBe(via);
  });

  it('takes the hop the edge worker added, not an address the visitor put first', () => {
    const request = run({
      'x-frameleaf-via': 'wan',
      'x-frameleaf-via-auth': secret,
      'x-forwarded-for': '10.0.0.5, 198.51.100.20',
    });

    expect(request.frameleafForwarded?.for).toBe('198.51.100.20');
  });

  it('leaves a request that claims nothing unmarked', () => {
    const request = run({ 'x-forwarded-for': '192.168.1.2' });
    expect(request.frameleafVia).toBeNull();
    expect(request.frameleafForwarded).toBeNull();
    // the ordinary proxy headers themselves are left for Express and the trusted proxy setting
    expect(request.headers['x-forwarded-for']).toBe('192.168.1.2');
  });

  it('refuses a claimed arrival without the right secret, never treating it as home', () => {
    refused({ 'x-frameleaf-via': 'lan', 'x-frameleaf-via-auth': 'not-the-secret' });
    refused({ 'x-frameleaf-via': 'lan', 'x-frameleaf-via-auth': secret.slice(0, -1) });
    refused({ 'x-frameleaf-via': 'relay' });
    refused({ 'x-frameleaf-via-auth': secret });
    refused({ 'x-frameleaf-via': 'relay', 'x-frameleaf-via-auth': secret }, null);
  });

  it('refuses a via value outside lan, wan and relay, even with the secret', () => {
    refused({ 'x-frameleaf-via': 'home', 'x-frameleaf-via-auth': secret, 'x-forwarded-for': '1.2.3.4' });
  });

  it('drops every other client-supplied X-Frameleaf-* header', () => {
    const vouched = run({ 'x-frameleaf-via': 'relay', 'x-frameleaf-via-auth': secret, 'x-frameleaf-anything': '1' });
    const plain = run({ 'x-frameleaf-client-ip': '1' });

    for (const request of [vouched, plain]) {
      expect(Object.keys(request.headers).filter((name) => name.startsWith('x-frameleaf-'))).toEqual([]);
    }
  });

  it('keeps the render worker session, a credential this server issued', () => {
    const request = run({ 'x-frameleaf-worker-session': 'session-token' });
    expect(request.headers['x-frameleaf-worker-session']).toBe('session-token');
  });

  it('reads the arrival before the headers are stripped', () => {
    const headers = { 'x-frameleaf-via': 'wan', 'x-frameleaf-via-auth': secret };
    expect(readFrameleafArrival(headers, secret).via).toBe('wan');
    stripFrameleafHeaders(headers);
    expect(readFrameleafArrival(headers, secret).via).toBeNull();
  });

  it('reports an unmarked request as not vouched for', () => {
    expect(requestVia({ headers: {} } as Request)).toBeNull();
  });
});
