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
    acquireSignInAttempt: (key: string): Promise<SignInAttempt | undefined> => {
      if (held.has(key)) {
        return Promise.resolve(undefined);
      }
      held.add(key);
      return Promise.resolve({
        getWait: () => Promise.resolve((failures.get(key) ?? 0) >= 5 ? 30 : 0),
        recordFailure: () => {
          failures.set(key, (failures.get(key) ?? 0) + 1);
          return Promise.resolve();
        },
        clearFailures: () => {
          failures.delete(key);
          return Promise.resolve();
        },
        release: () => {
          held.delete(key);
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

  it('lets go of the address counter even when the account counter’s connection already ended', async () => {
    const acquire = counters.acquireSignInAttempt;
    vi.spyOn(counters, 'acquireSignInAttempt').mockImplementation(async (key: string) => {
      const attempt = await acquire(key);
      return key.includes(':account:') && attempt
        ? {
            ...attempt,
            release: () => Promise.reject(new Error('Release called on client which has already been released')),
          }
        : attempt;
    });

    await expect(wrongPassword('password', 'owner@example.com', '203.0.113.1')).resolves.toBe('checked');

    // the address counter (the one key that is not the account's) is free again
    const addressKey = counters.failures.keys().find((key) => !key.includes(':account:'))!;
    await expect(acquire(addressKey)).resolves.toBeDefined();
  });
});
