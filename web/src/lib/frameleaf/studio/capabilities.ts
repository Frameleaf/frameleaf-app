/**
 * What this deployment can actually run (FL-88 consumer, FL-84/FL-91 owner).
 *
 * Full Studio needs a compatible GPU on the server or a configured worker; ordinary library
 * use and the quick editor stay GPU-free and must never be made to depend on one. The
 * server does not publish worker capabilities yet — `ServerFeaturesDto` has no Studio row —
 * so this probe reports every capability as absent, and the route renders the unavailable
 * state naming exactly which workers are missing.
 *
 * That is the honest answer for this checkout rather than a placeholder: there is no worker
 * here, and reporting one would be the "coming soon" substitution the execution guide
 * forbids. When the capability endpoint lands with the Studio worker admission work, this
 * function is the single place that changes; nothing downstream assumes the values are
 * static.
 */

import { emptyStudioCapabilities, type StudioCapabilities } from './host-contract';

export const probeStudioCapabilities = async (): Promise<StudioCapabilities> =>
  // Async by contract: the real probe is a request, and callers must already await it.
  Promise.resolve(emptyStudioCapabilities());
