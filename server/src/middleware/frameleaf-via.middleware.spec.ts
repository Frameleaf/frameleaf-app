import express, { type Request, type Response } from 'express';
import {
  FRAMELEAF_VIA_UNVERIFIED,
  type FrameleafRequest,
  expressTrustProxy,
  frameleafViaMiddleware,
  readFrameleafArrival,
  requestHasTrustedTls,
  requestSecurityAddress,
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
      'x-forwarded-host': 'r.label.frameleaf.net',
    });

    expect(request.frameleafVia).toBe('relay');
    expect(requestVia(request)).toBe('relay');
    expect(request.frameleafForwarded).toEqual({
      for: '203.0.113.9',
      proto: 'https',
      host: 'r.label.frameleaf.net',
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
    expect(requestSecurityAddress(request)).toBe('198.51.100.20');
  });

  describe('security address behind a reverse proxy (FL-850)', () => {
    /** A request whose `ip` is computed by real Express with the server's `trust proxy` setting. */
    const viaExpress = (trustedProxies: string[], peer: string, forwardedFor?: string) => {
      const app = express();
      app.set('trust proxy', expressTrustProxy(trustedProxies));
      const socket = { remoteAddress: peer };
      const request = Object.create(app.request) as FrameleafRequest;
      Object.assign(request, {
        headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
        socket,
        connection: socket,
      });
      frameleafViaMiddleware(secret)(request, {} as Response, vi.fn());
      return requestSecurityAddress(request);
    };
    const defaults = ['linklocal', 'uniquelocal'];

    it.each([
      { proxy: 'loopback', peer: '127.0.0.1' },
      { proxy: 'private-range', peer: '172.18.0.2' },
      { proxy: 'IPv6 unique-local', peer: 'fd00::2' },
    ])('gives each visitor their own address behind an unconfigured $proxy proxy', ({ peer }) => {
      expect(viaExpress(defaults, peer, '203.0.113.7')).toBe('203.0.113.7');
      expect(viaExpress(defaults, peer, '203.0.113.8')).toBe('203.0.113.8');
    });

    it('never trusts X-Forwarded-For from a public peer', () => {
      expect(viaExpress(defaults, '198.51.100.9', '203.0.113.7')).toBe('198.51.100.9');
      expect(viaExpress(['198.51.100.0/24'], '203.0.113.50', '192.168.1.2')).toBe('203.0.113.50');
    });

    it('takes the first untrusted hop, not an address the visitor put first', () => {
      expect(viaExpress(defaults, '172.18.0.2', '192.0.2.1, 203.0.113.7')).toBe('203.0.113.7');
    });

    it('trusts only FRAMELEAF_TRUSTED_PROXIES (plus loopback) when it is set', () => {
      expect(viaExpress(['100.64.0.0/10'], '100.100.1.1', '203.0.113.7')).toBe('203.0.113.7');
      expect(viaExpress(['100.64.0.0/10'], '172.18.0.2', '203.0.113.7')).toBe('172.18.0.2');
      expect(viaExpress(['100.64.0.0/10'], '127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    });

    it('uses the socket address when nothing forwards one', () => {
      expect(viaExpress(defaults, '192.168.1.20')).toBe('192.168.1.20');
    });
  });

  it('recognizes forwarded TLS only from an explicitly trusted proxy', () => {
    const app = express();
    app.set('trust proxy', expressTrustProxy(['linklocal', 'uniquelocal']));
    const socket = { remoteAddress: '172.18.0.2' };
    const request = Object.create(app.request) as FrameleafRequest;
    Object.assign(request, {
      headers: { 'x-forwarded-proto': 'https' },
      socket,
      connection: socket,
    });
    const response = {} as Response;
    const next = vi.fn();
    expect(request.secure).toBe(true);
    frameleafViaMiddleware(secret)(request, response, next);
    expect(requestHasTrustedTls(request)).toBe(false);
    frameleafViaMiddleware(secret, ['172.18.0.2'])(request, response, next);
    expect(requestHasTrustedTls(request)).toBe(true);
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

  it('keeps the Manager credential on a loopback request, which Manager sends from inside the container', () => {
    const request = run({ 'x-frameleaf-manager': 'manager-token' });
    expect(request.headers['x-frameleaf-manager']).toBe('manager-token');
  });

  it('drops the Manager credential from a request that came through remote access', () => {
    const request = run({ 'x-frameleaf-via': 'wan', 'x-frameleaf-via-auth': secret, 'x-frameleaf-manager': 'guess' });
    expect(request.headers['x-frameleaf-manager']).toBeUndefined();
  });

  it('retains the Desktop copy token only on requests that did not arrive through the edge', () => {
    const token = 'x-frameleaf-desktop-copy';
    const local = run({ [token]: 'copy-token' });
    expect(local.headers[token]).toBe('copy-token');

    for (const via of ['lan', 'wan', 'relay']) {
      const remote = run({ 'x-frameleaf-via': via, 'x-frameleaf-via-auth': secret, [token]: 'copy-token' });
      expect(remote.headers[token]).toBeUndefined();
    }
  });

  it('reads the arrival before the headers are stripped', () => {
    const headers = { 'x-frameleaf-via': 'wan', 'x-frameleaf-via-auth': secret };
    expect(readFrameleafArrival(headers, secret).via).toBe('wan');
    stripFrameleafHeaders(headers, false);
    expect(readFrameleafArrival(headers, secret).via).toBeNull();
  });

  it('reports an unmarked request as not vouched for', () => {
    expect(requestVia({ headers: {} } as Request)).toBeNull();
  });
});

it('preserves the desktop request proof without trusting arrival or other client claims', () => {
  const headers = {
    'x-frameleaf-desktop-proof': 'installation-signature',
    'x-frameleaf-admin': 'forged',
    'x-frameleaf-worker-session': 'render-credential',
  };
  stripFrameleafHeaders(headers, false);
  expect(headers).toEqual({
    'x-frameleaf-desktop-proof': 'installation-signature',
    'x-frameleaf-worker-session': 'render-credential',
  });
});
