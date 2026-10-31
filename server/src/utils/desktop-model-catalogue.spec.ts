import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DesktopModelCatalogue,
  createDesktopModelChallenge,
  desktopImageModelKeys,
  matchDesktopModelProfile,
  parseDesktopModelCatalogue,
} from 'src/utils/desktop-model-catalogue.js';
import { canonicalJson } from 'src/utils/object.js';

const raw = (): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8'));
it('preserves every prior binding and selects the qualified precision-corrected CPU profiles', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  expect(catalogue.epoch).toBe(12);
  expect(catalogue.profiles).toHaveLength(52);
  expect(
    createHash('sha256')
      .update(canonicalJson(catalogue.profiles.slice(0, 27)))
      .digest('hex'),
  ).toBe('fa8fd8b562bbe6c66fa6d2ccf01898c61c4b97349988ccb88e7d69eec2abdf4f');
  const legacyKeys = new Set(catalogue.profiles.slice(0, 27).map((profile) => profile.modelKey));
  const current = catalogue.profiles.slice(27, 32);
  for (const profile of current) {
    expect(profile.runtimeSourceRevision).toBe('0d9702c68f31ea3eea068ac59ca1cf36a2b520fc');
    expect(profile.spec.provider).toBe('CPUExecutionProvider');
    expect(profile.spec.preprocessingSha256).toBe('330a3e5ee01610d5f8d41f45cd97089471ad03d4ccc3946f6ee8a43a6082ea5d');
    expect(legacyKeys.has(profile.modelKey)).toBe(false);
  }
  expect(current.map((profile) => profile.workload)).toEqual(['clip', 'clip', 'clip', 'ocr', 'face']);
  expect(desktopImageModelKeys).toEqual({
    ocr: catalogue.profiles[35].modelKey,
    face: catalogue.profiles[36].modelKey,
  });
});
it('validates the approved default model and preserves exact config, source and provider identity', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  expect(catalogue.profiles).toHaveLength(52);
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
        'MIGraphXExecutionProvider',
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
    'e60c7be1967dfa9f38df396ed3b3f2bcf4e309ba3e02290933a4f6d4e7419165',
    'b218ecbe1dceac1f7dbe68f3ffd3558ae452964b42a46154c965e474e36a836f',
    'c89f6440a4462fb75aaab690b76552b817ff7abd8d481df87e5662524eafaab8',
    '546549421b4d0dc3f4a8601db9207befd4d82e3ecb9e0ad52849ed3199441be4',
    'b2af0f4cba01a87d6b656a69f4aa7ab3cddba1bfb0bda4d4340c8ce484e16ef0',
    '7b744d6547e885abcfdd845f914fe858bd5e13321783af9c3b26f679fdf95f76',
    '05fc08742b2b05cebd5bf54302f1c78f8ba16902a502e4815a8a750ecba02a66',
    '46fc1b58fd122980ee5de68b62d7c431f8f115bb84e2d19933aa55ba08a89cb1',
    'fc631cdf02d40fb5a491e6fb0991bf0e5399918b86657e1b9e1ba483d5f02841',
    'f66eb524b80589047de44409de6a19ffa9ca2de18b7b6d8669a692700a625da6',
    '4db2580d36114fce59cea7fafb125c4f82ab93f78e82772bd50d888d14c358fe',
    '6f146c1d05e93818586ed9fcf70e3ae6de1ff195dbfcf15e96cec4f8a93975c4',
    'a6d03f7df8104794200ac2c6f7734c77634dd0dd4a119fc24a85015730be0fa7',
    '2d8945f2b72d68508c39e87b2cbc123cf51723d8b302d67a678d4bd00720b582',
    '0832de93d79c15053749f2f17dddaae95e2a18b00fa0e86d104b6e0d2d14e438',
    '1f104316fb10128ad1444d40b1de21b968b52459a9096b7f4163b2613f2ec25e',
    '4f3f460977c87e1155cca9ad4b47e57cc8c3de3832984bcb5c212a4aaf71f7fb',
    '354abc377aa6c89a573b2c14468eb2fb94e1030ba1ebeae384dde01612adeb00',
    'd9eecddc9dbbc61ff126beb62ce35b1e45af0b289f568c3a9b6ca219eb75f93c',
    '40115f6689e12d4b40e2e456dd4f20b527a29795a17d76c1b79b881b6b3b0f34',
    '420f5d93f9189e42fad015eec0ff2cb19571e1e5f127e68b6e2770b697f15557',
    '7480057b35520ea85d2bff0fa0fa026df115eabdd51ab87a9ba3ba2211d97b6d',
    '37a25a170947f424cc0231e279ff5ea5de7dfc0c1a40b056bb60f3c807ef176b',
    'f4a861ae2fb52c45577f1ab08aa0bdf794628dc11c4e4a2de75909bac6bf68b6',
    '2a43cd5fb87f155cb03c1d528dad7d560f390654ce7849b4ffa4da45eab5daf2',
    'bb60ac6ef80bdf0bcc77295364cece4173adad781cd945a7250b47fa2e19ad88',
    '82bc3cb4ec3204c5f06e0b43e1c3e65666d82bda63381d655c7eb92ab1d56551',
    'f3dabc2a4bdda94ec954ed297ef9da4ea2ea2b7875d328c508d5ca3d31227e0e',
    'c07473e7f48fc116ede101ba012f266a7c84c1a79485f8be4f6f80df49153d82',
    'eb5990f3895a30726bf70f19dca270e14c09325364d0c71085c4334a54912cff',
    '84a5a8662aab5eac9415ca46b9c25318ba0bd989f4711853c75776614e919f8c',
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
  const current = catalogue.profiles.slice(16, 21);
  expect(current).toHaveLength(5);
  expect(current.map((profile) => profile.workload)).toEqual(['clip', 'clip', 'clip', 'ocr', 'face']);
  for (const profile of current) {
    expect(profile.runtimeSourceRevision).toBe('f93c34d196955da3e2760c095c08b27ccbf53315');
    expect(profile.spec.provider).toBe('CPUExecutionProvider');
    expect(profile.spec.preprocessingSha256).toBe('06c8c5cc89891f53ae06675c3a4f32113c45215e705a9b2da0051143a8e13639');
  }
});

