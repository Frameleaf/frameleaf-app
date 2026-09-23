/**
 * What this deployment can actually run (FL-88 consumer, FL-110 owner).
 *
 * Full Studio needs a compatible GPU on the server or a configured worker; ordinary library
 * use and the quick editor stay GPU-free and must never be made to depend on one. The
 * server publishes its capability snapshot at `GET /ml-destinations/capabilities`, built from
 * the last health probe of every configured destination: a workload is available only when
 * a destination is enabled, consented, allowed to run it, probed healthy and reporting that
 * it serves it. The Studio row of that snapshot is what this probe returns.
 *
 * `gpuWorker` and `renderWorker` stay false until the render worker admission (FL-95,
 * FL-104) reports one; the destination service has no evidence of a render worker and says
 * so rather than inferring one from an ML endpoint. A request failure reports every
 * capability as absent, because a capability the server did not confirm is not one the
 * route may claim.
 */
import { getMlCapabilities, type StudioCapabilitiesDto } from '@immich/sdk';
import { emptyStudioCapabilities, type StudioCapabilities } from './host-contract';

export const toStudioCapabilities = (studio: StudioCapabilitiesDto): StudioCapabilities => ({
  analysisWorker: false,
  generationWorker: false,
  gpuWorker: studio.gpuWorker,
  renderWorker: studio.renderWorker,
  restorationWorker: studio.restorationWorker,
  transcriptionWorker: studio.transcriptionWorker,
});

export const probeStudioCapabilities = async (): Promise<StudioCapabilities> => {
  try {
    const { studio } = await getMlCapabilities();
    return toStudioCapabilities(studio);
  } catch {
    return emptyStudioCapabilities();
  }
};
