import type { Request, Response } from 'express';
import {
  type FrameleafRequest,
  frameleafViaMiddleware,
  readFrameleafArrival,
  requestVia,
  stripFrameleafHeaders,
} from 'src/middleware/frameleaf-via.middleware.js';

const secret = 'edge-secret-0123456789abcdef';

const run = (headers: Record<string, string | string[]>, edgeSecret: string | null = secret) => {
  const request = { headers: { ...headers } } as unknown as Request;
  const next = vi.fn();
  frameleafViaMiddleware(edgeSecret)(request, {} as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  return request as FrameleafRequest;
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

  it('fails closed: a wrong, missing or partial secret leaves the request unmarked', () => {
    expect(run({ 'x-frameleaf-via': 'lan', 'x-frameleaf-via-auth': 'not-the-secret' }).frameleafVia).toBeNull();
    expect(run({ 'x-frameleaf-via': 'lan', 'x-frameleaf-via-auth': secret.slice(0, -1) }).frameleafVia).toBeNull();
    expect(run({ 'x-frameleaf-via': 'relay' }).frameleafVia).toBeNull();
    expect(run({ 'x-frameleaf-via-auth': secret }).frameleafVia).toBeNull();
    expect(
      run({ 'x-frameleaf-via': 'relay', 'x-frameleaf-via-auth': secret, 'x-forwarded-for': '203.0.113.9' }, null)
        .frameleafVia,
    ).toBeNull();
  });

  it('refuses a via value outside lan, wan and relay', () => {
    const request = run({ 'x-frameleaf-via': 'home', 'x-frameleaf-via-auth': secret, 'x-forwarded-for': '1.2.3.4' });
    expect(request.frameleafVia).toBeNull();
    expect(request.frameleafForwarded).toBeNull();
  });

  it('never trusts forwarded values without the secret', () => {
    const request = run({ 'x-frameleaf-via': 'lan', 'x-forwarded-for': '192.168.1.2' });
    expect(request.frameleafForwarded).toBeNull();
    // the ordinary proxy headers themselves are left for Express and the trusted proxy setting
    expect(request.headers['x-forwarded-for']).toBe('192.168.1.2');
  });

  it('drops every client-supplied X-Frameleaf-* header, vouched for or not', () => {
    const vouched = run({ 'x-frameleaf-via': 'relay', 'x-frameleaf-via-auth': secret, 'x-frameleaf-anything': '1' });
    const spoofed = run({ 'x-frameleaf-via': 'lan', 'x-frameleaf-via-auth': 'guess', 'x-frameleaf-client-ip': '1' });

    for (const request of [vouched, spoofed]) {
      expect(Object.keys(request.headers).filter((name) => name.startsWith('x-frameleaf-'))).toEqual([]);
    }
  });

  it('keeps the render worker session, a credential this server issued', () => {
    const request = run({ 'x-frameleaf-worker-session': 'session-token', 'x-frameleaf-via': 'lan' });
    expect(request.headers['x-frameleaf-worker-session']).toBe('session-token');
    expect(request.headers['x-frameleaf-via']).toBeUndefined();
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
