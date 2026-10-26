import { toastManager } from '@frameleaf/ui';
import { render, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
import { authManager } from '$lib/managers/auth-manager.svelte';
import en from '../../../../../i18n/en.json';
import Page from './+page.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('@frameleaf/ui', () => ({ toastManager: { primary: vi.fn(), danger: vi.fn() } }));

const data = (overrides: Record<string, unknown> = {}) =>
  ({ meta: { title: 'Support Frameleaf' }, linkCode: null, linkNotice: null, ...overrides }) as never;

describe('/buy (FL-544: Support Frameleaf folded into Your Frameleaf Cloud)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addMessages('dev', en);
  });

  it('sends an administrator to Your Frameleaf Cloud', async () => {
    authManager.setUser({ id: 'u1', name: 'Taylor', isAdmin: true, license: null } as never);
    render(Page, { data: data() });
    await waitFor(() =>
      expect(goto).toHaveBeenCalledWith(commandCenterUrl('cloud', 'cloud-plan'), { replaceState: true }),
    );
    expect(sdkMock.redeemLicenseLinkCode).not.toHaveBeenCalled();
  });

  it('sends a member to their own Supporter settings', async () => {
    authManager.setUser({ id: 'u2', name: 'Morgan', isAdmin: false, license: null } as never);
    render(Page, { data: data() });
    await waitFor(() =>
      expect(goto).toHaveBeenCalledWith(commandCenterUrl('preferences', 'user-purchase-settings'), {
        replaceState: true,
      }),
    );
  });

  it('redeems a link code from the Frameleaf account site first, then moves on', async () => {
    authManager.setUser({ id: 'u1', name: 'Taylor', isAdmin: true, license: null } as never);
    sdkMock.redeemLicenseLinkCode.mockResolvedValue({ kind: 'server', keyHint: '9XTR' } as never);
    render(Page, { data: data({ linkCode: 'flc_abcdefghijklmnopqrstuvwxyz' }) });
    await waitFor(() =>
      expect(sdkMock.redeemLicenseLinkCode).toHaveBeenCalledWith({
        licenseLinkCodeDto: { code: 'flc_abcdefghijklmnopqrstuvwxyz' },
      }),
    );
    await waitFor(() => expect(toastManager.primary).toHaveBeenCalledWith(en.frameleaf_buy_activated));
    expect(goto).toHaveBeenCalledWith(commandCenterUrl('cloud', 'cloud-plan'), { replaceState: true });
  });

  it('explains an old link that carried the key, and asks for the key to be pasted', async () => {
    authManager.setUser({ id: 'u1', name: 'Taylor', isAdmin: true, license: null } as never);
    render(Page, { data: data({ linkNotice: 'key-in-link' }) });
    await waitFor(() => expect(toastManager.danger).toHaveBeenCalledWith(en.frameleaf_buy_key_in_link));
    expect(goto).toHaveBeenCalled();
  });
});
