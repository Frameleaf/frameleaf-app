import {
  MediaOperationKind,
  MediaOperationStatus,
  PreservationPackageStatus,
  PreservationRestoreStatus,
  PreservationSupportCategory,
  PreservationSupportLevel,
  PreservationVerificationStatus,
  type MediaOperationDto,
  type PreservationPackageDto,
} from '@immich/sdk';
import {
  defaultPackageName,
  emptyScope,
  findingKey,
  groupSupport,
  hasRoomFor,
  isOperationActive,
  packageState,
  pollDelay,
  reasonKey,
  restoreState,
  restoreStep,
  scopeToRequest,
  supportLevelKey,
} from './preservation';

const operation = (status: MediaOperationStatus, kind = MediaOperationKind.PreservationExport) =>
  ({ status, kind }) as MediaOperationDto;

const packageOf = (overrides: Partial<PreservationPackageDto> = {}) =>
  ({
    status: PreservationPackageStatus.Ready,
    operation: null,
    verification: null,
    ...overrides,
  }) as PreservationPackageDto;

describe('scopeToRequest', () => {
  it('asks for the whole library, favourites or chosen albums', () => {
    expect(scopeToRequest(emptyScope())).toEqual({ filter: {} });
    expect(scopeToRequest({ ...emptyScope(), kind: 'favorites' })).toEqual({ filter: { isFavorite: { eq: true } } });
    expect(scopeToRequest({ ...emptyScope(), kind: 'albums', albumIds: ['a', 'b'] })).toEqual({
      filter: { albumIds: { any: ['a', 'b'] } },
    });
  });

  it('turns days into an inclusive range of when the photos were taken', () => {
    expect(scopeToRequest({ ...emptyScope(), kind: 'dates', from: '2024-01-01', to: '2024-12-31' })).toEqual({
      filter: { takenAt: { gte: '2024-01-01T00:00:00.000Z', lt: '2025-01-01T00:00:00.000Z' } },
    });
    expect(scopeToRequest({ ...emptyScope(), kind: 'dates', from: '2024-05-01', to: '' })).toEqual({
      filter: { takenAt: { gte: '2024-05-01T00:00:00.000Z' } },
    });
  });

  it('asks nothing of a selection that is not finished', () => {
    expect(scopeToRequest({ ...emptyScope(), kind: 'albums' })).toBeNull();
    expect(scopeToRequest({ ...emptyScope(), kind: 'dates' })).toBeNull();
    expect(scopeToRequest({ ...emptyScope(), kind: 'dates', from: '2025-01-01', to: '2024-01-01' })).toBeNull();
    expect(scopeToRequest({ ...emptyScope(), kind: 'dates', from: 'yesterday' })).toBeNull();
  });

  it('names a package after its selection', () => {
    const today = new Date('2026-09-23T10:00:00.000Z');
    expect(defaultPackageName(emptyScope(), today)).toBe('Library 2026-09-23');
    expect(defaultPackageName({ ...emptyScope(), kind: 'dates', from: '2024-01-01', to: '2024-12-31' }, today)).toBe(
      'Photos 2024-01-01 to 2024-12-31',
    );
  });
});

describe('job state', () => {
  it('polls while a job runs, slower while it is paused, and not at all when everything is done', () => {
    expect(isOperationActive(operation(MediaOperationStatus.Rendering))).toBe(true);
    expect(isOperationActive(null)).toBe(false);
    expect(pollDelay([operation(MediaOperationStatus.Rendering), null])).toBe(2500);
    expect(pollDelay([operation(MediaOperationStatus.Paused)])).toBe(10_000);
    expect(pollDelay([operation(MediaOperationStatus.Completed), undefined])).toBeNull();
  });

  it('never calls a written package verified until a verification says so', () => {
    expect(packageState(packageOf()).key).toBe('frameleaf_preservation_state_unverified');
    expect(
      packageState(
        packageOf({ verification: { status: PreservationVerificationStatus.Verified } as never }),
      ).key,
    ).toBe('frameleaf_preservation_state_verified');
    expect(
      packageState(packageOf({ verification: { status: PreservationVerificationStatus.Problems } as never })),
    ).toEqual({ key: 'frameleaf_preservation_state_problems', tone: 'danger' });
  });

  it('shows the running job before the files', () => {
    expect(packageState(packageOf({ operation: operation(MediaOperationStatus.Rendering) })).key).toBe(
      'frameleaf_preservation_state_running_preservation_export',
    );
    expect(packageState(packageOf({ operation: operation(MediaOperationStatus.Paused) })).key).toBe(
      'frameleaf_preservation_state_paused',
    );
    expect(packageState(packageOf({ status: PreservationPackageStatus.Incomplete })).tone).toBe('warning');
  });

  it('reopens a restoration where it was left', () => {
    expect(restoreStep(null)).toBe(0);
    expect(restoreStep({ status: PreservationRestoreStatus.Reviewing })).toBe(1);
    expect(restoreStep({ status: PreservationRestoreStatus.Ready })).toBe(2);
    expect(restoreStep({ status: PreservationRestoreStatus.Completed })).toBe(3);
    expect(restoreState({ status: PreservationRestoreStatus.Ready, operation: null }).key).toBe(
      'frameleaf_preservation_restore_state_ready',
    );
  });
});

describe('copy', () => {
  it('translates known reasons and findings, and says something honest about the rest', () => {
    expect(reasonKey('asset_in_trash')).toBe('frameleaf_preservation_reason_asset_in_trash');
    expect(reasonKey('something_new')).toBe('frameleaf_preservation_reason_other');
    expect(reasonKey(null)).toBeNull();
    expect(findingKey('generated_description_provenance')).toBe(
      'frameleaf_preservation_finding_generated_description_provenance',
    );
    expect(findingKey('unheard_of')).toBe('frameleaf_preservation_finding_other');
    expect(supportLevelKey(PreservationSupportLevel.ProvenanceOnly)).toBe(
      'frameleaf_preservation_support_provenance_only',
    );
  });

  it('groups what a restoration brings back by how it does', () => {
    const groups = groupSupport([
      { category: PreservationSupportCategory.Originals, level: PreservationSupportLevel.Restored },
      { category: PreservationSupportCategory.GeneratedMoments, level: PreservationSupportLevel.ProvenanceOnly },
      { category: PreservationSupportCategory.MomentNotes, level: PreservationSupportLevel.RestoredWhenEmpty },
    ]);
    expect(groups.map((group) => group.level)).toEqual([
      PreservationSupportLevel.Restored,
      PreservationSupportLevel.RestoredWhenEmpty,
      PreservationSupportLevel.ProvenanceOnly,
    ]);
  });

  it('compares free space with the package size only when both are known', () => {
    expect(hasRoomFor('100', '200')).toBe(true);
    expect(hasRoomFor('300', '200')).toBe(false);
    expect(hasRoomFor('100', null)).toBeNull();
  });
});
