import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DesktopModelCatalogue,
  createDesktopModelChallenge,
  matchDesktopModelProfile,
  parseDesktopModelCatalogue,
} from 'src/utils/desktop-model-catalogue.js';
import { canonicalJson } from 'src/utils/object.js';

const raw = (): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8'));
it('validates the approved default model and preserves exact config, source and provider identity', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  expect(catalogue.profiles).toHaveLength(10);
  for (const profile of catalogue.profiles) {
    if (profile.workload !== 'clip') continue;
    expect(profile.modelName).toBe('ViT-B-16-SigLIP-384__webli');
    expect(profile.embeddingDimensions).toBe(768);
    expect(
      matchDesktopModelProfile(
        catalogue,
        profile.modelName,
        profile.spec.entries,
        profile.runtimeSourceRevision,
        profile.spec.provider,
      ),
    ).toEqual(profile);
    expect(
      matchDesktopModelProfile(
        catalogue,
        'ViT-B-32__openai',
        profile.spec.entries,
        profile.runtimeSourceRevision,
        profile.spec.provider,
      ),
    ).toBeUndefined();
    expect(
      matchDesktopModelProfile(catalogue, profile.modelName, {}, profile.runtimeSourceRevision, profile.spec.provider),
    ).toBeUndefined();
    expect(
      matchDesktopModelProfile(
        catalogue,
        profile.modelName,
        profile.spec.entries,
        '0'.repeat(40),
        profile.spec.provider,
      ),
    ).toBeUndefined();
    expect(
      matchDesktopModelProfile(
        catalogue,
        profile.modelName,
        profile.spec.entries,
        profile.runtimeSourceRevision,
        'CUDAExecutionProvider',
      ),
    ).toBeUndefined();
  }
});
it('refuses changed artifact/config identity, reference shape, fixture bytes and unknown fields', () => {
  const original = parseDesktopModelCatalogue(raw());
  for (const change of [
    (v: DesktopModelCatalogue) => {
      v.profiles[0].spec.entries = {
        clip: { textual: { modelName: v.profiles[0].modelName, options: { language: 'fr' } } },
      };
    },
    (v: DesktopModelCatalogue) => {
      v.profiles[0].spec.models[0].artifacts['textual/model.onnx'] = '0'.repeat(64);
    },
    (v: DesktopModelCatalogue) => {
      v.profiles[0].spec.expectedOutput.clip = '[1,2]';
    },
    (v: DesktopModelCatalogue) => {
      v.profiles[0].fixtureBase64 = Buffer.from('changed fixture').toString('base64');
    },
    (v: DesktopModelCatalogue) => {
      v.profiles[0].spec.models[0].artifacts['../outside'] = '0'.repeat(64);
    },
    (v: DesktopModelCatalogue) => {
      v.profiles[0].embeddingDimensions = 512;
    },
    (v: DesktopModelCatalogue) => {
      v.profiles[0].modelSnapshotRevision = '0'.repeat(40);
    },
    (v: DesktopModelCatalogue) => {
      Object.assign(v.profiles[0].spec, { executable: '/untrusted' });
    },
    (v: DesktopModelCatalogue) => {
      v.profiles.push(v.profiles[0]);
    },
  ]) {
    const value = structuredClone(original);
    change(value);
    expect(() => parseDesktopModelCatalogue(value)).toThrow();
  }
});

