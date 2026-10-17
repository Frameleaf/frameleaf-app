import { describe, expect, it } from 'vitest';
import en from '$i18n/en.json';
import {
  CONSENT_TERM_KEYS,
  mlWorkloads,
  routingModes,
  workloadNameKey,
  workloadUseKey,
  workloadWhyKey,
} from '$lib/frameleaf/cloud-ml';
import {
  BANDS,
  composeFixes,
  fixStepKey,
  gpuClasses,
  gpuClassLabelKey,
  gpuProblems,
  LADDER_WORKLOADS,
  ladderFor,
  modelNoteKey,
  problemExplainKey,
  workloadUnitKey,
  type ComposeFixId,
} from '$lib/frameleaf/gpu-model-catalog';

/**
 * Copy checks for the Frameleaf Cloud, Hardware & GPU, routing and model screens (FL-159, handoff §5):
 * the prototype's banned-term check (settings-catalog.test.mjs "settings explanations describe user
 * choices without exposing development caveats or configuration paths"), the naming rule, and every
 * key the catalogue builds at run time exists.
 */

const flat = (value: Record<string, unknown>, prefix = ''): Array<[string, string]> =>
  Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === 'string'
      ? [[`${prefix}${key}`, entry]]
      : flat(entry as Record<string, unknown>, `${prefix}${key}.`),
  );

const messages = new Map(flat(en as Record<string, unknown>));

const developmentCopy =
  /\b(?:our|fork|prototype|production|proposed|upstream|DTO|Immich|queues?|queued|admission|endpoints?|sidecars?|embeddings?|payloads?|config|drafts?|revisions?|capabilit(?:y|ies)|qualif(?:y|ied|ication))\b/i;
const configurationPath =
  /\b(?:machineLearning|imageDescription|zeroShotTagging|localFeatures|physicalDeduplication|integrityChecks|privacy\.suppression|smartAlbums|ffmpeg|serverless|runpod|frameleafCloud)\.[a-zA-Z]/;
const namingRule = /runpod|immich|\bfork\b|\bDTO\b/i;

/** The screens this check covers. "our" is allowed only where the billing rule states our GPU cost. */
const COVERED = [
  /^admin\.frameleaf_cloud_ml_/,
  /^admin\.frameleaf_routing_/,
  /^frameleaf_hardware_/,
  /^frameleaf_model_/,
  /^frameleaf_gpu_class_/,
  /^frameleaf_cloud_unit_/,
  /^frameleaf_cc_section_(?:hardware|cloud_processing)/,
  /^frameleaf_settings_area_cloud/,
];
const OUR_COST = new Set(['admin.frameleaf_cloud_ml_billing_body']);

const covered = [...messages].filter(([key]) => COVERED.some((pattern) => pattern.test(key)));

describe('Frameleaf Cloud copy (FL-159 §5)', () => {
  it('covers the cloud, hardware, routing and model screens', () => {
    expect(covered.length).toBeGreaterThan(200);
  });

  it('describes choices without development caveats, product names or configuration paths', () => {
    for (const [key, text] of covered) {
      const checked = OUR_COST.has(key) ? text.replaceAll(/\bcosts us\b/g, '') : text;
      expect(checked, key).not.toMatch(developmentCopy);
      expect(text, key).not.toMatch(configurationPath);
      expect(text, key).not.toMatch(namingRule);
    }
  });

  it('has every key the catalogue and routing rows build at run time', () => {
    const keys = [
      ...CONSENT_TERM_KEYS,
      ...routingModes.map((mode) => mode.labelKey),
      ...mlWorkloads.flatMap((row) => [
        workloadNameKey(row.id),
        workloadUseKey(row.id),
        ...(row.cloud ? [] : [workloadWhyKey(row.id)]),
      ]),
      ...gpuClasses.map((gpu) => gpuClassLabelKey(gpu.id)),
      ...LADDER_WORKLOADS.map((workload) => workloadUnitKey(workload)),
      ...LADDER_WORKLOADS.flatMap((workload) => ladderFor(workload).map((item) => modelNoteKey(item))),
      ...Object.values(BANDS).map((band) => band.labelKey),
      ...gpuProblems.map((problem) => problemExplainKey(problem.id)),
      ...Object.entries(composeFixes).flatMap(([id, fix]) =>
        Array.from({ length: fix.steps }, (_, index) => fixStepKey(id as ComposeFixId, index + 1)),
      ),
      'frameleaf_model_reason_needs_memory',
      'frameleaf_model_reason_needs_memory_no_gpu',
      'frameleaf_model_reason_not_hosted',
      'frameleaf_model_reason_licence',
      'frameleaf_model_reason_local_only',
      'frameleaf_model_reason_cloud_only',
    ];
    expect(keys.filter((key) => !messages.has(key))).toEqual([]);
  });

  it('never names a licence caveat for face recognition', () => {
    for (const [key, text] of covered) {
      expect(text, key).not.toMatch(/buffalo|insightface|non-commercial face/i);
    }
  });
});
