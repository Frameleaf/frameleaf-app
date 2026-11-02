import { getAuthStatus, type AuthStatusResponseDto } from '@frameleaf/sdk';
import { sessionAccess } from '$lib/frameleaf/session-access.svelte';

/** One `GET /auth/status` answer, with what the privacy guard needs to bound an elevation. */
export type AuthStatusRead = {
  status: AuthStatusResponseDto;
  /** The response's `Date` header (server time), or NaN when it is missing or unreadable. */
  serverTime: number;
  /** `performance.now()` when the request started. */
  started: number;
};

type Read = { promise: Promise<AuthStatusRead>; revision: number; settledAt?: number };

let latest: Read | undefined;

/** How long a finished read still answers a passive reader (a top bar mounting right after the guard). */
const RECENT_MS = 2000;

const request = (): Read => {
  const started = performance.now();
  const revision = sessionAccess.revision;
  let serverTime = NaN;
  const read = { revision } as Read;
  read.promise = (async () => {
    try {
      const status = await getAuthStatus({
        cache: 'no-store',
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          serverTime = Date.parse(response.headers.get('Date') ?? '');
          return response;
        },
      });
      read.settledAt = performance.now();
      return { status, serverTime, started };
    } catch (error) {
      if (latest === read) {
        latest = undefined;
      }
      throw error;
    }
  })();
  latest = read;
  return read;
};

/**
 * FL-647: the session's status, shared between the readers that ask at the same moment (the
 * privacy guard and the top bar both read it when a page opens).
 *
 * - `fresh` (the guard's own checks) always sends a new request; other readers can join it.
 * - `passive` joins a request still in flight that started under the same session-access revision.
 * - `recent` also accepts one that finished within the last two seconds under the same revision.
 *
 * A lock or reset bumps `sessionAccess.revision`, so a read started before it is never reused.
 */
export const readAuthStatus = (mode: 'fresh' | 'passive' | 'recent' = 'fresh'): Promise<AuthStatusRead> => {
  const shared = latest;
  if (mode !== 'fresh' && shared && shared.revision === sessionAccess.revision) {
    if (shared.settledAt === undefined) {
      return shared.promise;
    }
    if (mode === 'recent' && performance.now() - shared.settledAt <= RECENT_MS) {
      return shared.promise;
    }
  }
  return request().promise;
};

/** Forget every shared read: the session changed in a way the revision does not record. */
export const discardAuthStatusReads = () => {
  latest = undefined;
};
