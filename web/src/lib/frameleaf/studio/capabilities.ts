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
 * `gpuWorker` and `renderWorker` come from render worker admission (FL-95, FL-104, FL-42):
 * the server reports them only while an admitted worker session is live, unrevoked and still
 * backed by fresh conformance evidence on the engine digest its worker is qualified with; it
 * never infers one from an ML endpoint. A request failure reports every capability as absent,
 * because a capability the server did not confirm is not one the route may claim.
 */
import { getMlCapabilities, type StudioCapabilitiesDto } from '@immich/sdk';
import { emptyStudioCapabilities, type StudioCapabilities, type StudioRenderEvidence } from './host-contract';

/**
 * Only a literal `true` confirms a capability: a missing or malformed field is absent. The server
 * snapshot has no analysis or generation row yet, so those stay false.
 */
/** The snapshot crosses the network, so its declared booleans are checked, not trusted. */
const confirmed = (value: unknown): boolean => value === true;

export const toStudioCapabilities = (studio: StudioCapabilitiesDto): StudioCapabilities => ({
  analysisWorker: false,
  generationWorker: false,
  gpuWorker: confirmed(studio.gpuWorker),
  renderWorker: confirmed(studio.renderWorker),
  restorationWorker: confirmed(studio.restorationWorker),
  transcriptionWorker: confirmed(studio.transcriptionWorker),
});

export const probeStudioCapabilities = async (): Promise<StudioCapabilities> => (await probeStudioHost()).capabilities;

/**
 * FL-42: the render evidence of the same snapshot, for the export sheet. A row whose fields are not
 * what the contract says is dropped rather than trusted, so nothing unverified enables an export.
 */
export const toStudioRenderEvidence = (studio: Pick<StudioCapabilitiesDto, 'render'>): StudioRenderEvidence[] =>
  (Array.isArray(studio.render) ? studio.render : []).filter(
    (row) =>
      !!row &&
      typeof row.destination === 'string' &&
      typeof row.sessions === 'number' &&
      (row.gpuMemoryBytes === null || typeof row.gpuMemoryBytes === 'number') &&
      Array.isArray(row.codecs) &&
      typeof row.maxBitDepth === 'number' &&
      typeof row.hdr10 === 'boolean' &&
      typeof row.dolbyVision === 'boolean',
  );

/** Capabilities and render evidence from one request; a failure reports neither. */
export const probeStudioHost = async (): Promise<{
  capabilities: StudioCapabilities;
  renderEvidence: StudioRenderEvidence[];
}> => {
  try {
    const { studio } = await getMlCapabilities();
    return { capabilities: toStudioCapabilities(studio), renderEvidence: toStudioRenderEvidence(studio) };
  } catch {
    return { capabilities: emptyStudioCapabilities(), renderEvidence: [] };
  }
};
