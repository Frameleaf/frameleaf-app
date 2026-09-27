/**
 * The Frameleaf account site's hand-over to this server (CLD-004, replacing the FL-157 key relay).
 *
 * A licence key never travels in an address, not even in the fragment: "Use on your server" opens
 * `/link?target=frameleaf_license&linkCode=flc_…`, a one-time code that is useless without this
 * server's key. The page moves the code into `sessionStorage`, clears the address with
 * `history.replaceState` before anything else happens, and Support Frameleaf hands it to this server
 * in a request body. The server redeems it with Frameleaf Cloud, which activates the licence directly.
 *
 * An old link that still carries a key (`?licenseKey=…`, `#key=…`, …) is never used: the address is
 * cleared the same way and Support Frameleaf asks for the key to be pasted.
 */
export const PENDING_LINK_CODE = 'frameleaf:license:link-code';
export const KEY_IN_LINK_NOTICE = 'frameleaf:license:key-in-link';
/** The FL-157 relay's storage slot; anything left in it is dropped, never used. */
const LEGACY_PENDING_KEY = 'frameleaf:license:pending';

/** Frameleaf Cloud `LICENSE_LINK_CODE_RE`: `flc_` and 26 lower-case RFC 4648 base32 symbols. */
const LINK_CODE = /^flc_[a-z2-7]{26}$/;
/** A parameter whose name says it holds a key: `key`, `licenseKey`, `license_key`, `licenceKey`, … */
const KEY_PARAMETER = /^(?:key|licen[cs]e_?key|product_?key)$/i;
/** Anything shaped like a Frameleaf or upstream product key, wherever it sits in the address. */
const KEY_SHAPE = /FL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}|IM[A-Z]{2}-[A-Z0-9]{4}-/i;

const storage = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

export type LinkAddress = {
  /** The `target` query parameter. */
  target: string | null;
  /** A well-formed one-time link code from the account site, else null. */
  linkCode: string | null;
  /** The address carried a licence key (query or fragment); it must not be used. */
  carriedKey: boolean;
  /** The address carried a `linkCode` that is not shaped like one; it is never sent anywhere. */
  invalidLinkCode: boolean;
};

/** Read what `/link` was opened with. Keys are detected, never returned. */
export const readLinkAddress = (href: string): LinkAddress => {
  const url = new URL(href, 'https://local.invalid');
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const names = [...url.searchParams.keys(), ...fragment.keys()];
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    // keep the raw address
  }
  const carriedKey = names.some((name) => KEY_PARAMETER.test(name)) || KEY_SHAPE.test(decoded);
  const code = url.searchParams.get('linkCode')?.trim() ?? '';
  return {
    target: url.searchParams.get('target'),
    linkCode: LINK_CODE.test(code) ? code : null,
    carriedKey,
    invalidLinkCode: url.searchParams.has('linkCode') && !LINK_CODE.test(code),
  };
};

/** Whether `/link` was opened with anything this relay has to take out of the address. */
export const isLicenseRelay = (href: string) => {
  const { target, linkCode, carriedKey, invalidLinkCode } = readLinkAddress(href);
  return carriedKey || !!linkCode || invalidLinkCode || target === 'frameleaf_license' || target === 'activate_license';
};

/** Keep a link code for Support Frameleaf; returns whether it was kept. */
export const holdPendingLinkCode = (code: string): boolean => {
  if (!LINK_CODE.test(code)) {
    return false;
  }
  try {
    storage()?.setItem(PENDING_LINK_CODE, code);
    return true;
  } catch {
    return false;
  }
};

/** Take (and forget) the link code waiting for Support Frameleaf, if any. */
export const takePendingLinkCode = (): string | null => {
  try {
    const store = storage();
    const value = store?.getItem(PENDING_LINK_CODE) ?? null;
    store?.removeItem(PENDING_LINK_CODE);
    store?.removeItem(LEGACY_PENDING_KEY);
    return value && LINK_CODE.test(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * Why Support Frameleaf asks for the key to be pasted: the link carried a key (never used), or a link
 * code that is not shaped like one (never sent).
 */
export type LinkNotice = 'key-in-link' | 'invalid-code';

/** Remember to ask for the key to be pasted (neither the key nor the code is kept). */
export const holdLinkNotice = (notice: LinkNotice) => {
  try {
    storage()?.setItem(KEY_IN_LINK_NOTICE, notice);
  } catch {
    // the notice is a courtesy
  }
};

/** Take (and forget) the "paste the key instead" notice. */
export const takeLinkNotice = (): LinkNotice | null => {
  try {
    const store = storage();
    const value = store?.getItem(KEY_IN_LINK_NOTICE) ?? null;
    store?.removeItem(KEY_IN_LINK_NOTICE);
    return value === 'key-in-link' || value === 'invalid-code' ? value : null;
  } catch {
    return null;
  }
};
