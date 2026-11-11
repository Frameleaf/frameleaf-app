import { sdkMock } from '$lib/__mocks__/sdk.mock';
import {
  cleanCode,
  cleanRecoveryCode,
  groupKey,
  isCode,
  isRecoveryCode,
  recoveryCodesText,
  triesLeft,
  twoStepRefusal,
} from '$lib/frameleaf/two-step';

describe('two-step sign-in rules (FL-831)', () => {
  beforeEach(() => {
    sdkMock.isHttpError.mockImplementation(
      (error: unknown) => !!error && typeof error === 'object' && 'status' in error,
    );
  });

  it('keeps the digits of a typed or pasted code, at most six', () => {
    expect(cleanCode(' 123-456 ')).toBe('123456');
    expect(cleanCode('1234567')).toBe('123456');
    expect(isCode('123456')).toBe(true);
    expect(isCode('12345')).toBe(false);
  });

  it('puts the dash back in a recovery code and lower-cases it', () => {
    expect(cleanRecoveryCode('H7K2M XQ4RT')).toBe('h7k2m-xq4rt');
    expect(cleanRecoveryCode('h7k2')).toBe('h7k2');
    // A line pasted from the codes file, number and all
    expect(cleanRecoveryCode('1. aaaaa-bbbbb')).toBe('aaaaa-bbbbb');
    expect(cleanRecoveryCode('10) h7k2m-xq4rt')).toBe('h7k2m-xq4rt');
    expect(cleanCode('1 2 3 4 5 6')).toBe('123456');
    expect(isRecoveryCode('h7k2m-xq4rt')).toBe(true);
    expect(isRecoveryCode('h7k2m')).toBe(false);
  });

  it('groups the setup key in fours and counts the tries left', () => {
    expect(groupKey('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(triesLeft(3)).toBe(2);
    expect(triesLeft(9)).toBe(0);
  });

  it('tells a wrong code, an expired sign-in and a pause apart', () => {
    expect(twoStepRefusal({ status: 401, data: { message: 'That code didn’t work.' } })).toEqual({ kind: 'wrong' });
    expect(
      twoStepRefusal({ status: 401, data: '{"message":"This sign-in expired. Enter your password again."}' }),
    ).toEqual({ kind: 'expired' });
    expect(twoStepRefusal({ status: 429, data: { retryAfter: 61 } })).toEqual({ kind: 'locked', minutes: 2 });
    expect(twoStepRefusal({ status: 429, data: {} })).toEqual({ kind: 'locked', minutes: 10 });
    expect(twoStepRefusal(new Error('offline'))).toBeNull();
  });

  it('writes the codes file with the account and the server', () => {
    const text = recoveryCodesText(['aaaaa-bbbbb', 'ccccc-ddddd'], {
      email: 'taylor@example.test',
      server: 'https://photos.example.test',
      heading: 'Frameleaf recovery codes',
      note: 'Keep them safe.',
    });
    expect(text).toContain('taylor@example.test\nhttps://photos.example.test');
    expect(text).toContain('1. aaaaa-bbbbb\n2. ccccc-ddddd');
  });
});
