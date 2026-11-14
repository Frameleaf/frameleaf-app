import { describe, expect, it } from 'vitest';
import { isReturnTo } from './connected-apps';

describe('connected app return destinations', () => {
  it('accepts the exact Lightroom handler with OAuth response parameters', () => {
    expect(
      isReturnTo(
        'lightroom://net.frameleaf.connect/oauth/callback?code=x&state=y',
        'lightroom://net.frameleaf.connect/oauth/callback',
      ),
    ).toBe(true);
  });

  it('does not confuse native schemes or plugin hosts with the same null origin', () => {
    const expected = 'lightroom://net.frameleaf.connect/oauth/callback';
    expect(isReturnTo('other://net.frameleaf.connect/oauth/callback?code=x', expected)).toBe(false);
    expect(isReturnTo('lightroom://other.plugin/oauth/callback?code=x', expected)).toBe(false);
  });

  it('preserves the registered platform callback query parameters', () => {
    const expected = 'https://raycast.com/redirect?packageName=Frameleaf';
    expect(isReturnTo(`${expected}&code=x`, expected)).toBe(true);
    expect(isReturnTo('https://raycast.com/redirect?packageName=Other&code=x', expected)).toBe(false);
    expect(isReturnTo('https://raycast.com/redirect?code=x', expected)).toBe(false);
  });
});
