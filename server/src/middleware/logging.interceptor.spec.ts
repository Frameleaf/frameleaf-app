import { ExecutionContext } from '@nestjs/common';
import { Request, Response } from 'express';
import { firstValueFrom, of, throwError } from 'rxjs';
import { LoggingInterceptor, redactLogUrl, replacer } from 'src/middleware/logging.interceptor.js';
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
      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining(path));
      expect(JSON.stringify(log.debug.mock.calls)).not.toContain('synthetic-private-material');
    }
  });
});
