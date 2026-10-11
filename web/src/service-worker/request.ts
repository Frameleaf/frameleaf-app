/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

type PendingRequest = {
  controller: AbortController;
  /**
  Until the response arrives; dropped once it has, since a settled response is never reused.
  */
  promise?: Promise<Response>;
  cleanupTimeout?: ReturnType<typeof setTimeout>;
  /**
   * FL-137: the response has arrived. Its entry stays only so a late cancel can still stop the body
   * download; it is never handed to a new request, which goes back to the server, so the service
   * worker never answers a revoked share, a newly Locked item or another person signed in on this
   * browser. HTTP-cache entries are revalidated against current access; signing in or out also
   * clears them with Clear-Site-Data.
   */
  settled?: boolean;
  /**
  Callers handed this request's response, each of which may later cancel it by URL.
  */
  callers: number;
  /**
   * Cancels still owed by the earlier, settled requests this one replaced. The app cancels by URL, so
   * a component that loaded the earlier response and is destroyed later must not abort this newer load
   * of the same URL for another component.
   */
  staleCancels: number;
};

const pendingRequests = new Map<string, PendingRequest>();

const getRequestKey = (request: URL | Request): string => (request instanceof URL ? request.href : request.url);

const CANCELATION_MESSAGE = 'Request canceled by application';
const CLEANUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_STALE_CANCELS = 8;

const clone = (promise: Promise<Response>) =>
  // Clone the response since response bodies can only be read once; each caller gets its own
  // eslint-disable-next-line unicorn/prefer-await
  promise.then((response) => response.clone());

export const handleFetch = async (request: URL | Request): Promise<Response> => {
  const requestKey = getRequestKey(request);
  const existing = pendingRequests.get(requestKey);

  if (existing && !existing.settled && existing.promise) {
    existing.callers++;
    return clone(existing.promise);
  }

  const pendingRequest: PendingRequest = {
    controller: new AbortController(),
    callers: 1,
    // bounded: callers that never cancel must not disable cancelling for this URL indefinitely
    staleCancels: existing ? Math.min(existing.callers + existing.staleCancels, MAX_STALE_CANCELS) : 0,
  };
  if (existing?.cleanupTimeout) {
    clearTimeout(existing.cleanupTimeout);
  }
  pendingRequests.set(requestKey, pendingRequest);

  // Revalidate even fresh HTTP-cache entries so a revoked grant or actual Lock cannot reuse bytes
  // without current authorization. Keep a caller's stricter no-store policy.
  // NOTE: fetch returns after headers received, not the body
  const promise = fetch(request, {
    signal: pendingRequest.controller.signal,
    cache: request instanceof Request && request.cache === 'no-store' ? 'no-store' : 'no-cache',
  })
    // eslint-disable-next-line unicorn/prefer-await
    .catch((error: unknown) => {
      const standardError = error instanceof Error ? error : new Error(String(error));
      if (standardError.name === 'AbortError' || standardError.message === CANCELATION_MESSAGE) {
        // dummy response avoids network errors in the console for these requests
        return new Response(undefined, { status: 204 });
      }
      throw standardError;
    });
  pendingRequest.promise = promise;

  const response = clone(promise);
  void promise
    .catch(() => {})
    .finally(() => {
      pendingRequest.settled = true;
      // never reused once settled: release the original response rather than hold it for the cancel window
      pendingRequest.promise = undefined;
      // Keep the entry while the body may still be streaming, so a cancel can abort it
      pendingRequest.cleanupTimeout = setTimeout(() => {
        // a newer request for the same URL may have replaced this entry
        if (pendingRequests.get(requestKey) === pendingRequest) {
          pendingRequests.delete(requestKey);
        }
      }, CLEANUP_TIMEOUT_MS);
    });

  return response;
};

export const handleCancel = (url: URL) => {
  const requestKey = getRequestKey(url);

  const pendingRequest = pendingRequests.get(requestKey);
  if (!pendingRequest) {
    return;
  }
  // a cancel from a caller of an earlier, replaced request
  if (pendingRequest.staleCancels > 0) {
    pendingRequest.staleCancels--;
    return;
  }
  // another caller still wants this load: only the last cancel may stop it
  if (--pendingRequest.callers > 0) {
    return;
  }
  pendingRequest.controller.abort(CANCELATION_MESSAGE);
  if (pendingRequest.cleanupTimeout) {
    clearTimeout(pendingRequest.cleanupTimeout);
  }
  pendingRequests.delete(requestKey);
};
