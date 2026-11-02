import type { StudioExportBatchCreateDto } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { deliverySubmission } from './export-batch';

const body = {
  expectedRevision: 3,
  destination: 'local',
  variants: [{ shape: 'landscape', format: 'mp4-h264', color: 'preserve', resolution: '1080p' }],
} as Omit<StudioExportBatchCreateDto, 'requestKey'>;
describe('reviewed delivery submission', () => {
  it('keeps exactly the same immutable payload and key after a lost response or partial admission', () => {
    const first = deliverySubmission('project', body, null);
    expect(deliverySubmission('project', structuredClone(body), first)).toBe(first);
    expect(first.body.requestKey).toBeTruthy();
  });
  it('refuses source revision or settings changes during a retry instead of duplicating accepted jobs', () => {
    const first = deliverySubmission('project', body, null);
    expect(() => deliverySubmission('project', { ...body, expectedRevision: 4 }, first)).toThrow(
      'studio_export_batch_changed',
    );
    expect(() => deliverySubmission('other-project', body, first)).toThrow('studio_export_batch_changed');
    expect(() => deliverySubmission('project', { ...body, variants: [] }, first)).toThrow(
      'studio_export_batch_changed',
    );
  });
});
