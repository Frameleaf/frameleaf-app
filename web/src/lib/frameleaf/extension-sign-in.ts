import { BrowserExtensionClient, CodeChallengeMethod, type BrowserExtensionSignInStartDto } from '@frameleaf/sdk';

/**
 * FL-655: the Allow page's request, from the address Save to Frameleaf opened. The server checks
 * every part again; this only refuses what is plainly not a sign-in from the extension.
 */
export const extensionSignInRequest = (query: URLSearchParams): BrowserExtensionSignInStartDto | null => {
  const redirectUri = query.get('redirect_uri') ?? '';
  const codeChallenge = query.get('code_challenge') ?? '';
  const state = query.get('state') ?? '';
  const client = (query.get('client') ?? 'chrome').toLowerCase();
  // which installation of the extension is signing in, so only its own access is replaced
  const installationId = query.get('installation') ?? '';
  if (
    !isExtensionReturnAddress(redirectUri) ||
    !/^[\w-]{43}$/.test(codeChallenge) ||
    query.get('code_challenge_method') !== 'S256' ||
    state.length < 16 ||
    state.length > 512 ||
    (client !== 'chrome' && client !== 'edge') ||
    !/^[\w-]{16,128}$/.test(installationId)
  ) {
    return null;
  }
  return {
    redirectUri,
    codeChallenge,
    codeChallengeMethod: CodeChallengeMethod.S256,
    state,
    client: client === 'edge' ? BrowserExtensionClient.Edge : BrowserExtensionClient.Chrome,
    installationId,
  };
};

/** The browser sign-in window's own return address: `https://<32 a–p>.chromiumapp.org/…`. */
export const isExtensionReturnAddress = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      /^[a-p]{32}\.chromiumapp\.org$/.test(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === value
    );
  } catch {
    return false;
  }
};

/** Where the sign-in window may go next: only the extension's own return address. */
export const isReturnFor = (redirectUrl: string, redirectUri: string) => {
  try {
    const next = new URL(redirectUrl);
    const expected = new URL(redirectUri);
    return next.origin === expected.origin && next.pathname === expected.pathname;
  } catch {
    return false;
  }
};

/** How the browser is named on the page. */
export const extensionBrowserName = (client: BrowserExtensionClient) =>
  client === BrowserExtensionClient.Edge ? 'Edge' : 'Chrome';

/**
 * "Not you?" through a provider's sign-out page: the provider returns to the plain sign-in page, so
 * the Allow page to come back to is kept in this tab until then. Only the Allow page is kept.
 */
const CONTINUE_KEY = 'frameleaf.extensionSignInContinue';
const isAllowPage = (path: string) => /^\/auth\/allow-extension(?:\?|$)/.test(path);
export const keepExtensionContinue = (path: string) => {
  if (!isAllowPage(path)) {
    return;
  }
  try {
    sessionStorage.setItem(CONTINUE_KEY, path);
  } catch {
    // without storage, signing in again starts from the extension
  }
};
export const takeExtensionContinue = (): string | null => {
  try {
    const path = sessionStorage.getItem(CONTINUE_KEY);
    sessionStorage.removeItem(CONTINUE_KEY);
    return path && isAllowPage(path) ? path : null;
  } catch {
    return null;
  }
};
