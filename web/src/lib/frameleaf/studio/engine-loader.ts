/**
 * Resolving the vendored React editor (FL-88).
 *
 * `studio/vendor/freecut` is a provenance-checked snapshot and `studio/adapters/web` is the
 * adapter package that wraps it. Neither is present in this checkout: `studio/` currently
 * holds metadata only (`studio/README.md` says so explicitly). The host therefore cannot
 * static-import the engine, and must not pretend it exists.
 *
 * So the engine arrives through registration rather than through an import path. When the
 * adapter package lands it calls `registerStudioEngine` once from its own entry point, and
 * the host picks it up without any change here. Until then `loadStudioEngine` answers
 * `absent`, and the route renders an honest unavailable state that names what is missing.
 *
 * The loader also refuses a module whose `engineRevision` is not the pinned one, so a
 * stale or substituted bundle cannot mount and be mistaken for the qualified engine.
 */

import type { StudioEngineModule } from './host-contract';

/**
 * The immutable upstream Freecut revision recorded in `studio/freecut-provenance.json`
 * (`commit`) and in `studio/dependency-attribution.json` (`engineRevision`). Keep the three
 * in step; the metadata files are the source of truth and the integration owner changes
 * them, not this constant on its own.
 */
export const pinnedFreecutRevision = '4d62e8082c5eb387a96275bcbd323d28f6e41a62';

export type StudioEngineFactory = () => Promise<StudioEngineModule>;

let factory: StudioEngineFactory | null = null;

/**
 * Called once by `studio/adapters/web` when it is part of the build. Registering twice is a
 * programming error: two engines in one page is exactly the uncontrolled global state the
 * React/Svelte boundary exists to prevent.
 */
export const registerStudioEngine = (register: StudioEngineFactory): void => {
  if (factory && factory !== register) {
    throw new TypeError('A Studio engine is already registered');
  }
  factory = register;
};

/** Test seam. Production code never unregisters an engine. */
export const clearStudioEngine = (): void => {
  factory = null;
};

export const isStudioEngineRegistered = (): boolean => factory !== null;

export type StudioEngineAbsenceReason = 'not-built' | 'revision-mismatch' | 'load-failed';

export type StudioEngineResolution =
  | { status: 'available'; module: StudioEngineModule }
  | {
      status: 'absent';
      reason: StudioEngineAbsenceReason;
      /** i18n key for the detail line under the unavailable heading. */
      messageKey: string;
      /** Present for `revision-mismatch` and `load-failed`, for the report and the log. */
      detail?: string;
    };

const absent = (reason: StudioEngineAbsenceReason, detail?: string): StudioEngineResolution => ({
  status: 'absent',
  reason,
  messageKey:
    reason === 'not-built'
      ? 'frameleaf_studio_engine_absent_body'
      : reason === 'revision-mismatch'
        ? 'frameleaf_studio_engine_mismatch_body'
        : 'frameleaf_studio_engine_failed_body',
  ...(detail === undefined ? {} : { detail }),
});

export const loadStudioEngine = async (): Promise<StudioEngineResolution> => {
  if (!factory) {
    return absent('not-built');
  }

  let module: StudioEngineModule;
  try {
    module = await factory();
  } catch (error) {
    return absent('load-failed', error instanceof Error ? error.message : String(error));
  }

  if (!module || typeof module.mount !== 'function') {
    return absent('load-failed', 'The registered Studio engine does not expose mount()');
  }

  if (module.engineRevision !== pinnedFreecutRevision) {
    return absent('revision-mismatch', `expected ${pinnedFreecutRevision}, got ${module.engineRevision}`);
  }

  return { status: 'available', module };
};
