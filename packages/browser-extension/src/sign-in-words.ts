import { normalizeServerAddress } from './api';
import type { RecentServer, SignInProblem } from './settings';

/**
 * FL-655: the words of signing in (prototype `extension-sign-in.mjs`), in plain language: no
 * technical sign-in terms, only sign in, sign out, allow, access and key (for the fallback).
 */

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const NOT_AN_ADDRESS =
  'That doesn’t look like an address. It’s the one you use to open Frameleaf, like photos.example.com.';

/**
 * Checks a typed server address before Sign in. A missing "https://" is added for you. Plain http
 * is only allowed for a server on this computer, with the switch on.
 */
export function checkServerAddress(
  input: string,
  allowLocal: boolean,
): { ok: true; origin: string; host: string } | { ok: false; problem: string } {
  const typed = String(input ?? '').trim();
  if (!typed) return { ok: false, problem: 'Enter your server’s address.' };
  const withScheme = /^[a-z][\d+.a-z-]*:\/\//i.test(typed)
    ? typed
    : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, problem: NOT_AN_ADDRESS };
  }
  const local = LOCAL_HOSTS.includes(url.hostname);
  const bareName = !url.hostname.includes('.') && !local && !url.port;
  if (!['https:', 'http:'].includes(url.protocol) || bareName)
    return { ok: false, problem: NOT_AN_ADDRESS };
  if (url.protocol === 'http:' && !local)
    return {
      ok: false,
      problem:
        'This address needs to start with https://. Only a server on this computer can do without it.',
    };
  if (url.protocol === 'http:' && !allowLocal)
    return {
      ok: false,
      problem:
        'To use a server on this computer without HTTPS, turn on “Allow a local server without HTTPS” below.',
    };
  try {
    return {
      ok: true,
      origin: normalizeServerAddress(withScheme, allowLocal),
      host: url.host,
    };
  } catch {
    return { ok: false, problem: NOT_AN_ADDRESS };
  }
}

export const hostOf = (origin: string) =>
  origin.replace(/^https?:\/\//, '').replace(/\/+$/, '');

type Problem = {
  tone: 'warn' | 'info';
  title: string;
  body: (host: string) => string;
  /** Offers "Use a key instead". */
  key?: boolean;
};
/** What can go wrong while signing in. `info` when nothing went wrong (you cancelled). */
export const SIGN_IN_PROBLEMS: Record<SignInProblem, Problem> = {
  address: {
    tone: 'warn',
    title: 'That isn’t a Frameleaf server',
    body: (host) =>
      `Nothing at ${host} answered as Frameleaf. Check the address: it’s the one you use to open Frameleaf in your browser.`,
  },
  unreachable: {
    tone: 'warn',
    title: 'Your server didn’t answer',
    body: (host) =>
      `${host} couldn’t be reached. Check that it’s turned on and that this computer is on the same network, or use its remote access address.`,
  },
  cancelled: {
    tone: 'info',
    title: 'Sign-in was cancelled',
    body: () =>
      'Nothing was allowed and nothing changed. Sign in whenever you’re ready.',
  },
  expired: {
    tone: 'warn',
    title: 'The sign-in took too long',
    body: () =>
      'To keep your account safe, a sign-in window only lasts 10 minutes. Sign in again to start over.',
  },
  'old-server': {
    tone: 'warn',
    title: 'This server can’t sign in from the browser yet',
    body: (host) =>
      `${host} runs an older version of Frameleaf. Ask whoever looks after it to update it, or use a key from Frameleaf instead.`,
    key: true,
  },
  permission: {
    tone: 'warn',
    title: 'Site access wasn’t allowed',
    body: (host) =>
      `Save to Frameleaf needs your permission to reach ${host}. Sign in again and choose Allow when the browser asks.`,
  },
  busy: {
    tone: 'warn',
    title: 'A sign-in window is already open',
    body: () => 'Finish signing in there, or close it and try again.',
  },
  failed: {
    tone: 'warn',
    title: 'Signing in didn’t finish',
    body: () => 'Nothing was allowed. Sign in again to start over.',
  },
};

/** "Today", or the day it was last used, like "Oct 12". */
export function lastUsed(item: RecentServer, now = new Date()) {
  if (!item.usedAt) return '';
  const day = new Date(item.usedAt);
  if (day.toDateString() === now.toDateString()) return 'Today';
  return day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
