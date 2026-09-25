/**
 * Small platform gaps the vendored editor assumes are filled (FL-88, `STU-201` "Safari/Firefox/
 * Chromium"). Freecut is developed against Chromium; Frameleaf runs it in every browser without
 * editing the vendor source, so the gaps are closed here, before the editor loads.
 *
 * - `requestIdleCallback` / `cancelIdleCallback`: Safari has neither. Freecut's autosave and several
 *   background caches schedule through them; without the shim they throw on Safari.
 */
/**
 * Chromium's File System Access pickers are hidden from the editor, so every browser takes the same
 * path: Freecut falls back to its portable flows, and nothing is written to or read from a local
 * folder behind Frameleaf's back (exports and bundles go to the host; media comes from the library).
 */
export function hideFileSystemPickers(target: typeof globalThis = globalThis): void {
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    if (name in target) {
      Object.defineProperty(target, name, { value: undefined, configurable: true, writable: true })
    }
  }
}

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
