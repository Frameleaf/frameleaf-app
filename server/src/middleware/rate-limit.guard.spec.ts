import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { ImmichEnvironment } from 'src/enum.js';
import {
  RATE_LIMITS,
  REMOTE_ACCESS_CEILING,
  REMOTE_MEDIA_CEILING,
  RateLimitFailureInterceptor,
  RateLimitGuard,
  RateLimited,
  type RateLimitedRequest,
  RemoteMediaCeiling,
  rateLimitAddress,
  rateLimitChecks,
} from 'src/middleware/rate-limit.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { envData, mockEnvData, newConfigRepositoryMock } from 'test/repositories/config.repository.mock.js';
import { newCryptoRepositoryMock } from 'test/repositories/crypto.repository.mock.js';

class TestController {
  @RateLimited(RATE_LIMITS.login)
  login() {}

  @RateLimited(RATE_LIMITS.sharedLinkLogin)
  sharedLinkLogin() {}

  @RateLimited(RATE_LIMITS.linkStart)
  linkStart() {}

  @RemoteMediaCeiling()
  thumbnail() {}

  unlimited() {}
}

const IDENTITY_DIR = '/data/frameleaf/identity';

// the crypto mock's keyed hash: `${purpose}:${value} (keyed)`
const keyed = (principal: string) => `rate-limit:${principal} (keyed)`;

const makeRequest = (overrides: Partial<RateLimitedRequest> = {}) =>
  ({
    ip: '198.51.100.7',
    headers: {},
    query: {},
    cookies: {},
    body: {},
    frameleafVia: null,
    frameleafForwarded: null,
    ...overrides,
  }) as RateLimitedRequest;

const contextFor = (
  handler: () => void,
  request: RateLimitedRequest,
  response?: { setHeader: (...args: unknown[]) => unknown },
) => {
  const headers = response ?? { setHeader: vi.fn() };
  return {
    getType: () => 'http',
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => headers }),
  } as unknown as ExecutionContext;
};

/** Redis's fixed-window counters, in memory: `INCR` and `DECR` are atomic, as they are in Redis. */
const memoryCounters = () => {
  const counters = new Map<string, number>();
  return {
    counters,
    hit: vi.fn((key: string, windowSeconds: number) => {
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return Promise.resolve({ count, resetSeconds: windowSeconds });
    }),
    release: vi.fn((key: string) => {
      const count = (counters.get(key) ?? 0) - 1;
      if (count <= 0) {
        counters.delete(key);
      } else {
        counters.set(key, count);
      }
      return Promise.resolve();
    }),
  };
};

