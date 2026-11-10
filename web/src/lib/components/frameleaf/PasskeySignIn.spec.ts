import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import PasskeySignIn from './PasskeySignIn.svelte';

const sdk = vi.hoisted(() => ({ getPasskeyLoginOptions: vi.fn(), loginWithPasskey: vi.fn() }));
const webauthn = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  browserSupportsWebAuthnAutofill: vi.fn(),
  WebAuthnAbortService: { cancelCeremony: vi.fn() },
}));
const here = vi.hoisted(() => ({
  value: { ok: true } as { ok: true } | { ok: false; reason: 'http' | 'unsupported' },
}));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<typeof import('@frameleaf/sdk')>()), ...sdk }));
vi.mock('@simplewebauthn/browser', () => webauthn);
vi.mock('$lib/frameleaf/passkeys', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/passkeys')>()),
  passkeysInThisBrowser: () => here.value,
}));

const options = { challenge: 'abc', rpId: 'photos.example.com', userVerification: 'required' };
const credential = { id: 'cred', rawId: 'cred', type: 'public-key', response: {} };
const named = (name: string) => ({ name, message: name });

describe('Sign in with a passkey (FL-859)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    here.value = { ok: true };
    sdk.getPasskeyLoginOptions.mockResolvedValue({ passkeysAvailable: true, reason: null, options });
    webauthn.browserSupportsWebAuthnAutofill.mockResolvedValue(false);
    webauthn.startAuthentication.mockResolvedValue(credential);
  });

  it('signs in and skips the two-step code: the session comes straight back', async () => {
    const user = { userId: 'u1', accessToken: 'token' };
    sdk.loginWithPasskey.mockResolvedValue(user);
    const onSignedIn = vi.fn();
    render(PasskeySignIn, { rememberMe: false, onSignedIn });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: options });
    expect(sdk.loginWithPasskey).toHaveBeenCalledWith({ passkeyLoginDto: { credential, rememberMe: false } });
    expect(onSignedIn).toHaveBeenCalledWith(user);
  });

  it('returns quietly when the browser’s window is cancelled', async () => {
    webauthn.startAuthentication.mockRejectedValue(named('NotAllowedError'));
    render(PasskeySignIn, { rememberMe: true, onSignedIn: vi.fn() });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));
    expect(await screen.findByRole('button', { name: 'Sign in with a passkey' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sdk.loginWithPasskey).not.toHaveBeenCalled();
  });

  it('says a passkey is not recognised when the server refuses it', async () => {
    sdk.loginWithPasskey.mockRejectedValue({ status: 401, data: { code: 'passkey_not_recognised' } });
    render(PasskeySignIn, { rememberMe: true, onSignedIn: vi.fn() });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That passkey isn’t set up for this server.');
  });

  it('shows the waiting card while the browser’s window is open, with Cancel', async () => {
    webauthn.startAuthentication.mockReturnValue(new Promise(() => {}));
    render(PasskeySignIn, { rememberMe: true, onSignedIn: vi.fn() });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));
    expect(await screen.findByText('Waiting for your passkey…')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(webauthn.WebAuthnAbortService.cancelCeremony).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Sign in with a passkey' })).toBeInTheDocument();
  });

  it('never opens the browser’s window after Cancel while the options were on their way', async () => {
    render(PasskeySignIn, { rememberMe: true, onSignedIn: vi.fn() });
    const button = await screen.findByRole('button', { name: 'Sign in with a passkey' });
    let answer!: (value: unknown) => void;
    sdk.getPasskeyLoginOptions.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await userEvent.click(button);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    answer({ passkeysAvailable: true, reason: null, options });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Sign in with a passkey' })).toBeInTheDocument());
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  });

  it('uses the first challenge for the email field’s suggestions, asking the server once', async () => {
    webauthn.browserSupportsWebAuthnAutofill.mockResolvedValue(true);
    webauthn.startAuthentication.mockReturnValue(new Promise(() => {}));
    render(PasskeySignIn, { rememberMe: true, autofill: true, onSignedIn: vi.fn() });
    await vi.waitFor(() =>
      expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: options, useBrowserAutofill: true }),
    );
    expect(sdk.getPasskeyLoginOptions).toHaveBeenCalledTimes(1);
  });

  it('hides the button on plain http and says why, with the secure address', async () => {
    here.value = { ok: false, reason: 'http' };
    render(PasskeySignIn, { rememberMe: true, onSignedIn: vi.fn(), secureUrl: 'https://photos.example.com' });
    expect(await screen.findByText(/Passkeys work only at a secure address/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open photos.example.com to use a passkey.' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).not.toBeInTheDocument();
    expect(sdk.getPasskeyLoginOptions).not.toHaveBeenCalled();
  });

  it('shows nothing when the server says passkeys can’t work at this address', async () => {
    sdk.getPasskeyLoginOptions.mockResolvedValue({ passkeysAvailable: false, reason: 'address', options: null });
    const { container } = render(PasskeySignIn, { rememberMe: true, onSignedIn: vi.fn() });
    await vi.waitFor(() => expect(sdk.getPasskeyLoginOptions).toHaveBeenCalled());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.textContent?.trim()).toBe('');
  });
});
