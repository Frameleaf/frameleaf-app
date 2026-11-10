import type { SignInAttempt } from 'src/repositories/rate-limit.repository.js';
import type { LoginDetails } from 'src/services/auth.service.js';
import { SignInSecurityService } from 'src/services/sign-in-security.service.js';
import { newTestService } from 'test/utils.js';

/** The PostgreSQL counters' rule in memory: five failures in a key start a wait (FL-850). */
const memoryCounters = () => {
  const failures = new Map<string, number>();
  const held = new Set<string>();
  return {
    failures,
    held,
    acquireSignInAttempt: (key: string | string[]): Promise<SignInAttempt | undefined> => {
      const keys = typeof key === 'string' ? [key] : key;
      if (keys.some((name) => held.has(name))) {
        return Promise.resolve(undefined);
      }
      for (const name of keys) {
        held.add(name);
      }
      return Promise.resolve({
        getWait: () => Promise.resolve(keys.some((name) => (failures.get(name) ?? 0) >= 5) ? 30 : 0),
        recordFailure: () => {
          for (const name of keys) {
            failures.set(name, (failures.get(name) ?? 0) + 1);
          }
          return Promise.resolve();
        },
        clearFailures: () => {
          for (const name of keys) {
            failures.delete(name);
          }
          return Promise.resolve();
        },
        release: () => {
          for (const name of keys) {
            held.delete(name);
          }
          return Promise.resolve();
        },
      });
    },
  };
};

const from = (address: string) =>
  ({
    clientIp: address,
    securityClientIp: address,
    deviceType: '',
    deviceOS: '',
    via: null,
  }) as unknown as LoginDetails;

describe(SignInSecurityService.name, () => {
  let sut: SignInSecurityService;
  let counters: ReturnType<typeof memoryCounters>;

  beforeEach(() => {
    ({ sut } = newTestService(SignInSecurityService));
    counters = memoryCounters();
    (sut as unknown as { counters: unknown }).counters = counters;
  });

  const wrongPassword = (kind: 'password' | 'two-factor', principal: string, address: string) =>
    sut.attempt(kind, principal, from(address), async (attempt) => {
      await sut.failed(attempt);
      return 'checked';
    });

  it('holds back an account’s passwords after repeated failures from any address (FL-850)', async () => {
    // a guesser behind a trusted proxy sends a new forwarded address with every try
    for (let guess = 0; guess < 5; guess++) {
      await expect(wrongPassword('password', 'owner@example.com', `203.0.113.${guess}`)).resolves.toBe('checked');
    }

    // a fresh address, and the same email in other letters, still wait
    await expect(wrongPassword('password', 'owner@example.com', '198.51.100.77')).rejects.toMatchObject({
      status: 429,
    });
    await expect(wrongPassword('password', ' Owner@Example.com', '198.51.100.78')).rejects.toMatchObject({
      status: 429,
    });
    // another account, and other kinds of sign-in for this one, are not held back
    await expect(wrongPassword('password', 'someone@example.com', '198.51.100.77')).resolves.toBe('checked');
    await expect(wrongPassword('two-factor', 'owner-id', '198.51.100.77')).resolves.toBe('checked');
  });

  it('clears the account’s count when its password is right', async () => {
    for (let guess = 0; guess < 4; guess++) {
      await wrongPassword('password', 'owner@example.com', `203.0.113.${guess}`);
    }
    await sut.attempt('password', 'owner@example.com', from('192.168.1.20'), (attempt) => sut.succeeded(attempt));

    await expect(wrongPassword('password', 'owner@example.com', '203.0.113.9')).resolves.toBe('checked');
  });

  it('waits while another password for the same account is being checked', async () => {
    await sut.attempt('password', 'owner@example.com', from('203.0.113.1'), async () => {
      await expect(wrongPassword('password', 'owner@example.com', '203.0.113.2')).rejects.toMatchObject({
        status: 429,
      });
    });
    // and lets go of the other address's counter it took
    await expect(wrongPassword('password', 'owner@example.com', '203.0.113.2')).resolves.toBe('checked');
  });

  it('takes the address and account counters together, in one request to the counters', async () => {
    const acquire = vi.spyOn(counters, 'acquireSignInAttempt');

    await wrongPassword('password', 'owner@example.com', '203.0.113.1');

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls[0][0]).toEqual([expect.any(String), expect.stringContaining(':account:')]);
    expect(counters.held.size).toBe(0);
  });

  it.each([
    { name: 'at home', via: null },
    { name: 'through remote access', via: 'relay' },
  ])('refuses a password it cannot hold back $name, without checking it (fails closed)', async ({ via }) => {
    vi.spyOn(counters, 'acquireSignInAttempt').mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    const verify = vi.fn();

    await expect(
      sut.attempt('password', 'owner@example.com', { ...from('192.168.1.20'), via } as LoginDetails, verify),
    ).rejects.toMatchObject({ status: 503 });
    expect(verify).not.toHaveBeenCalled();
  });
});
