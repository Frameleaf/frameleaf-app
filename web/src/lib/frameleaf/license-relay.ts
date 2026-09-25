/**
 * The Frameleaf store's key relay (FL-157). A licence key reaches this server only in the address
 * fragment (`/link#target=frameleaf_license&key=…`, which browsers never send to a server or put in
 * a referrer), in `sessionStorage` for the hop to Support Frameleaf, and in a request body. It is
 * never written to a query string, a history entry or a log.
 */
export const PENDING_LICENSE_KEY = 'frameleaf:license:pending';

const storage = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

/** Read the relay targets from a fragment such as `#target=frameleaf_license&key=FL-…`. */
export const parseLinkFragment = (hash: string) => {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return { target: params.get('target'), key: params.get('key') };
};

/** Keep a relayed key for Support Frameleaf; returns whether it was kept. */
export const holdPendingLicenseKey = (key: string): boolean => {
  const value = key.trim().toUpperCase();
  if (!/^FL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value)) {
    return false;
  }
  try {
    storage()?.setItem(PENDING_LICENSE_KEY, value);
    return true;
  } catch {
    return false;
  }
};

/** Take (and forget) the key waiting for Support Frameleaf, if any. */
export const takePendingLicenseKey = (): string | null => {
  try {
    const store = storage();
    const value = store?.getItem(PENDING_LICENSE_KEY) ?? null;
    store?.removeItem(PENDING_LICENSE_KEY);
    return value;
  } catch {
    return null;
  }
};
