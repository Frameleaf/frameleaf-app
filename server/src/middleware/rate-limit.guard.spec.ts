import { ExecutionContext, HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { FrameleafRequest } from 'src/middleware/frameleaf-via.middleware.js';
import { ImmichEnvironment } from 'src/enum.js';
import {
  RATE_LIMITS,
  REMOTE_ACCESS_CEILING,
  RateLimitGuard,
  RateLimited,
  rateLimitAddress,
  rateLimitChecks,
} from 'src/middleware/rate-limit.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { mockEnvData, newConfigRepositoryMock } from 'test/repositories/config.repository.mock.js';

class TestController {
  @RateLimited(RATE_LIMITS.login)
  login() {}

  @RateLimited(RATE_LIMITS.sharedLinkLogin)
  sharedLinkLogin() {}

  @RateLimited(RATE_LIMITS.linkStart)
  linkStart() {}

  unlimited() {}
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const makeRequest = (overrides: Partial<FrameleafRequest> = {}) =>
  ({
    ip: '198.51.100.7',
    headers: {},
    query: {},
    cookies: {},
    body: {},
    frameleafVia: null,
    frameleafForwarded: null,
    ...overrides,
  }) as FrameleafRequest;

const contextFor = (handler: () => void, request: FrameleafRequest, response = { setHeader: vi.fn() }) =>
  ({
    getType: () => 'http',
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  }) as unknown as ExecutionContext;

describe(RateLimitGuard.name, () => {
  let sut: RateLimitGuard;
  let hit: ReturnType<typeof vi.fn>;
  let configRepository: ReturnType<typeof newConfigRepositoryMock>;
  const logger = { setContext: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    hit = vi.fn().mockResolvedValue({ count: 1, resetSeconds: 600 });
    configRepository = newConfigRepositoryMock();
    sut = new RateLimitGuard(
      logger as unknown as LoggingRepository,
      new Reflector(),
      { hit } as unknown as RateLimitRepository,
      configRepository as never,
    );
  });

  it('counts a limited route per address and per email, as hashes', async () => {
    const request = makeRequest({ body: { email: ' Person@Example.com ', password: 'x' } });

    await expect(sut.canActivate(contextFor(TestController.prototype.login, request))).resolves.toBe(true);

    expect(hit).toHaveBeenCalledTimes(2);
    expect(hit).toHaveBeenNthCalledWith(1, 'frameleaf:rate-limit:login:ip:198.51.100.7', 600);
    expect(hit).toHaveBeenNthCalledWith(
      2,
      `frameleaf:rate-limit:login:principal:${sha256('email:person@example.com')}`,
      600,
    );
    expect(JSON.stringify(hit.mock.calls)).not.toContain('example.com');
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

  it('answers 429 when one email is tried from many addresses', async () => {
    hit.mockResolvedValueOnce({ count: 1, resetSeconds: 600 });
    hit.mockResolvedValueOnce({ count: RATE_LIMITS.login.principalLimit + 1, resetSeconds: 60 });
    const request = makeRequest({ body: { email: 'person@example.com' } });

    await expect(sut.canActivate(contextFor(TestController.prototype.login, request))).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });

  it('allows the last request inside the limit', async () => {
    hit.mockResolvedValue({ count: RATE_LIMITS.login.limit, resetSeconds: 1 });

    await expect(sut.canActivate(contextFor(TestController.prototype.login, makeRequest()))).resolves.toBe(true);
  });

  it('counts a shared link by its key and an admin action by the credential presented', async () => {
    await sut.canActivate(
      contextFor(TestController.prototype.sharedLinkLogin, makeRequest({ query: { key: 'share-key' } })),
    );
    expect(hit).toHaveBeenLastCalledWith(
      `frameleaf:rate-limit:shared-link-login:principal:${sha256('key:share-key')}`,
      RATE_LIMITS.sharedLinkLogin.windowSeconds,
    );

    await sut.canActivate(
      contextFor(TestController.prototype.linkStart, makeRequest({ headers: { authorization: 'Bearer token-1' } })),
    );
    expect(hit).toHaveBeenLastCalledWith(
      `frameleaf:rate-limit:link-start:principal:${sha256('credential:token-1')}`,
      RATE_LIMITS.linkStart.windowSeconds,
    );
  });

  it('counts only the address when the request names no principal', async () => {
    await sut.canActivate(contextFor(TestController.prototype.linkStart, makeRequest()));

    expect(hit).toHaveBeenCalledTimes(1);
    expect(hit).toHaveBeenCalledWith('frameleaf:rate-limit:link-start:ip:198.51.100.7', 3600);
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

  it('does not apply the ceiling at home', async () => {
    const request = makeRequest({ frameleafVia: 'lan' });
    await sut.canActivate(contextFor(TestController.prototype.unlimited, request));
    expect(hit).not.toHaveBeenCalled();
  });

  it('refuses a remote request when the counters are unavailable, and lets a home request through', async () => {
    hit.mockRejectedValue(new Error('Connection is closed.'));

    await expect(
      sut.canActivate(contextFor(TestController.prototype.login, makeRequest({ frameleafVia: 'relay' }))),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(sut.canActivate(contextFor(TestController.prototype.login, makeRequest()))).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('skips the route limits, but not the ceiling, when IMMICH_ENV is testing', async () => {
    configRepository.getEnv.mockReturnValue(mockEnvData({ environment: ImmichEnvironment.Testing }));

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
  it('prefers the address the edge worker reported', () => {
    const request = makeRequest({
      ip: '127.0.0.1',
      frameleafVia: 'relay',
      frameleafForwarded: { for: '203.0.113.9', proto: 'https', host: null },
    });

    expect(rateLimitChecks(request, RATE_LIMITS.login).map(({ key }) => key)).toEqual([
      'frameleaf:rate-limit:remote-access:ip:203.0.113.9',
      'frameleaf:rate-limit:login:ip:203.0.113.9',
    ]);
  });
});