it('preserves all CPU profiles while admitting only the proved CoreML CLIP source', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  expect(
    createHash('sha256')
      .update(canonicalJson(catalogue.profiles.slice(0, 21)))
      .digest('hex'),
  ).toBe('93fe12352a13ce0f09ce231eabc2dd9e0fe5d2903f3a48dffba29e23ddc5b6c0');
  const selected = catalogue.profiles.slice(21, 24);
  expect(selected).toHaveLength(3);
  for (const [index, profile] of selected.entries()) {
    expect(profile.spec.provider).toBe('CoreMLExecutionProvider');
    expect(profile.runtimeSourceRevision).toBe('db72dcde18d3a4ff4ab5cfed3fb650a6b3629353');
    const cpu = catalogue.profiles[16 + index];
    expect({
      ...profile,
      runtimeSourceRevision: cpu.runtimeSourceRevision,
      spec: { ...profile.spec, provider: 'CPUExecutionProvider' },
    }).toEqual(cpu);
    expect(
      matchDesktopModelProfile(
        catalogue,
        profile.modelName,
        profile.spec.entries,
        profile.runtimeSourceRevision,
        'CPUExecutionProvider',
      ),
    ).toBeUndefined();
  }
});

it('selects current-main CoreML profiles with distinct preprocessing while preserving prior bindings', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  expect(catalogue.epoch).toBeGreaterThanOrEqual(9);
  expect(catalogue.profiles).toHaveLength(52);
  expect(
    createHash('sha256')
      .update(canonicalJson(catalogue.profiles.slice(0, 24)))
      .digest('hex'),
  ).toBe('6e96b5643ee2da45f19a9ca0a7a2de20645cea56e1811f6a3cb8e12e8e5b9086');
  const source = 'b7b5756a3f9eaeec9e977460ab654cbbadee87e7';
  for (const [index, profile] of catalogue.profiles.slice(24, 27).entries()) {
    expect(profile.runtimeSourceRevision).toBe(source);
    expect(profile.spec.provider).toBe('CoreMLExecutionProvider');
    const old = catalogue.profiles[21 + index];
    expect(profile.spec.preprocessingSha256).toBe('95c9a53b9b2cbd2d44c3ea386dc8dbb70e61d6f8a1206d5761fbbdc36d636bc7');
    expect(profile.modelKey).not.toBe(old.modelKey);
    expect(profile.spec.modelKey).toBe(profile.modelKey);
    expect({
      ...profile,
      modelKey: old.modelKey,
      runtimeSourceRevision: old.runtimeSourceRevision,
      spec: { ...profile.spec, modelKey: old.modelKey, preprocessingSha256: old.spec.preprocessingSha256 },
    }).toEqual(old);
    expect(
      matchDesktopModelProfile(catalogue, profile.modelName, profile.spec.entries, source, profile.spec.provider),
    ).toEqual(profile);
    expect(
      matchDesktopModelProfile(catalogue, profile.modelName, profile.spec.entries, source, 'CPUExecutionProvider'),
    ).toBeUndefined();
  }
});

