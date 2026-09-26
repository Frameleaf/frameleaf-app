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
  RateLimitFailureInterceptor,
  RateLimitGuard,
  RateLimited,
  type RateLimitedRequest,
  RemoteCeilingExempt,
  rateLimitAddress,
  rateLimitChecks,
} from 'src/middleware/rate-limit.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { mockEnvData, newConfigRepositoryMock } from 'test/repositories/config.repository.mock.js';
import { newCryptoRepositoryMock } from 'test/repositories/crypto.repository.mock.js';

class TestController {
  @RateLimited(RATE_LIMITS.login)
  login() {}

  @RateLimited(RATE_LIMITS.sharedLinkLogin)
  sharedLinkLogin() {}

  @RateLimited(RATE_LIMITS.linkStart)
  linkStart() {}

  @RemoteCeilingExempt()
  thumbnail() {}

  unlimited() {}
}

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

const contextFor = (handler: () => void, request: RateLimitedRequest, response = { setHeader: vi.fn() }) =>
  ({
    getType: () => 'http',
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  }) as unknown as ExecutionContext;

describe(RateLimitGuard.name, () => {
  let sut: RateLimitGuard;
  let hit: ReturnType<typeof vi.fn>;
  let peek: ReturnType<typeof vi.fn>;
  let configRepository: ReturnType<typeof newConfigRepositoryMock>;
  let cryptoRepository: ReturnType<typeof newCryptoRepositoryMock>;
  const logger = { setContext: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const create = () =>
    new RateLimitGuard(
      logger as unknown as LoggingRepository,
      new Reflector(),
      { hit, peek } as unknown as RateLimitRepository,
      configRepository as never,
      cryptoRepository as never,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    hit = vi.fn().mockResolvedValue({ count: 1, resetSeconds: 600 });
    peek = vi.fn().mockResolvedValue({ count: 0, resetSeconds: 1 });
    configRepository = newConfigRepositoryMock();
    cryptoRepository = newCryptoRepositoryMock();
    sut = create();
  });

  it('counts login per address, and reads the failures of the email as a keyed hash', async () => {
    const request = makeRequest({ body: { email: ' Person@Example.com ', password: 'x' } });

    await expect(sut.canActivate(contextFor(TestController.prototype.login, request))).resolves.toBe(true);

    expect(hit).toHaveBeenCalledOnce();
    expect(hit).toHaveBeenCalledWith('frameleaf:rate-limit:login:ip:198.51.100.7', 600);
    const principalKey = `frameleaf:rate-limit:login:principal:${keyed('email:person@example.com')}`;
    expect(peek).toHaveBeenCalledWith(principalKey);
    expect(cryptoRepository.serverKeyedHash).toHaveBeenCalledWith(
      expect.any(String),
      'rate-limit',
      'email:person@example.com',
    );
    // the request itself does not count against the email; only a failure will
    expect(request.frameleafRateLimitFailures).toEqual([
      { key: principalKey, limit: RATE_LIMITS.login.principalLimit, windowSeconds: 600, counts: 'failures' },
    ]);
  });

  it('answers 429 with Retry-After once the address goes over its limit', async () => {
    hit.mockResolvedValueOnce({ count: RATE_LIMITS.login.limit + 1, resetSeconds: 321 });
    const response = { setHeader: vi.fn() };

    const result = sut.canActivate(contextFor(TestController.prototype.login, makeRequest(), response));

    await expect(result).rejects.toBeInstanceOf(HttpException);
    await expect(result).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    await expect(result).rejects.toMatchObject({ response: { code: 'rate_limited', retryAfter: 321 } });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '321');
  });

  it('answers 429 once an email has used up its failures, from any address', async () => {
    peek.mockResolvedValueOnce({ count: RATE_LIMITS.login.principalLimit, resetSeconds: 60 });
    const response = { setHeader: vi.fn() };
    const request = makeRequest({ ip: '203.0.113.50', body: { email: 'person@example.com' } });

    await expect(sut.canActivate(contextFor(TestController.prototype.login, request, response))).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '60');
  });

  it('lets the last attempt below the failure limit through', async () => {
    peek.mockResolvedValueOnce({ count: RATE_LIMITS.login.principalLimit - 1, resetSeconds: 60 });
    hit.mockResolvedValueOnce({ count: RATE_LIMITS.login.limit, resetSeconds: 1 });
    const request = makeRequest({ body: { email: 'person@example.com' } });

    await expect(sut.canActivate(contextFor(TestController.prototype.login, request))).resolves.toBe(true);
  });

  it('counts a shared link by its key (failures) and an admin action by the credential presented', async () => {
    const shared = makeRequest({ query: { key: 'share-key' } });
    await sut.canActivate(contextFor(TestController.prototype.sharedLinkLogin, shared));
    expect(peek).toHaveBeenCalledWith(`frameleaf:rate-limit:shared-link-login:principal:${keyed('key:share-key')}`);
    expect(shared.frameleafRateLimitFailures).toHaveLength(1);

    await sut.canActivate(
      contextFor(TestController.prototype.linkStart, makeRequest({ headers: { authorization: 'Bearer token-1' } })),
    );
    expect(hit).toHaveBeenLastCalledWith(
      `frameleaf:rate-limit:link-start:principal:${keyed('credential:token-1')}`,
      RATE_LIMITS.linkStart.windowSeconds,
    );
  });

  it('counts only the address when the request names no principal', async () => {
    await sut.canActivate(contextFor(TestController.prototype.linkStart, makeRequest()));

    expect(hit).toHaveBeenCalledTimes(1);
    expect(hit).toHaveBeenCalledWith('frameleaf:rate-limit:link-start:ip:198.51.100.7', 3600);
    expect(peek).not.toHaveBeenCalled();
  });

  it('leaves an unmarked route from the home network alone', async () => {
    await expect(sut.canActivate(contextFor(TestController.prototype.unlimited, makeRequest()))).resolves.toBe(true);
    expect(hit).not.toHaveBeenCalled();
  });

  it.each(['relay', 'wan'] as const)('applies the remote-access ceiling to every %s request', async (via) => {
    const request = makeRequest({
      frameleafVia: via,
      frameleafForwarded: { for: '203.0.113.9', proto: 'https', host: null },
    });

    await expect(sut.canActivate(contextFor(TestController.prototype.unlimited, request))).resolves.toBe(true);
    expect(hit).toHaveBeenCalledWith(
      'frameleaf:rate-limit:remote-access:ip:203.0.113.9',
      REMOTE_ACCESS_CEILING.windowSeconds,
    );

    hit.mockResolvedValueOnce({ count: REMOTE_ACCESS_CEILING.limit + 1, resetSeconds: 12 });
    await expect(sut.canActivate(contextFor(TestController.prototype.unlimited, request))).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it('leaves thumbnails and previews out of the remote-access ceiling', async () => {
    const request = makeRequest({ frameleafVia: 'relay' });
    await expect(sut.canActivate(contextFor(TestController.prototype.thumbnail, request))).resolves.toBe(true);
    expect(hit).not.toHaveBeenCalled();
  });

  it('does not apply the ceiling at home', async () => {
    await sut.canActivate(contextFor(TestController.prototype.unlimited, makeRequest({ frameleafVia: 'lan' })));
    expect(hit).not.toHaveBeenCalled();
  });

  it('refuses a remote request with Retry-After when the counters are unavailable, and lets a home request through', async () => {
    hit.mockRejectedValue(new Error('Connection is closed.'));
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

  it('skips the route limits, but not the ceiling, when IMMICH_ENV is testing, and says so at start', async () => {
    configRepository.getEnv.mockReturnValue(mockEnvData({ environment: ImmichEnvironment.Testing }));
    sut = create();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('IMMICH_ENV=testing'));

    await sut.canActivate(contextFor(TestController.prototype.login, makeRequest()));
    expect(hit).not.toHaveBeenCalled();

    await sut.canActivate(contextFor(TestController.prototype.login, makeRequest({ frameleafVia: 'relay' })));
    expect(hit).toHaveBeenCalledTimes(1);
    expect(hit).toHaveBeenCalledWith(expect.stringContaining(':remote-access:'), REMOTE_ACCESS_CEILING.windowSeconds);
  });

  it('ignores anything but HTTP', async () => {
    const context = { getType: () => 'ws' } as unknown as ExecutionContext;
    await expect(sut.canActivate(context)).resolves.toBe(true);
    expect(hit).not.toHaveBeenCalled();
  });
});

describe(RateLimitFailureInterceptor.name, () => {
  const hit = vi.fn();
  const logger = { setContext: vi.fn(), warn: vi.fn() };
  const sut = new RateLimitFailureInterceptor(
    logger as unknown as LoggingRepository,
    { hit } as unknown as RateLimitRepository,
  );
  const failures = [
    { key: 'frameleaf:rate-limit:login:principal:x', limit: 10, windowSeconds: 600, counts: 'failures' as const },
  ];
  const contextWith = (request: Partial<RateLimitedRequest>) =>
    ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;
  const handler = (result: () => ReturnType<CallHandler['handle']>) => ({ handle: result }) as CallHandler;

  beforeEach(() => {
    hit.mockReset();
    hit.mockResolvedValue({ count: 1, resetSeconds: 600 });
  });

  it('counts a wrong password (401) against the email, then passes the error on', async () => {
    const error = new UnauthorizedException('Incorrect email or password');
    await expect(
      lastValueFrom(
        sut.intercept(
          contextWith({ frameleafRateLimitFailures: failures }),
          handler(() => throwError(() => error)),
        ),
      ),
    ).rejects.toBe(error);
    expect(hit).toHaveBeenCalledWith('frameleaf:rate-limit:login:principal:x', 600);
  });

  it('never counts a successful sign-in or another error', async () => {
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
          handler(() => throwError(() => new HttpException('Too many', 429))),
        ),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(hit).not.toHaveBeenCalled();
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
    expect(hit).not.toHaveBeenCalled();
  });

  it('still reports the wrong password when the failure cannot be counted', async () => {
    hit.mockRejectedValue(new Error('Connection is closed.'));
    const error = new UnauthorizedException();
    await expect(
      lastValueFrom(
        sut.intercept(
          contextWith({ frameleafRateLimitFailures: failures }),
          handler(() => throwError(() => error)),
        ),
      ),
    ).rejects.toBe(error);
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
      ceiling: true,
      keyOf: (principal) => Promise.resolve(principal),
    });
    expect(checks.map(({ key }) => key)).toEqual([
      'frameleaf:rate-limit:remote-access:ip:203.0.113.9',
      'frameleaf:rate-limit:link-start:ip:203.0.113.9',
    ]);
  });
});
