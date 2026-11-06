import { ExecutionContext } from '@nestjs/common';
import { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { firstValueFrom, of, throwError } from 'rxjs';
import {
  LoggingInterceptor,
  redactLogUrl,
  replacer,
  requestLogMiddleware,
  requestLogPath,
} from 'src/middleware/logging.interceptor.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

describe('logging interceptor redaction (FL-81)', () => {
  it('masks the maintenance sign-in token and shared-link keys in a logged address', () => {
    expect(redactLogUrl('/maintenance?token=eyJhbGciOi&continue=%2Fphotos')).toBe(
      '/maintenance?token=********&continue=%2Fphotos',
    );
    expect(redactLogUrl('/api/assets/1/thumbnail?key=abc&size=preview')).toBe(
      '/api/assets/1/thumbnail?key=********&size=preview',
    );
    expect(redactLogUrl('/api/oauth/mobile-redirect?code=abc&state=xyz')).toBe(
      '/api/oauth/mobile-redirect?code=********&state=********',
    );
  });

  it('masks session keys, access tokens, API and private keys in any case or spelling', () => {
    expect(redactLogUrl('/api/assets/1/thumbnail?sessionKey=abc&size=preview')).toBe(
      '/api/assets/1/thumbnail?sessionKey=********&size=preview',
    );
    expect(redactLogUrl('/api/widget?SESSIONKEY=abc')).toBe('/api/widget?SESSIONKEY=********');
    expect(redactLogUrl('/api/x?session_key=a&access_token=b&api_key=c&privateKey=d&State=e&Code=f&keep=1')).toBe(
      '/api/x?session_key=********&access_token=********&api_key=********&privateKey=********&State=********&Code=********&keep=1',
    );
  });

  it('never records the query string of the /link page or the licence routes (CLD-004)', () => {
    const key = 'FL-SABC-DEFG-HJK7';
    for (const url of [
      `/link?target=activate_license&licenseKey=${key}`,
      `/link?key=${key}`,
      '/link?target=frameleaf_license&linkCode=flc_jf23qnbc4wvmpnuogenclb2hyo',
      `/api/admin/license/activate?key=${key}`,
      `/api/license/link-code?anything=${key}`,
      `/api/users/me/license?x=${key}`,
    ]) {
      const logged = redactLogUrl(url);
      expect(logged).toBe(`${url.slice(0, url.indexOf('?'))}?********`);
      expect(logged).not.toContain(key);
      expect(logged).not.toContain('flc_');
    }
  });

  it('masks licence keys and link codes on any route', () => {
    expect(redactLogUrl('/photos?licenseKey=FL-S&license_key=a&linkCode=flc_x&keep=1')).toBe(
      '/photos?licenseKey=********&license_key=********&linkCode=********&keep=1',
    );
    expect(JSON.parse(JSON.stringify({ licenceKey: 'FL-S', linkCode: 'flc_x', code: 'flc_y' }, replacer))).toEqual({
      licenceKey: '********',
      linkCode: '********',
      code: '********',
    });
  });

  it.each([
    '/LINK',
    '/API/ADMIN/LICENSE/ACTIVATE/',
    '/API/LICENSE/LINK-CODE',
    '/API/USERS/ME/LICENSE/',
    '/admin/license/activate',
    '/license/link-code',
    '/users/me/license',
  ])('excludes the whole query of a credential route regardless of casing or API prefix: %s', (path) => {
    expect(redactLogUrl(`${path}?anything=synthetic-private-material&page=2`)).toBe(`${path}?********`);
  });

  it('keeps ordinary queries on routes whose names only start with a credential route', () => {
    for (const path of ['/links', '/api/licenses', '/admin/license-history', '/users/me/license-history']) {
      expect(redactLogUrl(`${path}?page=2`)).toBe(`${path}?page=2`);
    }
  });

  it('masks a secret that travels in the path: cast tokens, render-worker grants and gallery zip tickets', () => {
    expect(redactLogUrl('/api/cast/eyJhbGciOi.signed')).toBe('/api/cast/********');
    expect(redactLogUrl('/cast/eyJhbGciOi?size=preview')).toBe('/cast/********?size=preview');
    expect(redactLogUrl('/api/render-workers/operations/op-1/inputs/grant-secret')).toBe(
      '/api/render-workers/operations/op-1/inputs/********',
    );
    expect(redactLogUrl('/api/photography/galleries/g-1/zip/zip-ticket?key=abc')).toBe(
      '/api/photography/galleries/g-1/zip/********?key=********',
    );
  });

  it('keeps the rest of the cast, render-worker and gallery routes readable', () => {
    for (const url of [
      '/api/cast',
      '/api/casts/1',
      '/api/render-workers/operations/op-1/inputs',
      '/api/photography/galleries/g-1/zip',
      '/api/photography/galleries/g-1',
    ]) {
      expect(redactLogUrl(url)).toBe(url);
    }
  });

  it('leaves an address without credentials unchanged', () => {
    expect(redactLogUrl('/api/server/ping')).toBe('/api/server/ping');
    expect(redactLogUrl('/api/search?size=10&page=2')).toBe('/api/search?size=10&page=2');
  });

  it('masks secret body fields at any depth', () => {
    const body = {
      token: 'maintenance-jwt',
      password: 'hunter2',
      appleId: 'private@example.com',
      newPassword: 'hunter3',
      pinCode: '123456',
      credential: { apiKey: 'api-key', clientSecret: 'oauth' },
      name: 'kept',
    };
    expect(JSON.parse(JSON.stringify(body, replacer))).toEqual({
      token: '********',
      password: '********',
      appleId: '********',
      newPassword: '********',
      pinCode: '********',
      credential: { apiKey: '********', clientSecret: '********' },
      name: 'kept',
    });
  });

  it('masks the OAuth callback and link bodies, including the query of a url field', () => {
    const body = {
      url: 'app.immich:///oauth-callback?code=secret-code&state=secret-state',
      codeVerifier: 'pkce',
      state: 'xyz',
    };
    expect(JSON.parse(JSON.stringify(body, replacer))).toEqual({
      url: 'app.immich:///oauth-callback?********',
      codeVerifier: '********',
      state: '********',
    });
    expect(replacer('url', 'https://example.com/auth/login#code=a')).toBe('https://example.com/auth/login?********');
    expect(replacer('URL', '/auth/login')).toBe('/auth/login');
  });

  it('masks snake_case and upper-case secret body fields', () => {
    const body = {
      access_token: 'a',
      refresh_token: 'b',
      api_key: 'c',
      privateKey: 'd',
      private_key: 'e',
      sessionKey: 'f',
      code_verifier: 'g',
      PASSWORD: 'h',
      Code: 'i',
      name: 'kept',
    };
    const masked = JSON.parse(JSON.stringify(body, replacer));
    expect(masked).toEqual({
      access_token: '********',
      refresh_token: '********',
      api_key: '********',
      privateKey: '********',
      private_key: '********',
      sessionKey: '********',
      code_verifier: '********',
      PASSWORD: '********',
      Code: '********',
      name: 'kept',
    });
  });

  it('still shortens long arrays', () => {
    const logged = JSON.parse(JSON.stringify({ ids: Array.from({ length: 102 }, (_, index) => index) }, replacer));
    expect(logged.ids).toHaveLength(101);
    expect(logged.ids.at(-1)).toBe('...and 2 more');
  });

  it.each([
    'passphrase',
    'newPassphrase',
    'PASS_PHRASE',
    'pass-phrase',
    'pass.phrase',
    'pass phrase',
    'recoveryKey',
    'RECOVERY_CODE',
    'recovery-kit',
    'keyring',
    'keys',
    'wrappingKey',
    'wrap_key',
    'bucket-key',
    'encryptionKey',
    'masterKey',
    'rootKey',
    'wrapping_secret',
    'PASS_WORD',
  ])('redacts nested backup material named %s in bodies and queries', (name) => {
    const sentinel = 'synthetic-private-material';
    const body = { nested: [{ [name]: { 1: sentinel }, operationId: 'kept' }], fingerprint: 'kept' };
    const logged = JSON.stringify(body, replacer);
    expect(logged).not.toContain(sentinel);
    expect(JSON.parse(logged)).toEqual({ nested: [{ [name]: '********', operationId: 'kept' }], fingerprint: 'kept' });
    const query = redactLogUrl(`/api/test?${encodeURIComponent(name)}=${sentinel}&page=2`);
    expect(query).not.toContain(sentinel);
    expect(new URLSearchParams(query.split('?', 2)[1]).get('page')).toBe('2');
    expect(body.nested[0][name]).toEqual({ 1: sentinel });
  });
});

describe('secret request body exclusion', () => {
  it.each([
    '/api/admin/cloud/backup/check',
    '/api/admin/cloud/backup/setup',
    '/api/admin/cloud/backup/key/unlock',
    '/api/admin/cloud/backup/escrow',
    '/api/admin/buddy-backup/key/escrow',
    '/api/admin/buddy-backup/key/escrow/import',
    '/api/admin/buddy-backup/key/import',
    '/api/admin/buddy-backup/key/verify',
    '/api/admin/config/credentials/smtp-password',
    '/ADMIN/BUDDY-BACKUP/KEY/IMPORT/',
    '/api/assets/uploads/00000000-0000-4000-8000-000000000001/direct',
    '/ASSETS/UPLOADS/00000000-0000-4000-8000-000000000001/DIRECT/',
  ])('excludes arbitrary bodies for %s on success and failure', async (path) => {
    for (const failed of [false, true]) {
      const log = { setContext: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
      const req = {
        method: 'POST',
        ip: '127.0.0.1',
        path,
        url: path,
        body: { arbitrary: ['synthetic-private-material'] },
      } as Request;
      const context = {
        switchToHttp: () => ({
          getRequest: () => req,
          getResponse: () => ({ statusCode: failed ? 400 : 200 }) as Response,
        }),
      } as unknown as ExecutionContext;
      const sut = new LoggingInterceptor(log as unknown as LoggingRepository);
      const result = firstValueFrom(
        sut.intercept(context, { handle: () => (failed ? throwError(() => new Error('refused')) : of('ok')) }),
      );
      if (failed) {
        await expect(result).rejects.toThrow('refused');
      } else {
        await expect(result).resolves.toBe('ok');
      }
      expect(log.verbose).not.toHaveBeenCalled();
      expect(JSON.stringify(log.debug.mock.calls)).not.toContain('synthetic-private-material');
    }
  });
});

describe('request log line', () => {
  const USER_ID = '6f1c9a0e-5b7d-4c3e-9a1f-0e2d3c4b5a69';
  const run = (
    method: string,
    originalUrl: string,
    statusCode: number,
    { enabled = true, finished = true, headers = {} as Record<string, string> } = {},
  ) => {
    const log = { debug: vi.fn(), log: vi.fn(), warn: vi.fn() };
    const req = { method, originalUrl, headers, user: { user: { id: USER_ID } } } as unknown as Request;
    const res = Object.assign(new EventEmitter(), { statusCode, writableFinished: finished }) as unknown as Response;
    const next = vi.fn();
    requestLogMiddleware(log as unknown as LoggingRepository, { enabled })(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    res.emit('close');
    return log;
  };
  const written = (log: ReturnType<typeof run>) =>
    JSON.stringify([log.debug.mock.calls, log.log.mock.calls, log.warn.mock.calls]);

  it('writes method, path, status, duration and user at log level', () => {
    const log = run('GET', '/api/albums', 200);
    expect(log.log).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(String.raw`^GET /api/albums 200 \d+ms user=${USER_ID}$`)),
    );
  });

  it('never writes tokens, keys, passwords, cookies or IDs from the address', () => {
    const secret = 'synthetic-secret-3b9f1c7a2e';
    const log = run(
      'GET',
      `/api/assets/0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a/thumbnail?key=${secret}&password=${secret}&size=preview`,
      401,
      {
        headers: { authorization: `Bearer ${secret}`, cookie: `frameleaf_access_token=${secret}`, 'x-api-key': secret },
      },
    );
    expect(log.log).toHaveBeenCalledWith(
      expect.stringMatching(/^GET \/api\/assets\/:id\/thumbnail\?key=\*{8}&password=\*{8}&size=\*{8} 401 /),
    );
    expect(written(log)).not.toContain(secret);
    expect(written(log)).not.toContain('0f8e7d6c');
  });

  it.each(['/api//cast/', '/api/./cast/', '/api/%63ast/', '/api/%2563ast/'])(
    'never logs a cast token on a failed request to %s',
    (spelling) => {
      const token = 'synthetic-cast-token.signature';
      const log = run('GET', `${spelling}${token}`, 404);
      expect(log.log).toHaveBeenCalledWith(expect.stringContaining('GET /api/cast/******** 404'));
      expect(written(log)).not.toContain(token);
    },
  );

  it('masks the whole path when a segment is encoded more times than it decodes', () => {
    const token = 'synthetic-cast-token.signature';
    expect(requestLogPath('/api/%25252563ast/x.y')).toBe('/api/cast/********');
    const log = run('GET', `/api/%2525252563ast/${token}?size=preview`, 404);
    expect(log.log).toHaveBeenCalledWith(expect.stringMatching(/^GET \/\*{8} 404 /));
    expect(written(log)).not.toContain(token);
  });

  it('masks path secrets and keeps credential routes queryless', () => {
    expect(requestLogPath('/api/cast/eyJhbGciOi.signed-token')).toBe('/api/cast/********');
    expect(requestLogPath('/api/admin/license/activate?key=FL-SABC-DEFG')).toBe('/api/admin/license/activate?********');
    expect(requestLogPath('/api/shared-links/me?slug=holiday-2026&key=Zk3jR8b2Lq9xV7c1Np4tW6')).toBe(
      '/api/shared-links/me?slug=********&key=********',
    );
    expect(requestLogPath('/api/server/about')).toBe('/api/server/about');
    expect(requestLogPath('/api/%63ast/eyJhbGciOi.mac')).toBe('/api/cast/********');
    expect(requestLogPath('/API/%43AST/x.y?size=preview')).toBe('/API/CAST/********?size=********');
    expect(requestLogPath('/api/%6Cicense/activate?key=FL-S')).toBe('/api/license/activate?********');
    expect(requestLogPath('/api/albums/a%2Fb%3Fc')).toBe('/api/albums/a%2Fb%3Fc');
    expect(requestLogPath('/api/albums/%E0%A4%A')).toBe('/api/albums/%E0%A4%A');
    for (const spelling of ['/api//cast/', '/api/./cast/', '/api/%2563ast/', '/api/x/../cast/', '//api/%252563ast/']) {
      expect(requestLogPath(`${spelling}eyJhbGciOi.mac`)).toBe('/api/cast/********');
    }
  });

  it('moves request lines to debug when FRAMELEAF_LOG_REQUESTS=false, but still warns on server errors', () => {
    const quiet = run('GET', '/api/albums', 200, { enabled: false });
    expect(quiet.log).not.toHaveBeenCalled();
    expect(quiet.debug).toHaveBeenCalledWith(expect.stringContaining('GET /api/albums 200'));
    expect(run('GET', '/api/albums', 500, { enabled: false }).warn).toHaveBeenCalledOnce();
  });

  it('keeps health-check polls and timeline thumbnails out of the log unless they fail', () => {
    expect(run('GET', '/api/server/ping', 200).log).not.toHaveBeenCalled();
    expect(run('GET', '/api/server/version', 200).log).not.toHaveBeenCalled();
    expect(run('GET', `/api/assets/${USER_ID}/thumbnail?size=thumbnail`, 200).log).not.toHaveBeenCalled();
    expect(run('GET', '/api/server/ping', 503).warn).toHaveBeenCalledOnce();
    expect(run('GET', `/api/assets/${USER_ID}/thumbnail`, 404).log).toHaveBeenCalledOnce();
  });

  it('ignores web pages and static files, and records aborted requests', () => {
    expect(written(run('GET', '/_app/immutable/app.js', 200))).toBe('[[],[],[]]');
    expect(run('POST', '/api/assets', 200, { finished: false }).log).toHaveBeenCalledWith(
      expect.stringContaining('POST /api/assets aborted'),
    );
  });
});
