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
      credential: { apiKey: 'runpod', clientSecret: 'oauth' },
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

  it('still shortens long arrays', () => {
    const logged = JSON.parse(JSON.stringify({ ids: Array.from({ length: 102 }, (_, index) => index) }, replacer));
    expect(logged.ids).toHaveLength(101);
    expect(logged.ids.at(-1)).toBe('...and 2 more');
  });
});
