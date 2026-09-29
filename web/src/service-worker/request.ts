/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

type PendingRequest = {
  controller: AbortController;
  promise: Promise<Response>;
  cleanupTimeout?: ReturnType<typeof setTimeout>;
  /**
   * FL-137: the response has arrived. Its entry stays only so a late cancel can still stop the body
   * download; it is never handed to a new request, which always goes to the server. Otherwise a
   * thumbnail or original would be served for minutes after its share was revoked, it was Locked,
   * or another person signed in on this browser.
   */
  settled?: boolean;
};

const pendingRequests = new Map<string, PendingRequest>();

const getRequestKey = (request: URL | Request): string => (request instanceof URL ? request.href : request.url);

const CANCELATION_MESSAGE = 'Request canceled by application';
const CLEANUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export const handleFetch = async (request: URL | Request): Promise<Response> => {
  const requestKey = getRequestKey(request);
  const existing = pendingRequests.get(requestKey);

  if (existing && !existing.settled) {
    // Clone the response since response bodies can only be read once
    // Each caller gets an independent clone they can consume
    // eslint-disable-next-line unicorn/prefer-await
    return existing.promise.then((response) => response.clone());
  }

  const pendingRequest: PendingRequest = {
    controller: new AbortController(),
    promise: undefined as unknown as Promise<Response>,
    cleanupTimeout: undefined,
  };
  pendingRequests.set(requestKey, pendingRequest);

  // NOTE: fetch returns after headers received, not the body
  pendingRequest.promise = fetch(request, { signal: pendingRequest.controller.signal })
    // eslint-disable-next-line unicorn/prefer-await
    .catch((error: unknown) => {
      const standardError = error instanceof Error ? error : new Error(String(error));
      if (standardError.name === 'AbortError' || standardError.message === CANCELATION_MESSAGE) {
        // dummy response avoids network errors in the console for these requests
        return new Response(undefined, { status: 204 });
      }
      throw standardError;
    })
    // eslint-disable-next-line unicorn/prefer-await
    .finally(() => {
      pendingRequest.settled = true;
      // Keep the entry while the body may still be streaming, so a cancel can abort it
      const cleanupTimeout = setTimeout(() => {
        // a newer request for the same URL may have replaced this entry
        if (pendingRequests.get(requestKey) === pendingRequest) {
          pendingRequests.delete(requestKey);
        }
      }, CLEANUP_TIMEOUT_MS);
      pendingRequest.cleanupTimeout = cleanupTimeout;
    });

  // Clone for the first caller to keep the original response unconsumed for future callers
  // eslint-disable-next-line unicorn/prefer-await
  return pendingRequest.promise.then((response) => response.clone());
};

export const handleCancel = (url: URL) => {
  const requestKey = getRequestKey(url);

  const pendingRequest = pendingRequests.get(requestKey);
  if (pendingRequest) {
    pendingRequest.controller.abort(CANCELATION_MESSAGE);
    if (pendingRequest.cleanupTimeout) {
      clearTimeout(pendingRequest.cleanupTimeout);
    }
    pendingRequests.delete(requestKey);
  }
};