describe(RateLimitGuard.name, () => {
  let sut: RateLimitGuard;
  let interceptor: RateLimitFailureInterceptor;
  let store: ReturnType<typeof memoryCounters>;
  let configRepository: ReturnType<typeof newConfigRepositoryMock>;
  let cryptoRepository: ReturnType<typeof newCryptoRepositoryMock>;
  const logger = { setContext: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const create = () =>
    new RateLimitGuard(
      logger as unknown as LoggingRepository,
      new Reflector(),
      store as unknown as RateLimitRepository,
      configRepository as never,
      cryptoRepository as never,
    );

  /** One login through the guard and the failure interceptor, as the API runs it. */
  const signIn = async (request: RateLimitedRequest, correct: boolean) => {
    await sut.canActivate(contextFor(TestController.prototype.login, request));
    const handler = {
      handle: () => (correct ? of({ accessToken: 't' }) : throwError(() => new UnauthorizedException())),
    } as CallHandler;
    return lastValueFrom(interceptor.intercept(contextFor(TestController.prototype.login, request), handler));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    store = memoryCounters();
    configRepository = newConfigRepositoryMock();
    // The principal keys are HMACs under the key in the identity directory. Without one configured the
    // directory falls back to the media location, which a unit test never sets, so resolving it throws
    // and the guard treats that like unavailable counters (home requests pass uncounted).
    configRepository.getEnv.mockReturnValue(
      mockEnvData({ frameleafCloud: { ...envData.frameleafCloud, identityDir: IDENTITY_DIR } }),
    );
    cryptoRepository = newCryptoRepositoryMock();
    sut = create();
    interceptor = new RateLimitFailureInterceptor(
      logger as unknown as LoggingRepository,
      store as unknown as RateLimitRepository,
    );
  });

  it('counts login per address and the attempt per email and address, as a keyed hash', async () => {
    const request = makeRequest({ body: { email: ' Person@Example.com ', password: 'x' } });

    await expect(sut.canActivate(contextFor(TestController.prototype.login, request))).resolves.toBe(true);

    const principalKey = `frameleaf:rate-limit:login:principal:${keyed('email:person@example.com\u{0}198.51.100.7')}`;
    expect(cryptoRepository.serverKeyedHash).toHaveBeenCalledWith(
      IDENTITY_DIR,
      'rate-limit',
      'email:person@example.com\u{0}198.51.100.7',
    );
    expect(store.hit).toHaveBeenNthCalledWith(1, 'frameleaf:rate-limit:login:ip:198.51.100.7', 600);
    expect(store.hit).toHaveBeenNthCalledWith(2, principalKey, 600);
    expect(request.frameleafRateLimitFailures).toEqual([
      { key: principalKey, limit: RATE_LIMITS.login.principalLimit, windowSeconds: 600, counts: 'failures' },
    ]);
  });

  it('answers 429 with Retry-After once the address goes over its limit', async () => {
    store.hit.mockResolvedValueOnce({ count: RATE_LIMITS.login.limit + 1, resetSeconds: 321 });
    const response = { setHeader: vi.fn() };

    const result = sut.canActivate(contextFor(TestController.prototype.login, makeRequest(), response));

    await expect(result).rejects.toBeInstanceOf(HttpException);
    await expect(result).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    await expect(result).rejects.toMatchObject({ response: { code: 'rate_limited', retryAfter: 321 } });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '321');
  });

  it('stops the wrong passwords for one email from one address, and never counts correct ones', async () => {
    const request = () => makeRequest({ ip: '203.0.113.50', body: { email: 'person@example.com' } });

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(signIn(request(), true)).resolves.toEqual({ accessToken: 't' });
    }
    for (let attempt = 0; attempt < RATE_LIMITS.login.principalLimit; attempt++) {
      await expect(signIn(request(), false)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(signIn(request(), true)).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  });

  it('never lets a stranger lock someone out of a home sign-in', async () => {
    const stranger = () => makeRequest({ ip: '203.0.113.50', body: { email: 'person@example.com' } });
    for (let attempt = 0; attempt < RATE_LIMITS.login.principalLimit + 5; attempt++) {
      await signIn(stranger(), false).catch(() => null);
    }
    await expect(signIn(stranger(), true)).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });

    const home = makeRequest({ ip: '192.168.1.20', body: { email: 'person@example.com' } });
    await expect(signIn(home, true)).resolves.toEqual({ accessToken: 't' });
  });

  it('refuses parallel wrong passwords beyond the limit before any of them is checked', async () => {
    const attempts = RATE_LIMITS.login.principalLimit + 5;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        sut.canActivate(
          contextFor(
            TestController.prototype.login,
            makeRequest({ ip: '203.0.113.50', body: { email: 'person@example.com' } }),
          ),
        ),
      ),
    );

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(RATE_LIMITS.login.principalLimit);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(5);
  });

  it('counts a shared link by its key and address and an admin action by the credential presented', async () => {
    const shared = makeRequest({ query: { key: 'share-key' } });
    await sut.canActivate(contextFor(TestController.prototype.sharedLinkLogin, shared));
    expect(store.hit).toHaveBeenLastCalledWith(
      `frameleaf:rate-limit:shared-link-login:principal:${keyed('key:share-key\u{0}198.51.100.7')}`,
      RATE_LIMITS.sharedLinkLogin.windowSeconds,
    );
    expect(shared.frameleafRateLimitFailures).toHaveLength(1);

    await sut.canActivate(
      contextFor(TestController.prototype.linkStart, makeRequest({ headers: { authorization: 'Bearer token-1' } })),
    );
    expect(store.hit).toHaveBeenLastCalledWith(
      `frameleaf:rate-limit:link-start:principal:${keyed('credential:token-1')}`,
      RATE_LIMITS.linkStart.windowSeconds,
    );
  });

  it('counts only the address when the request names no principal', async () => {
    await sut.canActivate(contextFor(TestController.prototype.linkStart, makeRequest()));

    expect(store.hit).toHaveBeenCalledTimes(1);
    expect(store.hit).toHaveBeenCalledWith('frameleaf:rate-limit:link-start:ip:198.51.100.7', 3600);
  });

  it('leaves an unmarked route from the home network alone', async () => {
    await expect(sut.canActivate(contextFor(TestController.prototype.unlimited, makeRequest()))).resolves.toBe(true);
    expect(store.hit).not.toHaveBeenCalled();
  });

  it.each(['relay', 'wan'] as const)('applies the remote-access ceiling to every %s request', async (via) => {
    const request = makeRequest({
      frameleafVia: via,
      frameleafForwarded: { for: '203.0.113.9', proto: 'https', host: null },
    });

    await expect(sut.canActivate(contextFor(TestController.prototype.unlimited, request))).resolves.toBe(true);
    expect(store.hit).toHaveBeenCalledWith(
      'frameleaf:rate-limit:remote-access:ip:203.0.113.9',
      REMOTE_ACCESS_CEILING.windowSeconds,
    );

    store.hit.mockResolvedValueOnce({ count: REMOTE_ACCESS_CEILING.limit + 1, resetSeconds: 12 });
    await expect(sut.canActivate(contextFor(TestController.prototype.unlimited, request))).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it('counts thumbnails and previews against the higher media ceiling, not the general one', async () => {
    const request = makeRequest({
      frameleafVia: 'relay',
      frameleafForwarded: { for: '203.0.113.9', proto: null, host: null },
    });

    await expect(sut.canActivate(contextFor(TestController.prototype.thumbnail, request))).resolves.toBe(true);
    expect(store.hit).toHaveBeenCalledOnce();
    expect(store.hit).toHaveBeenCalledWith('frameleaf:rate-limit:remote-media:ip:203.0.113.9', 60);
    expect(REMOTE_MEDIA_CEILING.limit).toBeGreaterThan(REMOTE_ACCESS_CEILING.limit);

    store.hit.mockResolvedValueOnce({ count: REMOTE_MEDIA_CEILING.limit + 1, resetSeconds: 5 });
    await expect(sut.canActivate(contextFor(TestController.prototype.thumbnail, request))).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it('does not apply the ceiling at home', async () => {
    await sut.canActivate(contextFor(TestController.prototype.unlimited, makeRequest({ frameleafVia: 'lan' })));
    await sut.canActivate(contextFor(TestController.prototype.thumbnail, makeRequest({ frameleafVia: 'lan' })));
    expect(store.hit).not.toHaveBeenCalled();
  });

  it('refuses a remote request with Retry-After when the counters are unavailable, and lets a home request through', async () => {
    store.hit.mockRejectedValue(new Error('Connection is closed.'));
    const response = { setHeader: vi.fn() };

    await expect(
      sut.canActivate(contextFor(TestController.prototype.login, makeRequest({ frameleafVia: 'relay' }), response)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    await expect(sut.canActivate(contextFor(TestController.prototype.login, makeRequest()))).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('treats a server key that cannot be read like unavailable counters', async () => {
    cryptoRepository.serverKeyedHash.mockRejectedValue(new Error('EACCES'));
    const request = makeRequest({ frameleafVia: 'relay', body: { email: 'person@example.com' } });

    await expect(sut.canActivate(contextFor(TestController.prototype.login, request))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('counts a home request as not testing: the unit tests run with IMMICH_ENV unset', () => {
    expect(configRepository.getEnv().environment).not.toBe(ImmichEnvironment.Testing);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('IMMICH_ENV=testing'));
  });

  it('skips the route limits, but not the ceiling, when IMMICH_ENV is testing, and says so at start', async () => {
    configRepository.getEnv.mockReturnValue(
      mockEnvData({
        environment: ImmichEnvironment.Testing,
        frameleafCloud: { ...envData.frameleafCloud, identityDir: IDENTITY_DIR },
      }),
    );
    sut = create();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('IMMICH_ENV=testing'));

    await sut.canActivate(contextFor(TestController.prototype.login, makeRequest()));
    expect(store.hit).not.toHaveBeenCalled();

    await sut.canActivate(contextFor(TestController.prototype.login, makeRequest({ frameleafVia: 'relay' })));
    expect(store.hit).toHaveBeenCalledTimes(1);
    expect(store.hit).toHaveBeenCalledWith(
      expect.stringContaining(':remote-access:'),
      REMOTE_ACCESS_CEILING.windowSeconds,
    );
  });

  it('ignores anything but HTTP', async () => {
    const context = { getType: () => 'ws' } as unknown as ExecutionContext;
    await expect(sut.canActivate(context)).resolves.toBe(true);
    expect(store.hit).not.toHaveBeenCalled();
  });
});

describe(RateLimitFailureInterceptor.name, () => {
  const release = vi.fn();
  const logger = { setContext: vi.fn(), warn: vi.fn() };
  const sut = new RateLimitFailureInterceptor(
    logger as unknown as LoggingRepository,
    { release } as unknown as RateLimitRepository,
  );
  const failures = [
    { key: 'frameleaf:rate-limit:login:principal:x', limit: 10, windowSeconds: 600, counts: 'failures' as const },
  ];
  const contextWith = (request: Partial<RateLimitedRequest>) =>
    ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;
  const handler = (result: () => ReturnType<CallHandler['handle']>) => ({ handle: result }) as CallHandler;

  beforeEach(() => {
    release.mockReset();
    release.mockResolvedValue(undefined);
  });

  it('keeps a wrong password (401) counted and passes the error on', async () => {
    const error = new UnauthorizedException('Incorrect email or password');
    await expect(
      lastValueFrom(
        sut.intercept(
          contextWith({ frameleafRateLimitFailures: failures }),
          handler(() => throwError(() => error)),
        ),
      ),
    ).rejects.toBe(error);
    expect(release).not.toHaveBeenCalled();
  });

  it('gives back a successful sign-in and any other error', async () => {
    await expect(
      lastValueFrom(
        sut.intercept(
          contextWith({ frameleafRateLimitFailures: failures }),
          handler(() => of('ok')),
        ),
      ),
    ).resolves.toBe('ok');
    await expect(
      lastValueFrom(
        sut.intercept(
          contextWith({ frameleafRateLimitFailures: failures }),
          handler(() => throwError(() => new HttpException('Bad request', 400))),
        ),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith('frameleaf:rate-limit:login:principal:x');
  });

  it('leaves requests without failure-counted checks alone', async () => {
    const error = new UnauthorizedException();
    await expect(
      lastValueFrom(
        sut.intercept(
          contextWith({}),
          handler(() => throwError(() => error)),
        ),
      ),
    ).rejects.toBe(error);
    expect(release).not.toHaveBeenCalled();
  });

  it('still answers when the attempt cannot be given back', async () => {
    release.mockRejectedValue(new Error('Connection is closed.'));
    await expect(
      lastValueFrom(
        sut.intercept(
          contextWith({ frameleafRateLimitFailures: failures }),
          handler(() => of('ok')),
        ),
      ),
    ).resolves.toBe('ok');
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe(rateLimitAddress.name, () => {
  it.each([
    ['198.51.100.7', '198.51.100.7'],
    ['::ffff:198.51.100.7', '198.51.100.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:0db8:0001:0002::/64'],
    ['2001:db8:1:2::9', '2001:0db8:0001:0002::/64'],
    ['2001:DB8:1:2:ffff::1', '2001:0db8:0001:0002::/64'],
    ['::1', '0000:0000:0000:0000::/64'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    ['not-an-address', 'unknown'],
  ])('counts %s as %s', (address, expected) => {
    expect(rateLimitAddress(address)).toBe(expected);
  });
});

describe(rateLimitChecks.name, () => {
  it('prefers the address the edge worker reported', async () => {
    const request = makeRequest({
      ip: '127.0.0.1',
      frameleafVia: 'relay',
      frameleafForwarded: { for: '203.0.113.9', proto: 'https', host: null },
    });

    const checks = await rateLimitChecks(request, RATE_LIMITS.linkStart, {
      media: false,
      keyOf: (principal) => Promise.resolve(principal),
    });
    expect(checks.map(({ key }) => key)).toEqual([
      'frameleaf:rate-limit:remote-access:ip:203.0.113.9',
      'frameleaf:rate-limit:link-start:ip:203.0.113.9',
    ]);
  });
});
