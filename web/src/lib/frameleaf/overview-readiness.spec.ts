import {
  CloudLinkState,
  LicenseState,
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkload,
  type MlDestinationResponseDto,
  type MlWorkloadRouteDto,
} from '@frameleaf/sdk';
import { cloudGlance, gpuStudioState, mlEndpointState } from '$lib/frameleaf/overview-readiness';

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

  describe('Frameleaf Cloud tile (FL-168)', () => {
    const entitlements = {
      cloudBackup: false,
      cloudMl: false,
      frameleafCloud: false,
      remoteAccess: false,
      supporter: false,
    };
    const plan = { activatedAt: '2026-09-01T00:00:00.000Z', expiresAt: null, graceUntil: null } as never;

    it('says only that it is not set up when the server has no Frameleaf Cloud address', () => {
      expect(
        cloudGlance({ configured: false, state: CloudLinkState.NotConfigured, remoteAccessEnabled: false }, null),
      ).toEqual({ configured: false, attention: false });
    });

    it('reads an unlinked server as not linked, remote off, no plan', () => {
      expect(
        cloudGlance(
          { configured: true, state: CloudLinkState.Unlinked, remoteAccessEnabled: false },
          { state: LicenseState.None, plan: null, entitlements },
        ),
      ).toEqual({ configured: true, link: 'unlinked', remote: false, plan: 'none', attention: false });
      expect(
        cloudGlance({ configured: true, state: CloudLinkState.Revoked, remoteAccessEnabled: false }, null),
      ).toMatchObject({ link: 'unlinked', plan: 'none' });
      expect(
        cloudGlance({ configured: true, state: CloudLinkState.Pending, remoteAccessEnabled: false }, null),
      ).toMatchObject({ link: 'pending' });
    });

    it('reads a linked server with its remote access and plan', () => {
      expect(
        cloudGlance(
          { configured: true, state: CloudLinkState.Linked, remoteAccessEnabled: true },
          { state: LicenseState.Active, plan, entitlements },
        ),
      ).toEqual({ configured: true, link: 'linked', remote: true, plan: 'active', attention: false });
      expect(
        cloudGlance(
          { configured: true, state: CloudLinkState.Linked, remoteAccessEnabled: false },
          { state: LicenseState.None, plan: null, entitlements: { ...entitlements, supporter: true } },
        ),
      ).toMatchObject({ plan: 'supporter', attention: false });
    });

    it('needs attention in the grace period and once the plan has expired', () => {
      const linked = { configured: true, state: CloudLinkState.Linked, remoteAccessEnabled: true };
      expect(cloudGlance(linked, { state: LicenseState.Grace, plan, entitlements })).toMatchObject({
        plan: 'grace',
        attention: true,
      });
      expect(cloudGlance(linked, { state: LicenseState.Expired, plan, entitlements })).toMatchObject({
        plan: 'expired',
        attention: true,
      });
    });
  });

  it('asks for a compatibility check while any render kind lacks a qualified worker', () => {
    expect(gpuStudioState({ qualified: [], unavailable: [] })).toBe('qualified');
    expect(gpuStudioState({ qualified: [], unavailable: ['quick_edit'] as never })).toBe('check');
  });
});
