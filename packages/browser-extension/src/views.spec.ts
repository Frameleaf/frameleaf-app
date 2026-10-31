import { describe, expect, it } from 'vitest';
import { settledView } from './views';

const signedIn = (origin: string, switchFrom: string | null = null) => ({
  connected: true,
  origin,
  switchFrom,
});
const signedOut = { connected: false, origin: null, switchFrom: null };

describe('the panel after the connection changes (FL-655)', () => {
  it('goes back to Connect after signing out from Settings or Switch server', () => {
    expect(settledView('settings', signedOut)).toBe('main');
    expect(
      settledView('switch', { ...signedOut, switchFrom: 'https://a.example' }),
    ).toBe('main');
  });
  it('leaves the switch form once signed in to the other server', () => {
    expect(
      settledView('switch', signedIn('https://b.example', 'https://a.example')),
    ).toBe('main');
  });
  it('stays on the switch form while still on the old server', () => {
    expect(
      settledView('switch', signedIn('https://a.example', 'https://a.example')),
    ).toBe('switch');
  });
  it('keeps every other panel', () => {
    expect(settledView('settings', signedIn('https://a.example'))).toBe(
      'settings',
    );
    expect(settledView('key', signedOut)).toBe('key');
    expect(settledView('main', signedOut)).toBe('main');
  });
});
