import { createServer, request } from 'node:http';
import { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { CookieOptions, Response } from 'express';
import { AuthCookie } from 'src/enum.js';
import {
  ClientDisconnectedError,
  respondWithCookie,
  respondWithoutCookie,
  waitForDrain,
  writeInformation,
} from 'src/utils/response.js';

const createResponse = () => {
  const events: unknown[][] = [];
  const cookie = vi.fn((key: string, value: string | null, options: CookieOptions) => {
    events.push(['cookie', key, value, { ...options }]);
  });
  const clearCookie = vi.fn((key: string) => {
    events.push(['clearCookie', key]);
  });
  const setHeader = vi.fn((name: string, value: string) => {
    events.push(['header', name, value]);
  });
  return { res: { cookie, clearCookie, setHeader } as unknown as Response, cookie, clearCookie, setHeader, events };
};

describe('respondWithCookie', () => {
  it.each(
    [false, true].flatMap((isSecure) => [undefined, true, false].map((rememberMe) => ({ isSecure, rememberMe }))),
  )('preserves every cookie policy for %j', ({ isSecure, rememberMe }) => {
    const { res, events } = createResponse();
    const body = { signedIn: true };
    const values = Object.values(AuthCookie).map((key) => ({ key, value: null }));
    expect(respondWithCookie(res, body, { isSecure, rememberMe, values })).toBe(body);

    const authenticationAge = rememberMe === false ? undefined : 34_560_000_000;
    const expectedAges = {
      [AuthCookie.AccessToken]: authenticationAge,
      [AuthCookie.AuthType]: authenticationAge,
      [AuthCookie.IsAuthenticated]: authenticationAge,
      [AuthCookie.OAuthState]: 34_560_000_000,
      [AuthCookie.OAuthCodeVerifier]: 34_560_000_000,
      [AuthCookie.MaintenanceToken]: 86_400_000,
      [AuthCookie.SharedLinkToken]: 86_400_000,
    };
    expect(events).toEqual([
      ...values.map(({ key, value }) => [
        'cookie',
        key,
        value,
        {
          path: '/',
          sameSite: 'lax',
          httpOnly: key !== AuthCookie.IsAuthenticated,
          secure: isSecure,
          maxAge: expectedAges[key],
        },
      ]),
      ['header', 'Clear-Site-Data', '"cache"'],
    ]);
  });

  it('leaves the cache alone for an empty response or cookies unrelated to sign-in', () => {
    const { res, setHeader } = createResponse();
    const keys = Object.values(AuthCookie).filter((key) => key !== AuthCookie.AccessToken);
    for (const key of keys) {
      respondWithCookie(res, undefined, { isSecure: false, values: [{ key, value: 'value' }] });
    }
    expect(respondWithCookie(res, undefined, { isSecure: false, values: [] })).toBeUndefined();
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('keeps option mutations inside their existing cookie groups and response', () => {
    const { res, cookie } = createResponse();
    const keys = [AuthCookie.AuthType, AuthCookie.AccessToken, AuthCookie.IsAuthenticated];
    cookie.mockImplementation((_key, _value, options) => {
      options.path = '/changed';
    });
    respondWithCookie(res, undefined, {
      isSecure: true,
      values: keys.map((key) => ({ key, value: 'value' })),
    });
    const options = cookie.mock.calls.map((call) => call[2]);
    expect(options[0]).toBe(options[1]);
    expect(options[2]).not.toBe(options[0]);

    const second = createResponse();
    respondWithCookie(second.res, undefined, {
      isSecure: false,
      values: keys.map((key) => ({ key, value: 'value' })),
    });
    expect(second.cookie.mock.calls.map((call) => call[2].path)).toEqual(['/', '/', '/']);
  });

  it('propagates cookie failures before clearing the cache', () => {
    const { res, cookie, setHeader } = createResponse();
    const error = new Error('cookie failure');
    cookie.mockImplementation(() => {
      throw error;
    });
    expect(() =>
      respondWithCookie(res, undefined, {
        isSecure: false,
        values: [{ key: AuthCookie.AccessToken, value: 'token' }],
      }),
    ).toThrow(error);
    expect(setHeader).not.toHaveBeenCalled();
  });
});

describe('respondWithoutCookie', () => {
  it.each<AuthCookie[]>([
    [],
    [AuthCookie.OAuthState],
    [AuthCookie.AccessToken, AuthCookie.AuthType, AuthCookie.AccessToken],
  ])('clears cookies in order and only clears the cache for an access token: %j', (...cookies) => {
    const { res, events } = createResponse();
    const body = { signedOut: true };
    expect(respondWithoutCookie(res, body, cookies)).toBe(body);
    expect(events).toEqual([
      ...cookies.map((key) => ['clearCookie', key]),
      ...(cookies.includes(AuthCookie.AccessToken) ? [['header', 'Clear-Site-Data', '"cache"']] : []),
    ]);
  });

  it('propagates clearing failures before clearing the cache', () => {
    const { res, clearCookie, setHeader } = createResponse();
    const error = new Error('clear failure');
    clearCookie.mockImplementation(() => {
      throw error;
    });
    expect(() => respondWithoutCookie(res, undefined, [AuthCookie.AccessToken])).toThrow(error);
    expect(setHeader).not.toHaveBeenCalled();
  });
});

describe('waitForDrain', () => {
  it('settles when the writable finishes without close', async () => {
    const stream = new Writable({
      autoDestroy: false,
      emitClose: false,
      write: (_chunk, _encoding, callback) => callback(),
    });
    let failure: unknown;
    const pending = waitForDrain(stream).catch((error: unknown) => {
      failure = error;
    });
    stream.end();
    try {
      await vi.waitFor(() => expect(failure).toBeInstanceOf(ClientDisconnectedError), { timeout: 200 });
      expect(stream.listenerCount('drain')).toBe(0);
      expect(stream.listenerCount('error')).toBe(0);
    } finally {
      stream.emit('close');
      stream.destroy();
      await pending;
    }
  });

  it('rejects a writable that already finished without close', async () => {
    const stream = new Writable({
      autoDestroy: false,
      emitClose: false,
      write: (_chunk, _encoding, callback) => callback(),
    });
    const finished = new Promise<void>((resolve) => stream.once('finish', resolve));
    stream.end();
    await finished;
    await expect(waitForDrain(stream)).rejects.toBeInstanceOf(ClientDisconnectedError);
    stream.destroy();
  });

  it.each(['drain', 'close', 'finish', 'error'] as const)(
    'settles on %s and removes only its own listeners',
    async (event) => {
      const stream = new Writable({ write: (_chunk, _encoding, callback) => callback() });
      const existing = vi.fn();
      for (const name of ['drain', 'close', 'finish', 'error']) {
        stream.on(name, existing);
      }
      const pending = waitForDrain(stream);
      const error = new Error('write failed');
      stream.emit(event, error);
      if (event === 'drain') {
        await expect(pending).resolves.toBeUndefined();
      } else if (event === 'close' || event === 'finish') {
        await expect(pending).rejects.toBeInstanceOf(ClientDisconnectedError);
      } else {
        await expect(pending).rejects.toBe(error);
      }
      for (const name of ['drain', 'close', 'finish', 'error']) {
        expect(stream.listeners(name)).toEqual([existing]);
      }
    },
  );

  it('rejects a stream already destroyed after close without leaving listeners', async () => {
    const stream = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    stream.destroy();
    await new Promise<void>((resolve) => stream.once('close', resolve));
    await expect(waitForDrain(stream)).rejects.toBeInstanceOf(ClientDisconnectedError);
    for (const event of ['drain', 'close', 'finish', 'error']) {
      expect(stream.listenerCount(event)).toBe(0);
    }
  });
});

describe(writeInformation.name, () => {
  it('sends an interim response before the final one, with or without the native method', async () => {
    const server = createServer((_, response) => {
      writeInformation(response, 104, { Location: '/upload/1', 'Upload-Complete': '?0' });
      response.end('done');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const interim: Array<{ statusCode: number; location: unknown }> = [];
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const outgoing = request({ host: '127.0.0.1', port }, (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        });
        outgoing.on('information', ({ statusCode, headers }) => {
          interim.push({ statusCode, location: headers.location });
        });
        outgoing.on('error', reject);
        outgoing.end();
      });
      expect(interim).toEqual([{ statusCode: 104, location: '/upload/1' }]);
      expect(status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('refuses header values that would split the response', () => {
    const response = { _writeRaw: vi.fn() } as never;
    expect(() => writeInformation(response, 104, { Location: '/x\r\nSet-Cookie: a=b' })).toThrow();
    expect((response as { _writeRaw: ReturnType<typeof vi.fn> })._writeRaw).not.toHaveBeenCalled();
  });
});