it('selects exact current CPU and CoreML profiles while preserving all historical bindings', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  expect(catalogue.epoch).toBe(12);
  expect(catalogue.profiles).toHaveLength(52);
  expect(
    createHash('sha256')
      .update(canonicalJson(catalogue.profiles.slice(0, 32)))
      .digest('hex'),
  ).toBe('22b8e3fa22858c0422bed4c4cbee128e44d111775fef176f71bfa499269f5ec8');
  for (const provider of ['CPUExecutionProvider', 'CoreMLExecutionProvider']) {
    const selected = catalogue.profiles.filter(
      (p) => p.runtimeSourceRevision === 'f2c451a6bf71ca3f3aec986e07f0852937268e2f' && p.spec.provider === provider,
    );
    expect(selected.map((p) => p.workload)).toEqual(['clip', 'clip', 'clip', 'ocr', 'face']);
    for (const profile of selected) {
      expect(profile.spec.preprocessingSha256).toBe('8d9fc77dbb8d8c1ee262ed800a564b7cc82b0160e3c29166f724b84529ec353a');
      expect(
        matchDesktopModelProfile(
          catalogue,
          profile.modelName,
          profile.spec.entries,
          profile.runtimeSourceRevision,
          provider,
        ),
      ).toEqual(profile);
    }
  }
  for (let index = 0; index < 5; index++) {
    const cpu = catalogue.profiles[32 + index];
    const gpu = catalogue.profiles[37 + index];
    expect({ ...gpu, spec: { ...gpu.spec, provider: 'CPUExecutionProvider' } }).toEqual(cpu);
  }
});

it('epoch 12 adds CUDA and OpenVINO twins of the current CPU profiles and keeps every prior binding', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  expect(catalogue.epoch).toBe(12);
  expect(catalogue.profiles).toHaveLength(52);
  expect(
    createHash('sha256')
      .update(canonicalJson(catalogue.profiles.slice(0, 42)))
      .digest('hex'),
  ).toBe('55de0a4da603339578721080a8eca52ef7a9beb32ca28d4b52aa58d798a49d5d');
  const source = 'f2c451a6bf71ca3f3aec986e07f0852937268e2f';
  for (const [offset, provider] of [
    [42, 'CUDAExecutionProvider'],
    [47, 'OpenVINOExecutionProvider'],
  ] as const) {
    for (let index = 0; index < 5; index++) {
      const cpu = catalogue.profiles[32 + index];
      const twin = catalogue.profiles[offset + index];
      expect(twin.runtimeSourceRevision).toBe(source);
      expect(twin.spec.provider).toBe(provider);
      // the same model, files, fixture and CPU reference output, for the other provider
      expect({ ...twin, spec: { ...twin.spec, provider: 'CPUExecutionProvider' } }).toEqual(cpu);
      expect(matchDesktopModelProfile(catalogue, twin.modelName, twin.spec.entries, source, provider)).toEqual(twin);
    }
  }
});
