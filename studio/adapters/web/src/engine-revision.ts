/**
 * The pinned Freecut revision this build was prepared from, injected by `vite.config.mjs` from
 * `studio/engine-build.json`. The host refuses a frame that announces any other revision
 * (`engine-loader.ts`).
 */
declare const __FRAMELEAF_ENGINE_REVISION__: string

export const ENGINE_REVISION: string = __FRAMELEAF_ENGINE_REVISION__
