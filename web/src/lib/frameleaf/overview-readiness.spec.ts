import {
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkload,
  type MlDestinationResponseDto,
  type MlWorkloadRouteDto,
} from '@immich/sdk';
import { cloudDestinationState, gpuStudioState, mlEndpointState } from '$lib/frameleaf/overview-readiness';

const destination = (id: string, kind: MlDestinationKind, status: MlDestinationHealth) =>
  ({ id, kind, health: { status } }) as MlDestinationResponseDto;
const route = (workload: MlWorkload, destinationId: string | null): MlWorkloadRouteDto => ({
  workload,
  destinationId,
});

describe('Overview readiness (FL-71 CC-9)', () => {
  it('reads the ML endpoint from the destinations library analysis is routed to', () => {
    const local = destination('local', MlDestinationKind.Local, MlDestinationHealth.Healthy);
    const lan = destination('lan', MlDestinationKind.Lan, MlDestinationHealth.Unhealthy);
    const fresh = destination('fresh', MlDestinationKind.Local, MlDestinationHealth.Unknown);

    expect(mlEndpointState([local, lan], [route(MlWorkload.Clip, 'local')])).toBe('reachable');
    expect(mlEndpointState([local, lan], [route(MlWorkload.Clip, 'local'), route(MlWorkload.Face, 'lan')])).toBe(
      'unreachable',
    );
    expect(mlEndpointState([fresh], [route(MlWorkload.Ocr, 'fresh')])).toBe('unchecked');
    // Restoration routes are not the library endpoint.
    expect(mlEndpointState([lan], [route(MlWorkload.RestorationFaithful, 'lan')])).toBe('none');
  });

  it('names Frameleaf Cloud only when library analysis is routed to it', () => {
    const pod = destination('pod', MlDestinationKind.FrameleafCloud, MlDestinationHealth.Healthy);
    const local = destination('local', MlDestinationKind.Local, MlDestinationHealth.Healthy);
    expect(cloudDestinationState([pod, local], [route(MlWorkload.Clip, 'local')])).toBe('local');
    expect(cloudDestinationState([pod, local], [route(MlWorkload.Enrichment, 'pod')])).toBe('frameleaf');
  });

  it('asks for a compatibility check while any render kind lacks a qualified worker', () => {
    expect(gpuStudioState({ qualified: [], unavailable: [] })).toBe('qualified');
    expect(gpuStudioState({ qualified: [], unavailable: ['quick_edit'] as never })).toBe('check');
  });
});
