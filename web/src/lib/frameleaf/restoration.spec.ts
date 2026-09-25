import {
  AssetRestorationStatus,
  MlAdmissionRefusal,
  MlDestinationHealth,
  MlDestinationKind,
  type AssetRestorationDestinationDto,
} from '@immich/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  CENTRE_REGION,
  abandonedResultKeptUntil,
  anyRestorationBusy,
  canDecideRestoration,
  canDiscardRestoration,
  canSelectRestoration,
  compareKindFor,
  defaultDestinationId,
  formatEstimateSeconds,
  isFullCropRect,
  isOutputCapped,
  isRestorationBusy,
  orderedDestinations,
  regionFromCrop,
  restorationStatusTone,
  retryOperationIdFor,
} from '$lib/frameleaf/restoration';

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { params: {} } }));

const destination = (overrides: Partial<AssetRestorationDestinationDto> = {}): AssetRestorationDestinationDto => ({
  id: 'local',
  kind: MlDestinationKind.Local,
  name: 'This server',
  health: MlDestinationHealth.Healthy,
  available: true,
  leavesNetwork: false,
  consentRequired: false,
  consentGranted: true,
  refusal: null,
  refusalDetail: null,
  estimate: {
    sampleCount: 0,
    bytesPerSecond: null,
    windowDays: 30,
    previewBytes: 0,
    fullBytes: 0,
    previewSeconds: null,
    fullSeconds: null,
  },
  ...overrides,
});

