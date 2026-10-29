import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  allowPageUrl,
  checkServer,
  codeChallenge,
  exchangeCode,
  randomText,
  readReturn,
  removeAccess,
  SignInFailure,
} from './sign-in';
import { checkServerAddress, lastUsed } from './sign-in-words';

const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const problem = async (promise: Promise<unknown>) => {
  const error: unknown = await promise
    .then(() => null)
    .catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(SignInFailure);
  return (error as SignInFailure).problem;
};

describe('signing in with your Frameleaf account (FL-655)', () => {
  it('makes an S256 challenge from a long random verifier', async () => {
    const verifier = randomText(48);
    expect(verifier).toMatch(/^[\w-]{64}$/);
    expect(randomText(48)).not.toBe(verifier);
    expect(await codeChallenge(verifier)).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    );
  });

  it('opens the server’s Allow page with the return address, challenge, state and browser', () => {
    const url = new URL(
      allowPageUrl('https://photos.example', {
        redirectUri: REDIRECT,
        codeChallenge: 'c'.repeat(43),
        state: 's'.repeat(32),
        client: 'edge',
        installationId: 'installation-one-0123',
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://photos.example/auth/allow-extension',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      redirect_uri: REDIRECT,
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      state: 's'.repeat(32),
      client: 'edge',
      installation: 'installation-one-0123',
    });
  });

  it('takes the code only from our own return address and state', () => {
    expect(readReturn(`${REDIRECT}?code=abc&state=s1`, REDIRECT, 's1')).toBe(
      'abc',
    );
    expect(() =>
      readReturn(`${REDIRECT}?code=abc&state=other`, REDIRECT, 's1'),
    ).toThrow(SignInFailure);
    expect(() =>
      readReturn(
        'https://ponmlkjihgfedcbaponmlkjihgfedcba.chromiumapp.org/?code=abc&state=s1',
        REDIRECT,
        's1',
      ),
    ).toThrow(SignInFailure);
    try {
      readReturn(`${REDIRECT}?error=access_denied&state=s1`, REDIRECT, 's1');
    } catch (error) {
      expect((error as SignInFailure).problem).toBe('cancelled');
    }
    try {
      readReturn(undefined, REDIRECT, 's1');
    } catch (error) {
      expect((error as SignInFailure).problem).toBe('cancelled');
    }
  });

  it('tells a wrong address, an unreachable server and an older server apart', async () => {
    await expect(
      problem(
        checkServer(
          'https://photos.example',
          vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })),
        ),
      ),
    ).resolves.toBe('address');
    await expect(
      problem(
        checkServer(
          'https://photos.example',
          vi.fn().mockRejectedValue(new TypeError('offline')),
        ),
      ),
    ).resolves.toBe('unreachable');
    const old = vi
      .fn()
      .mockResolvedValueOnce(json({ res: 'pong' }))
      .mockResolvedValueOnce(json({ message: 'Not Found' }, 404));
    await expect(
      problem(checkServer('https://photos.example', old)),
    ).resolves.toBe('old-server');
    const current = vi
      .fn()
      .mockResolvedValueOnce(json({ res: 'pong' }))
      .mockResolvedValueOnce(json({ version: 1 }));
    await expect(
      checkServer('https://photos.example', current),
    ).resolves.toBeUndefined();
    expect(current.mock.calls.map(([url]) => url)).toEqual([
      'https://photos.example/api/server/ping',
      'https://photos.example/api/browser-extension/sign-in',
    ]);
    expect(current.mock.calls[0][1]).toEqual(
      expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
    );
  });

  it('exchanges the code and says when it took too long', async () => {
    const transport = vi.fn().mockResolvedValue(
      json({
        secret: 'k',
        apiKeyId: 'a',
        userId: 'u',
        serverId: 's',
        name: 'Save to Frameleaf · Chrome',
      }),
    );
    await expect(
      exchangeCode(
        'https://photos.example',
        { code: 'c', codeVerifier: 'v', redirectUri: REDIRECT },
        transport,
      ),
    ).resolves.toEqual({
      secret: 'k',
      apiKeyId: 'a',
      userId: 'u',
      serverId: 's',
    });
    expect(transport).toHaveBeenCalledWith(
      'https://photos.example/api/browser-extension/sign-in/exchange',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          code: 'c',
          codeVerifier: 'v',
          redirectUri: REDIRECT,
        }),
      }),
    );
    await expect(
      problem(
        exchangeCode(
          'https://photos.example',
          { code: 'c', codeVerifier: 'v', redirectUri: REDIRECT },
          vi.fn().mockResolvedValue(json({ code: 'expired' }, 400)),
        ),
      ),
    ).resolves.toBe('expired');
    await expect(
      problem(
        exchangeCode(
          'https://photos.example',
          { code: 'c', codeVerifier: 'v', redirectUri: REDIRECT },
          vi.fn().mockResolvedValue(json({ code: 'invalid' }, 400)),
        ),
      ),
    ).resolves.toBe('failed');
  });

  it('signs out by removing its own access on the server', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      removeAccess('https://photos.example', 'k', transport),
    ).resolves.toBe(true);
    expect(transport).toHaveBeenCalledWith(
      'https://photos.example/api/browser-extension/sign-in',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'x-api-key': 'k' },
      }),
    );
  });
});

describe('the server address (FL-655)', () => {
  it('adds https:// and keeps a path', () => {
    expect(checkServerAddress('photos.example.com', false)).toEqual({
      ok: true,
      origin: 'https://photos.example.com',
      host: 'photos.example.com',
    });
    expect(checkServerAddress('https://nas.example/frameleaf/', false)).toEqual(
      expect.objectContaining({
        ok: true,
        origin: 'https://nas.example/frameleaf',
      }),
    );
  });
  it('refuses plain http, except a server on this computer with the switch on', () => {
    const plain = ['http', '://photos.example.com'].join('');
    const local = ['http', '://localhost:2283'].join('');
    expect(checkServerAddress(plain, true)).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(checkServerAddress(local, false)).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(checkServerAddress(local, true)).toEqual(
      expect.objectContaining({ ok: true, origin: local }),
    );
    expect(checkServerAddress('', false)).toEqual({
      ok: false,
      problem: 'Enter your server’s address.',
    });
    expect(checkServerAddress('photos', false)).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });
  it('says when a server was last used', () => {
    const now = new Date('2026-10-29T12:00:00');
    expect(
      lastUsed(
        { origin: 'x', usedAt: new Date('2026-10-29T08:00:00').getTime() },
        now,
      ),
    ).toBe('Today');
    expect(
      lastUsed(
        { origin: 'x', usedAt: new Date('2026-10-12T08:00:00').getTime() },
        now,
      ),
    ).toBe('Oct 12');
  });
});
