import { redactLogUrl, replacer } from 'src/middleware/logging.interceptor.js';

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

  it('leaves an address without credentials unchanged', () => {
    expect(redactLogUrl('/api/server/ping')).toBe('/api/server/ping');
    expect(redactLogUrl('/api/search?size=10&page=2')).toBe('/api/search?size=10&page=2');
  });

  it('masks secret body fields at any depth', () => {
    const body = {
      token: 'maintenance-jwt',
      password: 'hunter2',
      newPassword: 'hunter3',
      pinCode: '123456',
      credential: { apiKey: 'api-key', clientSecret: 'oauth' },
      name: 'kept',
    };
    expect(JSON.parse(JSON.stringify(body, replacer))).toEqual({
      token: '********',
      password: '********',
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
});