it('binds a fresh canonical NAS nonce with the same digest as the native contract', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  const expected = [
    '667244e2f6254b58c290a62f4b82cc5f82f5957f394813e015e1f8cf4454527a',
    '209293bc2f54fbcdc0524b1cec7eb81e5bfb4f045432885b037947288b42b03d',
    '839b7ff60758640ad3644dd7761bea5e8e26bfde32355c8371d9c50042ecc838',
    '667244e2f6254b58c290a62f4b82cc5f82f5957f394813e015e1f8cf4454527a',
    '209293bc2f54fbcdc0524b1cec7eb81e5bfb4f045432885b037947288b42b03d',
    '839b7ff60758640ad3644dd7761bea5e8e26bfde32355c8371d9c50042ecc838',
    'c53ede795fb9a86ecba813f1e4f279ee4fa16e9109ed245db5ae8f1d144cd2c5',
    'a14a99cad4f9e208fd8729680a37211dd09ed13b9e34462559c13f9dd35826a3',
    '4756b97c88cdafaf134d234d96f49b64c9ec16294e6966c3eb9d94d4a60b66fa',
    '314c297749e23952b8541b47000e191dbccbac1556c5710b8f23a03d5d21391f',
  ];
  expect(catalogue.profiles).toHaveLength(expected.length);
  for (const [index, profile] of catalogue.profiles.entries()) {
    const first = createDesktopModelChallenge(profile, 'd621bd72-ad35-4199-95ab-76300756a38e');
    const second = createDesktopModelChallenge(profile, 'c39d4385-84f8-4c37-a643-1b98fc12df93');
    expect(first.bindingSha256).toBe(expected[index]);
    expect(second.bindingSha256).not.toBe(first.bindingSha256);
    expect(first.fixtureBase64).toBe(second.fixtureBase64);
    expect(() => createDesktopModelChallenge(profile, '../untrusted')).toThrow();
  }
});

it('accepts a released OCR detection/recognition pair without an embedding dimension', () => {
  const ocr = JSON.parse(readFileSync('test/fixtures/desktop-ocr-profile.json', 'utf8'));
  const catalogue = parseDesktopModelCatalogue({ schemaVersion: 1, epoch: 4, profiles: [ocr] });
  expect(catalogue.profiles[0].workload).toBe('ocr');
  expect(catalogue.profiles[0].spec.models).toHaveLength(2);
  expect(catalogue.profiles[0]).not.toHaveProperty('embeddingDimensions');
  expect(
    createDesktopModelChallenge(catalogue.profiles[0], 'd621bd72-ad35-4199-95ab-76300756a38e').bindingSha256,
  ).toMatch(/^[a-f0-9]{64}$/);
});

it('refuses OCR profiles that lose an engine, change its request, or have invalid normalized output', () => {
  const source = parseDesktopModelCatalogue({
    schemaVersion: 1,
    epoch: 4,
    profiles: [JSON.parse(readFileSync('test/fixtures/desktop-ocr-profile.json', 'utf8'))],
  });
  const changes: Array<(v: DesktopModelCatalogue['profiles'][number]) => void> = [
    (v) => {
      v.spec.models.pop();
    },
    (v) => {
      v.spec.models[1].task = 'clip';
    },
    (v) => {
      v.spec.models[1].type = 'detection';
    },
    (v) => {
      v.spec.models[1].artifacts['recognition/model.onnx'] = '0'.repeat(64);
    },
    (v) => {
      v.embeddingDimensions = 768;
    },
    (v) => {
      (v.spec.expectedOutput.ocr as { box: number[] }).box[0] = 1.1;
    },
    (v) => {
      (v.spec.expectedOutput.ocr as { textScore: number[] }).textScore.pop();
    },
    (v) => {
      v.spec.expectedOutput.ocr = { box: [], boxScore: [], text: [], textScore: [] };
    },
  ];
  for (const change of changes) {
    const value = structuredClone(source);
    const profile = value.profiles[0];
    change(profile);
    profile.modelKey = profile.spec.modelKey =
      'ocr:' +
      createHash('sha256')
        .update(
          canonicalJson({
            protocolVersion: 1,
            entries: profile.spec.entries,
            models: profile.spec.models,
            preprocessingSha256: profile.spec.preprocessingSha256,
          }),
        )
        .digest('hex');
    expect(() => parseDesktopModelCatalogue(value)).toThrow();
  }
});
