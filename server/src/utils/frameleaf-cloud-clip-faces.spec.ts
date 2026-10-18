import { describe, expect, it } from 'vitest';
import { MlWorkload } from 'src/enum.js';
import { localPinnedIdentity } from 'src/utils/cloud-model-identity.js';
import {
  CLOUD_CATALOG_INCLUDE,
  CLOUD_MODEL_GROUPS,
  catalogEntrySchema,
  cloudDefaultGroupFor,
  cloudModelFor,
  cloudModelGroupFor,
  consentCurrentQuery,
  consentRecordFeatures,
  consentRecordRequestSchema,
  hasPendingCloudDisclosure,
} from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

/** FL-455: smart search (`clip`) and faces (`face`) on Frameleaf Cloud, offered only as the catalogue allows. */

const identity = () => localPinnedIdentity(MlWorkload.Clip, 'ViT-B-16-SigLIP-384__webli')!;
const baseEntry = () => cloudContractFixture<{ models: Record<string, unknown>[] }>('ml/catalog.json').models[0];

describe('catalogue entries for smart search and faces', () => {
  it('asks the catalogue for them, since it leaves them out otherwise', () => {
    expect(CLOUD_CATALOG_INCLUDE).toEqual(['clip', 'face']);
  });

  it('accepts a clip or face entry that names its model identity, and keeps it', () => {
    const parsed = catalogEntrySchema.parse({ ...baseEntry(), workload: 'clip', default: false, identity: identity() });
    expect(parsed.identity).toMatchObject({
      name: 'ViT-B-16-SigLIP-384__webli',
      preprocess: 'frameleaf-clip-visual/1',
    });
  });

  it('refuses a clip or face entry without an identity, and an identity on any other work', () => {
    expect(catalogEntrySchema.safeParse({ ...baseEntry(), workload: 'clip' }).success).toBe(false);
    expect(catalogEntrySchema.safeParse({ ...baseEntry(), workload: 'face' }).success).toBe(false);
    expect(catalogEntrySchema.safeParse({ ...baseEntry(), identity: identity() }).success).toBe(false);
    expect(catalogEntrySchema.parse(baseEntry()).identity).toBeNull();
  });
});

describe('the model a smart search or face job names', () => {
  const facts = {
    defaultModels: { clip: 'ms_default', descriptions: 'ms_desc' },
    localModels: { [MlWorkload.Clip]: 'ms_pinned' },
  };

  it("is only ever the catalogue model matching this server's model, never a choice or a default", () => {
    expect(cloudModelFor(MlWorkload.Clip, 'ms_chosen', facts)).toBe('ms_pinned');
    expect(cloudModelFor(MlWorkload.Face, 'ms_chosen', facts)).toBeNull();
    expect(cloudModelFor(MlWorkload.Clip, null, { defaultModels: facts.defaultModels })).toBeNull();
    // other work is unchanged
    expect(cloudModelFor(MlWorkload.Enrichment, null, facts)).toBe('ms_desc');
  });

  it('reads its own catalogue group, which no administrator chooses a model for', () => {
    expect(cloudModelGroupFor(MlWorkload.Clip)).toBe('clip');
    expect(cloudModelGroupFor(MlWorkload.Face)).toBe('face');
    expect(cloudDefaultGroupFor(MlWorkload.Clip)).toBeNull();
    expect(cloudDefaultGroupFor(MlWorkload.Face)).toBeNull();
    expect(CLOUD_MODEL_GROUPS).not.toContain('clip');
    expect(CLOUD_MODEL_GROUPS).not.toContain('face');
  });

  it('is covered by the reviewed disclosure; text and pet recognition are not', () => {
    expect(hasPendingCloudDisclosure(MlWorkload.Clip)).toBe(false);
    expect(hasPendingCloudDisclosure(MlWorkload.Face)).toBe(false);
    expect(hasPendingCloudDisclosure(MlWorkload.Ocr)).toBe(true);
    expect(hasPendingCloudDisclosure(MlWorkload.PetRecognition)).toBe(true);
  });
});

describe('the smart search and face recognition consent', () => {
  const off = { identityNames: false, medicalSignals: false, ocrAddon: false };

  it('asks for their terms only when chosen, so a cloud without them is asked as before', () => {
    expect(consentCurrentQuery({ identityNames: false, medicalSignals: false }, true)).toBe(
      '?identityNames=false&medicalSignals=false',
    );
    expect(
      consentCurrentQuery(
        { identityNames: false, medicalSignals: false, smartSearch: true, faceRecognition: true },
        true,
      ),
    ).toBe('?identityNames=false&medicalSignals=false&smartSearch=true&faceRecognition=true');
  });

  it('records them only when chosen, and the record passes the contract', () => {
    expect(consentRecordFeatures({ ...off, smartSearch: false, faceRecognition: false })).toEqual(off);
    const both = consentRecordFeatures({ ...off, smartSearch: true, faceRecognition: true });
    expect(both).toEqual({ ...off, smartSearch: true, faceRecognition: true });
    expect(consentRecordRequestSchema.safeParse({ version: '2026-10-18.1', features: both }).success).toBe(true);
    expect(
      consentRecordRequestSchema.safeParse({ version: '2026-10-18.1', features: { ...off, smartSearch: false } })
        .success,
    ).toBe(false);
  });
});
