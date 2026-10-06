import { setOAuthContinue } from '$lib/frameleaf/auth-session-preference';
import { load } from './+page';

const auth = vi.hoisted(() => ({ authenticated: false }));
vi.mock('@frameleaf/sdk', () => ({ getPublicConfig: vi.fn().mockResolvedValue({}) }));
vi.mock('$lib/utils/i18n', () => ({ getFormatter: vi.fn().mockResolvedValue((key: string) => key) }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { isInitialized: true } },
}));

const open = (query: string) =>
  load({ url: new URL(`/auth/login${query}`, location.origin), parent: vi.fn() } as never);
const at = (path: string) => new URL(path, location.origin).href;

describe('the sign-in page load (FL-80)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    auth.authenticated = false;
  });

  it('continues a signed-in visitor to the continue address', async () => {
    auth.authenticated = true;
    await expect(open('?continue=%2Falbums')).rejects.toMatchObject({ status: 307, location: at('/albums') });
  });

  it('continues a finished OAuth callback where its sign-in started, not to the library', async () => {
    // the callback address carries no `continue`; the sign-in kept it before leaving for the provider
    setOAuthContinue(at('/albums?from=share'));
    auth.authenticated = true;
    await expect(open('?code=abc&state=xyz')).rejects.toMatchObject({
      status: 307,
      location: at('/albums?from=share'),
    });
  });

  it('hands the stored continuation to the callback page', async () => {
    setOAuthContinue(at('/locked'));
    const data = (await open('?code=abc&state=xyz')) as { continueUrl: string | URL };
    expect(String(data.continueUrl)).toBe(at('/locked'));
  });

  it('never continues a callback to another site, whatever was stored', async () => {
    setOAuthContinue('https://outside.example.test/steal');
    auth.authenticated = true;
    await expect(open('?code=abc&state=xyz')).rejects.toMatchObject({ status: 307, location: at('/photos') });
  });

  it('ignores a stored continuation outside a callback', async () => {
    setOAuthContinue(at('/albums'));
    auth.authenticated = true;
    await expect(open('')).rejects.toMatchObject({ status: 307, location: at('/photos') });
  });
});
