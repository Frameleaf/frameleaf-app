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
  expect(catalogue.profiles).toHaveLength(21);
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
    '10a83ae85fa830c3097abaa4117a6adf6542b7ac3fbddb998599f3ef6382cc9d',
    '8259538dd53d4729b01115092f4709964592011cd2b5c819385b9ba9ebbc295a',
    '3642a6d2195bb7cdb3205bb65b9416462079150ab73c53c7d0bb71a48bd19a20',
    '24f6500b8b91a7203c4b91f56fbbdfe3b51666e653d7c576fe065f9fe6709d2e',
    'fb3d5c5410ea666f34496fd324fc4c88678f3685d4a145c38811a7609355a5ab',
    'b9f58507b2f76a79c90a4cdc49155f162a086c502966a1280d0cb3a02bb86510',
    'b435382d9f7d19b49cb227cdcbca97f258845c7df41f4dc7ec86fe4f6d944570',
    '9c8818340b94b0f37cdd35509e038a86db8d1ced793aa7a742e74754215bc779',
    '31337c0063a85bdf957d27ef7ec581b34e65ee4a73f53215c238ff2c9342d40c',
    '75d39bab3c7ce04a0b3864ae8eb420664970faa66ab2f55a82c043a8d4c9ebc1',
    'eae6ee5d7291fec288026e79094c294de27187f769310e373625e80a18bab1c2',
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

it('preserves all legacy profiles and gives PR274 preprocessing a distinct identity', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  expect(
    createHash('sha256')
      .update(canonicalJson(catalogue.profiles.slice(0, 11)))
      .digest('hex'),
  ).toBe('f09d6ae3ddf26a5c6cc0b92b9b0db056d567092c709b8aeb807161aefed870b5');
  expect(catalogue.profiles.slice(11, 16)).toHaveLength(5);
  const legacy = new Set(catalogue.profiles.slice(0, 11).map((profile) => profile.modelKey));
  for (const profile of catalogue.profiles.slice(11, 16)) {
    expect(profile.runtimeSourceRevision).toBe('1ca4d52e2b8158d89d8de8b17e1e6535e17691f4');
    expect(legacy.has(profile.modelKey)).toBe(false);
  }
});

it('retains all prior bindings while admitting only the exact qualified current source', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  expect(
    createHash('sha256')
      .update(canonicalJson(catalogue.profiles.slice(0, 16)))
      .digest('hex'),
  ).toBe('2e8b52cf4107668d2df47eb0564398028cb75502d766a3403b4201a41c7b03a1');
  const current = catalogue.profiles.slice(16);
  expect(current).toHaveLength(5);
  expect(current.map((profile) => profile.workload)).toEqual(['clip', 'clip', 'clip', 'ocr', 'face']);
  for (const profile of current) {
    expect(profile.runtimeSourceRevision).toBe('f93c34d196955da3e2760c095c08b27ccbf53315');
    expect(profile.spec.provider).toBe('CPUExecutionProvider');
    expect(profile.spec.preprocessingSha256).toBe('06c8c5cc89891f53ae06675c3a4f32113c45215e705a9b2da0051143a8e13639');
  }
});
