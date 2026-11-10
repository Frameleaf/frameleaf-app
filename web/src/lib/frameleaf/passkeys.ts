/**
 * FL-859: passkeys on the web (the approved FL-767 prototype, `src/passkeys.mjs`). The rules the
 * screens follow: browsers make and use passkeys only on a secure (https) address or localhost, adding
 * one asks for the password if it wasn't checked in the last 10 minutes, and cancelling the browser's
 * window is not an error.
 */
/** Minutes a password check lasts before adding a passkey asks for it again (server: FL-836). */
export const PASSWORD_PROOF_MINUTES = 10;
/** Longest passkey name. */
export const PASSKEY_NAME_LENGTH = 40;

export type PasskeysHere = { ok: true } | { ok: false; reason: 'http' | 'unsupported' };

/**
 * Whether this page can make or use passkeys, and why not. The server also refuses an address that
 * isn't its own; that answer comes back with the options.
 */
export const passkeysHere = ({
  protocol,
  hostname,
  webAuthn,
}: {
  protocol: string;
  hostname: string;
  webAuthn: boolean;
}): PasskeysHere => {
  if (protocol !== 'https:' && hostname !== 'localhost') {
    return { ok: false, reason: 'http' };
  }
  return webAuthn ? { ok: true } : { ok: false, reason: 'unsupported' };
};

/** This browser's answer to `passkeysHere`. */
export const passkeysInThisBrowser = (): PasskeysHere =>
  passkeysHere({
    protocol: location.protocol,
    hostname: location.hostname,
    webAuthn: typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function',
  });

/** A tidy name: spaces collapsed, no leading space, at most PASSKEY_NAME_LENGTH characters. */
export const cleanName = (name: string) => name.replaceAll(/\s+/g, ' ').trimStart().slice(0, PASSKEY_NAME_LENGTH);

/**
 * What a browser ceremony's failure means for the screen: `cancelled` (the person closed the window,
 * or it timed out: no message), `exists` (this device already holds a passkey for the account), or
 * `failed`.
 */
export const ceremonyProblem = (error: unknown): 'cancelled' | 'exists' | 'failed' => {
  const { name, code } = (error ?? {}) as { name?: string; code?: string };
  if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || name === 'InvalidStateError') {
    return 'exists';
  }
  if (name === 'NotAllowedError' || name === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED') {
    return 'cancelled';
  }
  return 'failed';
};

/** The server's `code` on a refused passkey sign-in (FL-836), else undefined. */
export const serverCode = (error: unknown): string | undefined => {
  let data = (error as { data?: unknown } | null)?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  const code = (data as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
};
