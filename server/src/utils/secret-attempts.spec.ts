import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSecret } from 'src/utils/secret-attempts.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const fail = (userId: string) =>
  checkSecret(userId, (verify) => verify(() => Promise.reject(new Error('wrong secret'))));

/** Fails `count` times, waiting out each lockout just as a patient attacker would. */
const failTimes = async (userId: string, count: number) => {
  for (let attempt = 1; attempt <= count; attempt++) {
    await expect(fail(userId)).rejects.toThrow('wrong secret');
    if (attempt < count) {
      vi.advanceTimersByTime(attempt >= 10 ? HOUR + 1 : attempt >= 5 ? MINUTE + 1 : 1);
    }
  }
};

describe('checkSecret', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaches the 24-hour lockout for someone who sits out the 1-hour one', async () => {
    const userId = randomUUID();
    await failTimes(userId, 15);

    vi.advanceTimersByTime(23 * HOUR);

    await expect(fail(userId)).rejects.toThrow('Too many failed');
  });

  it('forgets failures after a quiet half hour past the lockout', async () => {
    const userId = randomUUID();
    await failTimes(userId, 10);

    vi.advanceTimersByTime(HOUR + 31 * MINUTE);

    await expect(fail(userId)).rejects.toThrow('wrong secret');
    await expect(fail(userId)).rejects.toThrow('wrong secret');
  });
});
