import z from 'zod';
import type { DesktopModelProfile } from 'src/utils/desktop-model-catalogue.js';
import { canonicalJson } from 'src/utils/object.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const desktopDeviceFactsSchema = z.strictObject({
  abiVersion: z.literal(1),
  collectorSha256: digest,
  osBuild: z.string().min(1).max(256),
  devices: z
    .array(z.strictObject({ name: z.string().min(1).max(256), identitySha256: digest }))
    .min(1)
    .max(16),
});
export const desktopDeviceExecutionSchema = z.strictObject({
  provider: z.literal('CoreMLExecutionProvider'),
  facts: desktopDeviceFactsSchema,
  models: z
    .array(
      z.strictObject({
        sha256: digest,
        calls: counter.min(2),
        computeBuffers: counter,
        computeDispatches: counter,
        gpuNanoseconds: z.number().positive().finite(),
      }),
    )
    .min(1)
    .max(64),
});

/** Validates participation evidence; provider labels alone never establish physical GPU work. */
export const validateDesktopDeviceExecution = (
  proof: z.infer<typeof desktopDeviceExecutionSchema> | undefined,
  facts: z.infer<typeof desktopDeviceFactsSchema> | undefined,
  models: DesktopModelProfile['spec']['models'],
  collectorSha256: string | undefined,
) => {
  const invalid = () => new Error('desktop_device_execution_invalid');
  if (
    !proof ||
    !facts ||
    !collectorSha256 ||
    proof.facts.collectorSha256 !== collectorSha256 ||
    canonicalJson(proof.facts) !== canonicalJson(facts) ||
    Buffer.byteLength(canonicalJson(facts)) > 16_384 ||
    new Set(facts.devices.map((device) => device.identitySha256)).size !== facts.devices.length
  )
    throw invalid();
  const expected = new Set(models.map((model) => model.artifacts[`${model.type}/model.onnx`]));
  const observed = new Set(proof.models.map((model) => model.sha256));
  if (
    models.some((model) => !/^[a-f0-9]{64}$/.test(model.artifacts[`${model.type}/model.onnx`] ?? '')) ||
    observed.size !== proof.models.length ||
    expected.size !== observed.size ||
    [...expected].some((hash) => !observed.has(hash)) ||
    proof.models.some(
      (model) =>
        model.calls > model.computeBuffers ||
        model.computeBuffers > model.computeDispatches ||
        model.gpuNanoseconds > 600_000_000_000 * model.calls,
    )
  )
    throw invalid();
};
