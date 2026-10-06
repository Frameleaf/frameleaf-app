/**
 * Frameleaf Cloud restoration and Smooth motion jobs (FL-162, `CLD-202`): the helpers behind the
 * confirmation dialog (`CloudJobDialog.svelte`, prototype `CloudJobDialog.jsx` and `cloud-jobs.mjs`)
 * and the cost facts on an Activity row (prototype `Activity.jsx` `CloudCost`). The server decides
 * every figure: an estimate is metered GPU time × rate + a start fee per worker, shown as a p50–p90
 * range; per-photo and per-minute figures are estimates, never prices. Amounts are always USD.
 */
import {
  CloudMlJobActivityStage,
  CloudMlJobCostOutcome,
  isHttpError,
  type CloudMlJobEstimateResponseDto,
} from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import { get } from 'svelte/store';
import type { ActivityCloudJob, ActivityStage } from '$lib/frameleaf/activity';
import { formatRatePerMinute, formatUsd } from '$lib/frameleaf/cloud-ml';
import { pausedRefusalMessage } from '$lib/frameleaf/cloud-paused';
import { locale } from '$lib/stores/preferences.store';

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
 * FC-46 (owner decision 2026-09-27): the upscale a photo really gets, as the dialog shows it before
 * confirming. The 64 MP output cap stays, so a photo the requested factor would take over it is
 * upscaled by a smaller one (a 12 MP photo asked for 4× gets 2×), and the estimate is for that factor.
 * Null for work that is not a photo upscale.
 */
export const upscaleFact = (
  estimate: Pick<CloudMlJobEstimateResponseDto, 'upscale'>,
): { valueKey: Translations; helpKey: Translations | null; values: Record<string, number | string> } | null => {
  const upscale = estimate.upscale;
  if (!upscale) {
    return null;
  }
  const values = {
    scale: upscale.appliedScale,
    requested: upscale.requestedScale,
    width: upscale.outputWidth.toLocaleString(get(locale)),
    height: upscale.outputHeight.toLocaleString(get(locale)),
  };
  return upscale.lowered
    ? {
        valueKey: 'frameleaf_cloud_job_upscale_lowered',
        helpKey: 'frameleaf_cloud_job_upscale_lowered_help',
        values,
      }
    : { valueKey: 'frameleaf_cloud_job_upscale_value', helpKey: null, values };
};

/**
 * What an estimate or confirmation refusal asks of the person (FL-162). `model` goes back to the
 * model slider (409 `model-mismatch`), `estimate` estimates again (409 `estimate-expired`, or the
 * terms changed), `preparing` asks again shortly (409 `input-preparing`: a whole video is being
 * prepared in the background), `money` shows the refusal as it is (402: never a lighter model),
 * `paused` shows Frameleaf Cloud's own message (FC-62: new jobs are paused in this region), and
 * anything else is shown as an error.
 */
export type CloudJobRefusal = 'model' | 'estimate' | 'preparing' | 'money' | 'paused' | 'other';

/** How long to wait before asking again for an estimate whose video is being prepared. */
export const preparingRetryMs = (error: unknown): number => {
  const seconds = isHttpError(error)
    ? (error.data as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds
    : undefined;
  return typeof seconds === 'number' && seconds > 0 ? Math.min(seconds, 60) * 1000 : 5000;
};

export const cloudJobRefusal = (error: unknown): CloudJobRefusal => {
  if (!isHttpError(error)) {
    return 'other';
  }
  const code = (error.data as { code?: unknown } | undefined)?.code;
  if (error.status === 409 && code === 'input-preparing') {
    return 'preparing';
  }
  if (error.status === 402) {
    return 'money';
  }
  if (error.status === 409 && code === 'model-mismatch') {
    return 'model';
  }
  if (error.status === 409 && (code === 'estimate-expired' || code === 'consent-version-outdated')) {
    return 'estimate';
  }
  if (pausedRefusalMessage(error)) {
    return 'paused';
  }
  return 'other';
};

/** Whether an estimate's sealed price still holds: after `expiresAt` it is estimated again. */
export const estimateLive = (estimate: Pick<CloudMlJobEstimateResponseDto, 'expiresAt'>, now = Date.now()) =>
  Date.parse(estimate.expiresAt) > now;

/** The heading the dialog shows while the job runs (prototype `RUN_HEAD`). */
export const runHeadKey = (stage: CloudMlJobActivityStage | ActivityStage): Translations =>
  `frameleaf_cloud_job_run_${stage}` as Translations;

const ENDED_STAGES: ReadonlySet<CloudMlJobActivityStage | ActivityStage> = new Set([
  CloudMlJobActivityStage.Done,
  CloudMlJobActivityStage.Failed,
  CloudMlJobActivityStage.Cancelled,
]);

/** Stages the dialog stops following at. */
export const isEndedStage = (stage: CloudMlJobActivityStage | ActivityStage) => ENDED_STAGES.has(stage);

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
  if (isEndedStage(stage)) {
    const settled = cloud.cost.settledUsd;
    let valueKey: Translations | undefined;
    if (settled === null) {
      valueKey = 'frameleaf_activity_cloud_settling';
    } else if (cloud.cost.outcome === CloudMlJobCostOutcome.NotCharged) {
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
