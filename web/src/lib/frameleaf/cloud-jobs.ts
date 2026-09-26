/**
 * Frameleaf Cloud restoration and Smooth motion jobs (FL-162, `CLD-202`): the helpers behind the
 * confirmation dialog (`CloudJobDialog.svelte`, prototype `CloudJobDialog.jsx` and `cloud-jobs.mjs`)
 * and the cost facts on an Activity row (prototype `Activity.jsx` `CloudCost`). The server decides
 * every figure: an estimate is metered GPU time × rate + a start fee per worker, shown as a p50–p90
 * range; per-photo and per-minute figures are estimates, never prices. Amounts are always USD.
 */
import { CloudMlJobActivityStage, Outcome, isHttpError, type CloudMlJobEstimateResponseDto } from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import type { ActivityCloudJob, ActivityStage } from '$lib/frameleaf/activity';
import { formatRatePerMinute, formatUsd } from '$lib/frameleaf/cloud-ml';

/** "$1.20–$1.60": the typical to high-end range, start fees included. */
export const estimateRange = (low: number, high: number) => `${formatUsd(low)}–${formatUsd(high)}`;

/**
 * The billing basis the dialog shows ("GPU time × $0.0780 per minute + $0.10 start fee × 5
 * workers"), as values for its translation: the rate per minute, one start fee, and the workers.
 */
export const billingValues = (
  estimate: Pick<CloudMlJobEstimateResponseDto, 'perSecondUsd' | 'startFeeUsd' | 'plannedWorkers'>,
) => ({
  rate: formatRatePerMinute(estimate.perSecondUsd),
  fee: formatUsd(estimate.startFeeUsd),
  workers: estimate.plannedWorkers,
});

/**
 * What an estimate or confirmation refusal asks of the person (FL-162). `model` goes back to the
 * model slider (409 `model-mismatch`), `estimate` estimates again (409 `estimate-expired`, or the
 * terms changed), `money` shows the refusal as it is (402: never a lighter model), and anything else
 * is shown as an error.
 */
export type CloudJobRefusal = 'model' | 'estimate' | 'money' | 'other';

export const cloudJobRefusal = (error: unknown): CloudJobRefusal => {
  if (!isHttpError(error)) {
    return 'other';
  }
  const code = (error.data as { code?: unknown } | undefined)?.code;
  if (error.status === 402) {
    return 'money';
  }
  if (error.status === 409 && code === 'model-mismatch') {
    return 'model';
  }
  if (error.status === 409 && (code === 'estimate-expired' || code === 'consent-version-outdated')) {
    return 'estimate';
  }
  return 'other';
};

/** Whether an estimate's sealed price still holds: after `expiresAt` it is estimated again. */
export const estimateLive = (estimate: Pick<CloudMlJobEstimateResponseDto, 'expiresAt'>, now = Date.now()) =>
  Date.parse(estimate.expiresAt) > now;

/** The heading the dialog shows while the job runs (prototype `RUN_HEAD`). */
export const runHeadKey = (stage: CloudMlJobActivityStage | ActivityStage): Translations =>
  `frameleaf_cloud_job_run_${stage}` as Translations;

/** Stages the dialog stops following at. */
export const isEndedStage = (stage: CloudMlJobActivityStage | ActivityStage) =>
  stage === CloudMlJobActivityStage.Done ||
  stage === CloudMlJobActivityStage.Failed ||
  stage === CloudMlJobActivityStage.Cancelled;

export type CloudCostFact = { labelKey: Translations; value: string | null; valueKey?: Translations };

/**
 * The cost facts of a Frameleaf Cloud job in Activity (prototype `CloudCost`): the model, the
 * confirmed estimate, then what was metered so far and held while it runs, or what was settled once
 * it ended ("Settling…" until Frameleaf Cloud settles it, "No charge" when the hold went back).
 */
export const cloudCostFacts = (cloud: ActivityCloudJob, stage: ActivityStage): CloudCostFact[] => {
  const facts: CloudCostFact[] = [
    { labelKey: 'frameleaf_activity_cloud_model', value: cloud.model },
    {
      labelKey: 'frameleaf_activity_cloud_estimated',
      value: estimateRange(cloud.cost.estimatedUsd, cloud.cost.estimatedHighUsd),
    },
  ];
  if (stage === 'done' || stage === 'failed' || stage === 'cancelled') {
    const settled = cloud.cost.settledUsd;
    let valueKey: Translations | undefined;
    if (settled === null) {
      valueKey = 'frameleaf_activity_cloud_settling';
    } else if (cloud.cost.outcome === Outcome.NotCharged) {
      valueKey = 'frameleaf_activity_cloud_no_charge';
    }
    facts.push({
      labelKey: 'frameleaf_activity_cloud_settled',
      value: valueKey || settled === null ? null : formatUsd(settled),
      valueKey,
    });
    return facts;
  }
  const soFar = cloud.cost.soFarUsd;
  facts.push(
    {
      labelKey: 'frameleaf_activity_cloud_so_far',
      value: soFar === null ? null : formatUsd(soFar),
      valueKey: soFar === null ? 'frameleaf_activity_cloud_so_far_none' : undefined,
    },
    { labelKey: 'frameleaf_activity_cloud_held', value: formatUsd(cloud.cost.holdUsd) },
  );
  return facts;
};
