import { CloudMlJobActivityStage, CloudMlJobPurpose, Outcome } from '@immich/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityCloudJob } from '$lib/frameleaf/activity';
import {
  billingValues,
  cloudCostFacts,
  cloudJobRefusal,
  estimateLive,
  estimateRange,
  isEndedStage,
  runHeadKey,
} from '$lib/frameleaf/cloud-jobs';

const cloud = (cost: Partial<ActivityCloudJob['cost']> = {}): ActivityCloudJob => ({
  model: 'Restore XL',
  purpose: CloudMlJobPurpose.Restoration,
  preview: false,
  plannedWorkers: 2,
  workers: 2,
  cost: {
    estimatedUsd: 1.2,
    estimatedHighUsd: 1.6,
    holdUsd: 1.6,
    soFarUsd: null,
    settledUsd: null,
    outcome: null,
    ...cost,
  },
});

// The SDK's HttpError comes from its fetch runtime; a response error here is any error with a status.
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  isHttpError: (error: unknown) => error instanceof Error && 'status' in error,
}));

const httpError = (status: number, code?: string) =>
  Object.assign(new Error('refused'), { status, data: code ? { code } : {} });

describe('Frameleaf Cloud job helpers (FL-162)', () => {
  it('shows an estimate as a range, never a single price', () => {
    expect(estimateRange(1.2, 1.6)).toBe('$1.20–$1.60');
  });

  it('bills metered GPU time per minute plus a start fee per worker', () => {
    expect(billingValues({ perSecondUsd: 0.0013, startFeeUsd: 0.1, plannedWorkers: 5 })).toEqual({
      rate: expect.stringContaining('$0.07'),
      fee: '$0.10',
      workers: 5,
    });
  });

  it('knows when an estimate lapsed', () => {
    const now = Date.parse('2026-09-26T12:00:00.000Z');
    expect(estimateLive({ expiresAt: '2026-09-26T12:10:00.000Z' }, now)).toBe(true);
    expect(estimateLive({ expiresAt: '2026-09-26T11:59:59.000Z' }, now)).toBe(false);
  });

  it('sorts refusals: model back to the slider, estimate again, money shown as it is', () => {
    expect(cloudJobRefusal(httpError(409, 'model-mismatch'))).toBe('model');
    expect(cloudJobRefusal(httpError(409, 'estimate-expired'))).toBe('estimate');
    expect(cloudJobRefusal(httpError(409, 'consent-version-outdated'))).toBe('estimate');
    expect(cloudJobRefusal(httpError(402))).toBe('money');
    expect(cloudJobRefusal(httpError(500))).toBe('other');
    expect(cloudJobRefusal(new Error('offline'))).toBe('other');
  });

  it('names the run heading for each stage and knows the ended ones', () => {
    expect(runHeadKey(CloudMlJobActivityStage.Starting)).toBe('frameleaf_cloud_job_run_starting');
    expect(isEndedStage(CloudMlJobActivityStage.Done)).toBe(true);
    expect(isEndedStage(CloudMlJobActivityStage.Cancelled)).toBe(true);
    expect(isEndedStage(CloudMlJobActivityStage.Paused)).toBe(false);
  });

  it('shows the model, the estimate, what was metered so far and the hold while it runs', () => {
    expect(cloudCostFacts(cloud(), 'queued')).toEqual([
      { labelKey: 'frameleaf_activity_cloud_model', value: 'Restore XL' },
      { labelKey: 'frameleaf_activity_cloud_estimated', value: '$1.20–$1.60' },
      { labelKey: 'frameleaf_activity_cloud_so_far', value: null, valueKey: 'frameleaf_activity_cloud_so_far_none' },
      { labelKey: 'frameleaf_activity_cloud_held', value: '$1.60' },
    ]);
    expect(cloudCostFacts(cloud({ soFarUsd: 0.4 }), 'running')[2]).toEqual({
      labelKey: 'frameleaf_activity_cloud_so_far',
      value: '$0.40',
      valueKey: undefined,
    });
  });

  it('shows Settling until Frameleaf Cloud settles, then the charge or No charge', () => {
    expect(cloudCostFacts(cloud(), 'done')[2]).toEqual({
      labelKey: 'frameleaf_activity_cloud_settled',
      value: null,
      valueKey: 'frameleaf_activity_cloud_settling',
    });
    expect(cloudCostFacts(cloud({ settledUsd: 1.31, outcome: Outcome.Charged }), 'done')[2]).toEqual({
      labelKey: 'frameleaf_activity_cloud_settled',
      value: '$1.31',
      valueKey: undefined,
    });
    expect(cloudCostFacts(cloud({ settledUsd: 0, outcome: Outcome.NotCharged }), 'failed')[2]).toEqual({
      labelKey: 'frameleaf_activity_cloud_settled',
      value: null,
      valueKey: 'frameleaf_activity_cloud_no_charge',
    });
    // an ended job holds nothing, so the hold is not shown
    expect(cloudCostFacts(cloud({ settledUsd: 1.31 }), 'done')).toHaveLength(3);
  });
});
