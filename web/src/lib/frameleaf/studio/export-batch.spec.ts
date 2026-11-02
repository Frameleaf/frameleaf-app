import type { StudioExportBatchCreateDto, StudioExportCreateDto } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { deliverySubmission } from './export-batch';

const batch = {
  expectedRevision: 3,
  destination: 'local',
  variants: [{ shape: 'vertical', format: 'mp4-h264', color: 'preserve', resolution: '1080p' }],
} as Omit<StudioExportBatchCreateDto, 'requestKey'>;
const original = {
  expectedRevision: 3,
  destination: 'local',
  format: 'mp4-h264',
  color: 'preserve',
  resolution: '1080p',
} as Omit<StudioExportCreateDto, 'requestKey'>;
const request = { batch, original };

describe('reviewed delivery submission', () => {
  it('keeps exactly the same immutable payload and keys after a lost response or partial admission', () => {
    const first = deliverySubmission('project', request, null);
    expect(deliverySubmission('project', structuredClone(request), first)).toBe(first);
    expect(first.batch!.requestKey).toBeTruthy();
    expect(first.original!.requestKey).toBeTruthy();
    expect(first.original!.requestKey).not.toBe(first.batch!.requestKey);
  });
  it('queues Original on its own when no reframed shape is chosen', () => {
    const first = deliverySubmission('project', { batch: null, original }, null);
    expect(first.batch).toBeNull();
    expect(first.original).toMatchObject({ format: 'mp4-h264' });
  });
  it('refuses source revision or settings changes during a retry instead of duplicating accepted jobs', () => {
    const first = deliverySubmission('project', request, null);
    expect(() =>
      deliverySubmission('project', { ...request, batch: { ...batch, expectedRevision: 4 } }, first),
    ).toThrow('studio_export_batch_changed');
    expect(() => deliverySubmission('other-project', request, first)).toThrow('studio_export_batch_changed');
    expect(() => deliverySubmission('project', { ...request, batch: { ...batch, variants: [] } }, first)).toThrow(
      'studio_export_batch_changed',
    );
    expect(() => deliverySubmission('project', { ...request, original: null }, first)).toThrow(
      'studio_export_batch_changed',
    );
  });
});
