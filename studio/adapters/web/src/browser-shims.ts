/**
 * Small platform gaps the vendored editor assumes are filled (FL-88, `STU-201` "Safari/Firefox/
 * Chromium"). Freecut is developed against Chromium; Frameleaf runs it in every browser without
 * editing the vendor source, so the gaps are closed here, before the editor loads.
 *
 * - `requestIdleCallback` / `cancelIdleCallback`: Safari has neither. Freecut's autosave and several
 *   background caches schedule through them; without the shim they throw on Safari.
 */
export function installBrowserShims(target: typeof globalThis = globalThis): void {
  const scope = target as typeof globalThis & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
    cancelIdleCallback?: (handle: number) => void
  }
  if (typeof scope.requestIdleCallback !== 'function') {
    scope.requestIdleCallback = (callback, options) => {
      const start = Date.now()
      return setTimeout(
        () =>
          callback({
            didTimeout: false,
            timeRemaining: () => Math.max(0, 50 - (Date.now() - start)),
          }),
        Math.min(options?.timeout ?? 1, 1),
      ) as unknown as number
    }
  }
  if (typeof scope.cancelIdleCallback !== 'function') {
    scope.cancelIdleCallback = (handle) => clearTimeout(handle)
  }
}
