import { SystemConfigHistoryCredentialChange } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { historyValue } from '$lib/frameleaf/settings-history';

describe('settings change history values (FL-66)', () => {
  it('shows recorded values like the change review', () => {
    const change = { path: 'trash.days', before: '30', after: '12' };
    expect(historyValue(change, 'before')).toEqual({ kind: 'text', text: '30' });
    expect(historyValue(change, 'after')).toEqual({ kind: 'text', text: '12' });

    const toggle = { path: 'trash.enabled', before: 'true', after: 'false' };
    expect(historyValue(toggle, 'before')).toEqual({ kind: 'on' });
    expect(historyValue(toggle, 'after')).toEqual({ kind: 'off' });

    expect(
      historyValue({ path: 'server.externalDomain', before: '""', after: '"https://photos.example"' }, 'before'),
    ).toEqual({ kind: 'empty' });
  });

  it('never shows a credential value, only whether it was replaced or cleared', () => {
    const replaced = {
      path: 'oauth.clientSecret',
      before: null,
      after: null,
      credential: SystemConfigHistoryCredentialChange.Replaced,
    };
    expect(historyValue(replaced, 'before')).toEqual({ kind: 'secret' });
    expect(historyValue(replaced, 'after')).toEqual({
      kind: 'credential',
      change: SystemConfigHistoryCredentialChange.Replaced,
    });
  });

  it('shows a value the server shortened as text', () => {
    const change = { path: 'theme.customCss', before: '""', after: '"body { color: red; …' };
    expect(historyValue(change, 'after')).toEqual({ kind: 'text', text: '"body { color: red; …' });
  });
});
