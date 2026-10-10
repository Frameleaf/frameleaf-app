import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MlAdmissionRefusal } from 'src/enum.js';
import {
  CLOUD_SPEAKER_LABELS_OFFERED,
  CloudErrorCode,
  FrameleafCloudError,
  catalogSchema,
  cloudUpscaleAppliedScale,
  errorEnvelopeSchema,
  estimateRequestSchema,
  estimateResponseSchema,
  isEnglishVoice,
  isIdempotencyInFlight,
  isIdempotencyKeyReused,
  jobCreateRequestSchema,
  jobErrorSchema,
  refusalFromCloudError,
  upscaleResultSchema,
} from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

/**
 * Frameleaf Cloud's ML owner decisions of 2026-09-27 (frameleaf-cloud#96, `bcb5098`): the IETF
 * Idempotency-Key answers (FC-43), the 64 MP upscale cap lowering the factor per photo (FC-46), the
 * charged `runtime-cap` (FC-47), and English-only speech with speaker labels off (FC-48). Every
 * fixture here is byte-identical to the cloud's `packages/contracts/fixtures` (see SOURCE.md).
 */
const envelopeOf = (name: string) => errorEnvelopeSchema.parse(cloudContractFixture(`errors/${name}.json`));
const errorOf = (status: number, name: string) => {
  const envelope = envelopeOf(name);
  return new FrameleafCloudError(refusalFromCloudError(status, envelope), status, envelope.message, envelope, null, 2);
};

describe('Idempotency-Key answers on POST /v2/jobs (FC-43)', () => {
  it('reads a key still in flight (409) as a wait, never a spent or mismatched estimate', () => {
    const error = errorOf(409, 'idempotency-in-flight');
    expect(error.envelope?.code).toBe(CloudErrorCode.IdempotencyInFlight);
    expect(error.envelope?.retryable).toBe(true);
    expect(error.refusal).toBe(MlAdmissionRefusal.CloudUnavailable);
    expect(isIdempotencyInFlight(error)).toBe(true);
    expect(isIdempotencyKeyReused(error)).toBe(false);
    // any other 409 on the job route still means the estimate is spent or does not match
    expect(refusalFromCloudError(409, envelopeOf('estimate-mismatch'))).toBe(MlAdmissionRefusal.ModelMismatch);
  });

  it('reads a key reused with another body as 422 idempotency-key-reused (was 409 idempotency-conflict)', () => {
    const error = errorOf(422, 'idempotency-key-reused');
    expect(error.envelope?.code).toBe(CloudErrorCode.IdempotencyKeyReused);
    expect(error.envelope?.retryable).toBe(false);
    expect(error.refusal).toBe(MlAdmissionRefusal.RequestInvalid);
    expect(isIdempotencyKeyReused(error)).toBe(true);
    expect(isIdempotencyInFlight(error)).toBe(false);
  });

  it('reads a missing or malformed key as 400 request-invalid (was 422)', () => {
    const envelope = envelopeOf('idempotency-key-missing');
    expect(envelope).toMatchObject({ code: 'request-invalid', detail: 'idempotency-key', refusal: 'request-invalid' });
    expect(refusalFromCloudError(400, envelope)).toBe(MlAdmissionRefusal.RequestInvalid);
    expect(isIdempotencyKeyReused(errorOf(400, 'idempotency-key-missing'))).toBe(false);
  });
});

