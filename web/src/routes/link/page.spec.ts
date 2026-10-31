import { toastManager } from '@frameleaf/ui';
import { render, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import { recordFrameleafRequest } from '$lib/frameleaf/frameleaf-sign-in';
import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
import en from '../../../../i18n/en.json';
import Page from './+page.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('@frameleaf/ui', () => ({ toastManager: { primary: vi.fn(), danger: vi.fn() } }));

describe('Frameleaf account link callback (FL-158)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    addMessages('dev', en);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, '', '/');
  });

  it('sends the callback URL in the actual generated SDK request body before returning to preferences', async () => {
    history.replaceState(null, '', '/link?code=link-code&state=link-state');
    const callbackUrl = location.href;
    recordFrameleafRequest('https://id.example.test/auth?state=link-state', 'link');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ linked: true }));
    vi.stubGlobal('fetch', fetchMock);

    render(Page);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/oauth/frameleaf/link');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(options?.body as string)).toEqual({ url: callbackUrl });
    expect(location.search).toBe('');
    await waitFor(() => expect(toastManager.primary).toHaveBeenCalledWith(en.frameleaf_personal_linked_toast));
    expect(toastManager.danger).not.toHaveBeenCalled();
    expect(goto).toHaveBeenCalledWith(commandCenterUrl('preferences', 'frameleaf-account'), { replaceState: true });
  });
});