describe('restoration presentation rules (FL-115)', () => {
  it('knows which states are busy, decidable, selectable and discardable', () => {
    expect(isRestorationBusy(AssetRestorationStatus.PreviewRendering)).toBe(true);
    expect(isRestorationBusy(AssetRestorationStatus.Accepted)).toBe(true);
    expect(isRestorationBusy(AssetRestorationStatus.PreviewReady)).toBe(false);
    expect(
      anyRestorationBusy([{ status: AssetRestorationStatus.Rejected }, { status: AssetRestorationStatus.Restoring }]),
    ).toBe(true);
    expect(canDecideRestoration(AssetRestorationStatus.PreviewReady)).toBe(true);
    expect(canDecideRestoration(AssetRestorationStatus.Restored)).toBe(false);
    expect(canSelectRestoration({ status: AssetRestorationStatus.Restored, hasResult: true })).toBe(true);
    expect(canSelectRestoration({ status: AssetRestorationStatus.Restored, hasResult: false })).toBe(false);
    expect(canSelectRestoration({ status: AssetRestorationStatus.PreviewReady, hasResult: false })).toBe(false);
    expect(canDiscardRestoration(AssetRestorationStatus.Expired)).toBe(false);
    expect(canDiscardRestoration(AssetRestorationStatus.Rejected)).toBe(true);
  });

  it('shows the retention date of a stopped full render only', () => {
    const resultExpiresAt = '2026-10-02T00:00:00.000Z';
    expect(abandonedResultKeptUntil({ status: AssetRestorationStatus.RestoreFailed, resultExpiresAt })).toBe(
      resultExpiresAt,
    );
    expect(abandonedResultKeptUntil({ status: AssetRestorationStatus.RestoreCancelled, resultExpiresAt })).toBe(
      resultExpiresAt,
    );
    expect(abandonedResultKeptUntil({ status: AssetRestorationStatus.Restored, resultExpiresAt })).toBeNull();
    expect(
      abandonedResultKeptUntil({ status: AssetRestorationStatus.RestoreFailed, resultExpiresAt: null }),
    ).toBeNull();
  });

  it('retries the job of the stage that failed, and nothing else', () => {
    const ids = { previewOperationId: 'preview-op', fullOperationId: 'full-op' };
    expect(retryOperationIdFor({ status: AssetRestorationStatus.PreviewFailed, ...ids })).toBe('preview-op');
    expect(retryOperationIdFor({ status: AssetRestorationStatus.PreviewCancelled, ...ids })).toBe('preview-op');
    expect(retryOperationIdFor({ status: AssetRestorationStatus.RestoreFailed, ...ids })).toBe('full-op');
    expect(retryOperationIdFor({ status: AssetRestorationStatus.PreviewReady, ...ids })).toBeNull();
    expect(retryOperationIdFor({ status: AssetRestorationStatus.Restoring, ...ids })).toBeNull();
  });

  it('offers the result comparison once restored and the preview comparison while the preview exists', () => {
    expect(compareKindFor({ status: AssetRestorationStatus.Restored, hasPreview: true, hasResult: true })).toBe(
      'result',
    );
    expect(compareKindFor({ status: AssetRestorationStatus.PreviewReady, hasPreview: true, hasResult: false })).toBe(
      'preview',
    );
    expect(compareKindFor({ status: AssetRestorationStatus.Rejected, hasPreview: true, hasResult: false })).toBe(
      'preview',
    );
    expect(compareKindFor({ status: AssetRestorationStatus.Expired, hasPreview: false, hasResult: false })).toBeNull();
    expect(
      compareKindFor({ status: AssetRestorationStatus.PreviewRendering, hasPreview: false, hasResult: false }),
    ).toBeNull();
  });

  it('tones the status without carrying meaning by colour alone', () => {
    expect(restorationStatusTone(AssetRestorationStatus.Restoring)).toBe('busy');
    expect(restorationStatusTone(AssetRestorationStatus.PreviewReady)).toBe('ready');
    expect(restorationStatusTone(AssetRestorationStatus.Restored)).toBe('done');
    expect(restorationStatusTone(AssetRestorationStatus.RestoreFailed)).toBe('failed');
    expect(restorationStatusTone(AssetRestorationStatus.Rejected)).toBe('neutral');
  });

  it('orders destinations admissible first, local before cloud, and never hides a refused one', () => {
    const cloud = destination({
      id: 'cloud',
      kind: MlDestinationKind.FrameleafCloud,
      name: 'Frameleaf Cloud',
      available: false,
      leavesNetwork: true,
      consentRequired: true,
      consentGranted: false,
      refusal: MlAdmissionRefusal.ConsentMissing,
    });
    const lan = destination({ id: 'lan', kind: MlDestinationKind.Lan, name: 'Workshop GPU' });
    const localDown = destination({ id: 'local', available: false, refusal: MlAdmissionRefusal.DestinationUnhealthy });
    const ordered = orderedDestinations([cloud, localDown, lan]);
    expect(ordered.map((item) => item.id)).toEqual(['lan', 'local', 'cloud']);
  });

  it('defaults to a destination that keeps media on the network, keeping a still-admissible previous choice', () => {
    const cloud = destination({
      id: 'cloud',
      kind: MlDestinationKind.FrameleafCloud,
      leavesNetwork: true,
      consentRequired: true,
    });
    const lan = destination({ id: 'lan', kind: MlDestinationKind.Lan });
    expect(defaultDestinationId([cloud, lan], null)).toBe('lan');
    expect(defaultDestinationId([cloud, lan], 'cloud')).toBe('cloud');
    expect(defaultDestinationId([cloud, lan], 'gone')).toBe('lan');
    // Only a cloud destination available: nothing is chosen for the person.
    expect(defaultDestinationId([cloud], null)).toBeNull();
    expect(defaultDestinationId([destination({ available: false })], null)).toBeNull();
  });

  it('reports when the 4K cap reduced the requested upscale', () => {
    expect(
      isOutputCapped({ sourceWidth: 1920, sourceHeight: 1080, outputWidth: 3840, outputHeight: 2160, upscale: 2 }),
    ).toBe(false);
    expect(
      isOutputCapped({ sourceWidth: 6000, sourceHeight: 4000, outputWidth: 3240, outputHeight: 2160, upscale: 2 }),
    ).toBe(true);
  });

  it('turns an editor crop into a valid preview area', () => {
    expect(regionFromCrop({ x: 0.2, y: 0.3, w: 0.4, h: 0.5 })).toEqual({ x: 0.2, y: 0.3, w: 0.4, h: 0.5 });
    // Too narrow: widened to the minimum and kept inside the frame.
    expect(regionFromCrop({ x: 0.95, y: 0.95, w: 0.02, h: 0.02 })).toEqual({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 });
    expect(isFullCropRect({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
    expect(isFullCropRect(CENTRE_REGION)).toBe(false);
  });

  it('formats measured estimates and says nothing when nothing is measured', () => {
    expect(formatEstimateSeconds(null, 'en')).toBeNull();
    expect(formatEstimateSeconds(0.4, 'en')).toBe('1 second');
    expect(formatEstimateSeconds(45, 'en')).toBe('45 seconds');
    expect(formatEstimateSeconds(150, 'en')).toBe('3 minutes');
    expect(formatEstimateSeconds(7200, 'en')).toBe('2 hours');
  });
});