describe('upscale under the 64 MP output cap (FC-46)', () => {
  it('sends the estimate and job requests, with each photo size declared', () => {
    const estimate = estimateRequestSchema.parse(cloudContractFixture('ml/upscale/estimate-request.json'));
    expect(estimate.workload).toBe('upscale');
    expect(jobCreateRequestSchema.safeParse(cloudContractFixture('ml/upscale/job-request.json')).success).toBe(true);
    expect(jobCreateRequestSchema.safeParse(cloudContractFixture('ml/upscale/job-request-minimal.json')).success).toBe(
      true,
    );
  });

  it('reads the per-photo factor and the lowered photos from the estimate', () => {
    const request = cloudContractFixture('ml/upscale/estimate-request.json');
    const estimate = estimateResponseSchema.parse(cloudContractFixture('ml/upscale/estimate-response.json'));
    expect(estimate.upscale).toEqual({
      scale: 4,
      items: [
        { inputId: 'a1', scale: 4 },
        { inputId: 'a2', scale: 4 },
        { inputId: 'a3', scale: 2 },
      ],
      lowered: ['a3'],
    });
    // the cloud decides with the same rule this server checks it with: a 12 MP photo asked for 4× gets 2×
    for (const item of request.request.items as { inputId: string; width: number; height: number }[]) {
      const quoted = estimate.upscale!.items.find((entry) => entry.inputId === item.inputId)!.scale;
      expect(cloudUpscaleAppliedScale(item.width, item.height, request.request.scale), item.inputId).toBe(quoted);
    }
    expect(cloudUpscaleAppliedScale(4000, 3000, 4)).toBe(2);
    expect(cloudUpscaleAppliedScale(2000, 2000, 4)).toBe(4);
    expect(cloudUpscaleAppliedScale(5000, 4000, 2)).toBeNull();
  });

  it('refuses an estimate whose lowered list does not match its factors', () => {
    const estimate = cloudContractFixture('ml/upscale/estimate-response.json');
    for (const upscale of [
      { ...estimate.upscale, lowered: [] },
      { ...estimate.upscale, lowered: ['a3', 'a9'] },
      { ...estimate.upscale, items: [...estimate.upscale.items, { inputId: 'a4', scale: 8 }] },
    ]) {
      expect(estimateResponseSchema.safeParse({ ...estimate, upscale }).success).toBe(false);
    }
  });

  it('reads each output as its input times its own item factor, never the document scale', () => {
    const result = upscaleResultSchema.parse(cloudContractFixture('ml/upscale/result.json'));
    expect(result.scale).toBe(4);
    for (const item of result.items) {
      const output = item.outputs[0]!;
      expect(output.width).toBe(item.input!.width * item.scale!);
      expect(output.height).toBe(item.input!.height * item.scale!);
    }
    expect(result.items.find((item) => item.inputId === 'a3')?.scale).toBe(2);
    const failed = upscaleResultSchema.parse(cloudContractFixture('ml/upscale/result-failed-items.json'));
    expect(failed.items.filter((item) => item.scale === null).every((item) => item.outputs.length === 0)).toBe(true);
  });

  it('refuses every rejected upscale result fixture', () => {
    const folder = join(import.meta.dirname, '../../test/fixtures/frameleaf-cloud-contracts/ml/upscale/rejected');
    const names = readdirSync(folder).filter((name) => name.startsWith('result-'));
    expect(names).toContain('result-wrong-size.json');
    for (const name of names) {
      expect(upscaleResultSchema.safeParse(cloudContractFixture(`ml/upscale/rejected/${name}`)).success, name).toBe(
        false,
      );
    }
  });
});

describe('restoration runtime cap (FC-47)', () => {
  it('reads runtime-cap as a job error that is not retryable', () => {
    const error = jobErrorSchema.parse({
      code: 'runtime-cap',
      message: 'The job reached its 6-hour limit and was stopped.',
      retryable: false,
    });
    expect(error.code).toBe('runtime-cap');
  });
});

describe('speech and speaker labels (FC-48)', () => {
  it('reads the Studio catalogue: one Smooth motion model (RIFE), English voices only', () => {
    const catalog = catalogSchema.parse(cloudContractFixture('ml/catalog-studio.json'));
    expect(catalog.refused).toBe(0);
    expect(catalog.models.filter((model) => model.workload === 'interpolation')).toHaveLength(1);
    const tts = catalog.models.find((model) => model.workload === 'tts')!;
    expect(tts.voices!.length).toBeGreaterThan(0);
    expect(tts.voices!.every((voice) => isEnglishVoice(voice.language))).toBe(true);
  });

  it('never offers a voice in another language, whatever a catalogue lists', () => {
    const fixture = cloudContractFixture('ml/catalog-studio.json');
    const models = fixture.models.map((model: { workload: string; voices?: unknown[] }) =>
      model.workload === 'tts'
        ? { ...model, voices: [...model.voices!, { sku: 'vs_E5P0N812', label: 'Dora · Spanish', language: 'es' }] }
        : model,
    );
    const catalog = catalogSchema.parse({ ...fixture, models });
    const tts = catalog.models.find((model) => model.workload === 'tts')!;
    expect(tts.voices!.map((voice) => voice.sku)).not.toContain('vs_E5P0N812');
    expect(isEnglishVoice('en')).toBe(true);
    expect(isEnglishVoice('en-GB')).toBe(true);
    expect(isEnglishVoice('es')).toBe(false);
  });

  it('never asks for speaker labels', () => {
    expect(CLOUD_SPEAKER_LABELS_OFFERED).toBe(false);
    const body = {
      workload: 'transcription',
      modelSku: 'ms_XA8A84VQ',
      inputs: [{ inputId: 'a1', contentType: 'audio/wav', bytes: 10, sha256: 'a'.repeat(64) }],
      request: { language: 'en', diarize: true },
    };
    expect(estimateRequestSchema.safeParse(body).success).toBe(false);
  });
});
