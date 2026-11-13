import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLIP_MODEL_INFO } from 'src/constants.js';
import {
  type DesktopModelCatalogue,
  createDesktopModelChallenge,
  desktopImageModelKey,
  desktopImageModelKeys,
  matchDesktopModelProfile,
  parseDesktopModelCatalogue,
} from 'src/utils/desktop-model-catalogue.js';
import { canonicalJson } from 'src/utils/object.js';

const raw = (): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8'));
it('preserves every prior binding and selects the qualified precision-corrected CPU profiles', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  expect(catalogue.epoch).toBe(16);
  expect(catalogue.profiles).toHaveLength(162);
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
  expect(desktopImageModelKeys.ocr['PP-OCRv5_mobile']).toBe(catalogue.profiles[35].modelKey);
  expect(desktopImageModelKeys.face.buffalo_l).toBe(catalogue.profiles[36].modelKey);
});
it('validates the approved default model and preserves exact config, source and provider identity', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  expect(catalogue.profiles).toHaveLength(162);
  for (const profile of catalogue.profiles) {
    if (profile.workload !== 'clip') continue;
    expect(profile.embeddingDimensions).toBe(CLIP_MODEL_INFO[profile.modelName].dimSize);
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
        // a selectable model the release has no profile for
        'ViT-B-16-SigLIP2__webli',
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
  // the whole catalogue is parsed again for every change
}, 60_000);

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
    'f27d2e6a303cff1789e855e0f1561a3a04b030639d4ff789800394a6ead51b94',
    '064de008feb79e0ce67642f2613a17a33479e9238ef0ccc58db3eb5571bd8a77',
    'a40b7628bbc61c2dbab819e83fae6bc738e4e5d0fba06eed749bede91c1dba70',
    '207621ca4431e3358137b8ce4a742887b0db1e003b78548ea8fc36209a25512e',
    'b3c98ec6de5f9e761a62044b8a261dc66d6273eff91f4a40fe7a9f97ea7f1016',
    '25c77459eda63cc99a54f72320de3d0ef2029ce9a0c7d239eea62e24c499ad24',
    '5b33ebee9460aa445513f196cc73597daa3f874ea2b527801f18bc67121f0759',
    '6a1a473fc90069f0b222e697272cb1a78f8fadd4a1c52af7e42ed3d6eb8bb37e',
    '194ab4b05a9b81e28466bc4341bd26d3c80349f3508f701ae63c9569a11a4d58',
    'efa3e6033ea6b6c6aa769444ef5e3ba2432f1ed236ed37d919083edf255c5452',
    '9e8cc701380276c1af1036c3493460904e91b6dc3c49193100f2733b244fed1f',
    '994248b4729d33ae1dfc09365b7fd56f4949f80f15e1a6d4608b256b5308e54c',
    '003981e4139fad9a251f21c59a89824c06a109640a358a8367683bd6b865cd4c',
    '439a10ed09c75b25a0a4e39df0928e4636f6cc71eb73fecffa3eda028cbf4738',
    'c7d74c2feef0e1abd8ab48c519338f7d2bbebd7b5785544d21729dadb7231742',
    '8ae4a97bd0e176b44e519bf6c850310979364b986bd0f113913d3fe4df43fcf7',
    '9c3beed723095dbca064cc7b8af523d703fe249740367b9cb6d1ebc034ae2ab6',
    'c6af78be57ce709d21297e95b4be5030212ecd52d140899983dbd9f56fef9873',
    '9b285e797d131b12e0a583a467d11ab107610d4b81c196e6b438f274296d3657',
    '933b0789ec4350b99e64b3cb3b6d6bccaa850c54868131116a331a751ee60836',
    'b6a672e4e27b03b749c4a93801f79803ae1faf92eaab9694539c9b1361a0160b',
    '11ef055a3ba652e3231037eda669596ae0c141d79a19ec5bb255e3f719fc3309',
    'fdbf9b5a1e0573f59dd0842d2e543e9d71e4a2ce4fcc1ce36082302dcca2a263',
    'f651de490bf0ca761c0f475a2f4cf72cfa74bf1498cda30e2e12b7c25fbfd615',
    'b60e9e5b4a848a98ff3732ff961bcde2516d7b915b99299426d9631f36c34d1b',
    'd1ffb882c8508f0e4d37d03b84ece09a3311ebce7c53324a63b972e17dcf81cf',
    '69e9528ebf2333b497346eb8a786cbc1e029902a360f66d093396b1d93298105',
    '9037f282ae92ec3906fd5fd543de5f50954790b80a73a65168bde38633532895',
    '44138e82b6571ef566be87863442e5496e84dc294107aadf38608db00289d4da',
    '5c79f0a79976a2febed2381b0ff57e1fe6698947857327ff2d356fe925f736fc',
    '7131c1c5d18fe4d38ebf2654012e8f224a85e5dfd55aebd276579ee1554a3d5f',
    '4a42dc6f14a18a1aad75221992118a78aa96259ac0ba2cc686e29c02d684f7b1',
    '0429e7033b3ff53bf003e5f41514f3e22cdb2a372382f3e54cd8430474d5ff70',
    'c41e72990bd1faa690e43735707f2ed5191a367cea165c8188c2347243d9a3ce',
    '88430bcfd76c9853b392e5e99efc6c85bfff348e95e9ddba2ce2fcd5e205bbc8',
    'f3cec2f18b98eb7b266f19fcbfbf2e768205786813ab32c1877552ea7f8ed969',
    'f7ec69608f3bbd197f2095305ae237fbb92adefefcbb81427e6f16b7fc07aba4',
    'e816bfa65037eb5cf31c9f15235a5e62e28afeef93f55cfe067fac0b1f9e69a4',
    '79f6a6828171d0ac79d0a1b7b46e5bc495707ca354eee47685c0e3990d1a78f3',
    '3f3a667881b789ee7910f66d642ccb2f2988e31356845bfdaabebee2cca0f475',
    '988bea3533a79c9092e4ddd093041311fdc94dadcc7929c5418a538b940817e3',
    'f4fd2d89d61c68add788954f3eaa46e72446e709dee68a67653f54b56ff69c7f',
    'abc7407292f1b815c9f3694275e3a8bb130adafb0b48d2ad3396580c05f3e552',
    'b7d1e04824d89660c67265de02b9702c28df5364181318ce9ba6afc9813b75da',
    'e3a49032696ca9abb0369f90ecc530e3bbc36a371834a20a1250f1b96ec14052',
    '1904b558975efc5e39f122b7e2203bf750f9b704ac4f1e2136db1b52d474383e',
    'cdad3bb06fd2d2d90b508cd873dee95956d4da36d9c74b64841e7c502d0dd966',
    '4b8b16bf798bb5aec952a42b251ef33150e429ef04851f3031fe052a1e5a4996',
    '02bc91e1c3f4081ad6d1e5e1dc992616ba1c142e5b04c1f9f3f2e78f3e352b5e',
    '2ce10598215ef4ab45f4fcc38c3ae39c7bea261e742a21d10f7c67f7579f4095',
  ];
  // an epoch 14 twin has its original's specification, so its digest: only the runtime source differs
  expected.push(
    ...catalogue.profiles
      .slice(0, 102)
      .flatMap((profile, index) =>
        profile.runtimeSourceRevision === 'f2c451a6bf71ca3f3aec986e07f0852937268e2f' ? [expected[index]] : [],
      ),
  );
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
  expect(catalogue.profiles).toHaveLength(162);
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
  expect(catalogue.epoch).toBe(16);
  expect(catalogue.profiles).toHaveLength(162);
  expect(
    createHash('sha256')
      .update(canonicalJson(catalogue.profiles.slice(0, 32)))
      .digest('hex'),
  ).toBe('22b8e3fa22858c0422bed4c4cbee128e44d111775fef176f71bfa499269f5ec8');
  for (const provider of ['CPUExecutionProvider', 'CoreMLExecutionProvider']) {
    // the epoch 11 group; epoch 13 appends other models for the same runtime
    const selected = catalogue.profiles
      .slice(0, 52)
      .filter(
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
  expect(catalogue.epoch).toBe(16);
  expect(catalogue.profiles).toHaveLength(162);
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

it('epoch 13 qualifies every selectable model the desktop runtimes can run and keeps every prior binding', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  expect(catalogue.epoch).toBe(16);
  expect(catalogue.profiles).toHaveLength(162);
  expect(
    createHash('sha256')
      .update(canonicalJson(catalogue.profiles.slice(0, 42)))
      .digest('hex'),
  ).toBe('55de0a4da603339578721080a8eca52ef7a9beb32ca28d4b52aa58d798a49d5d');
  const models = [
    ['clip', 'ViT-B-32__openai'],
    ['clip', 'ViT-B-32__openai'],
    ['clip', 'ViT-B-32__openai'],
    ['clip', 'ViT-SO400M-16-SigLIP2-384__webli'],
    ['clip', 'ViT-SO400M-16-SigLIP2-384__webli'],
    ['clip', 'ViT-SO400M-16-SigLIP2-384__webli'],
    ['ocr', 'PP-OCRv5_server'],
    ['face', 'antelopev2'],
    ['face', 'buffalo_s'],
    ['face', 'buffalo_m'],
  ];
  for (const [offset, source, preprocessing] of [
    [52, '25b22c16e47a27a2eb50017d838497abce850d11', 'c1e21e7f'],
    [62, 'f2c451a6bf71ca3f3aec986e07f0852937268e2f', '8d9fc77d'],
  ] as const) {
    const added = catalogue.profiles.slice(offset, offset + 10);
    expect(added.map((p) => [p.workload, p.modelName])).toEqual(models);
    for (const profile of added) {
      expect(profile.runtimeSourceRevision).toBe(source);
      expect(profile.spec.provider).toBe('CPUExecutionProvider');
      expect(profile.spec.preprocessingSha256.slice(0, 8)).toBe(preprocessing);
    }
  }
  for (const [offset, provider] of [
    [72, 'CoreMLExecutionProvider'],
    [82, 'CUDAExecutionProvider'],
    [92, 'OpenVINOExecutionProvider'],
  ] as const) {
    for (let index = 0; index < 10; index++) {
      const cpu = catalogue.profiles[62 + index];
      const twin = catalogue.profiles[offset + index];
      expect(twin.spec.provider).toBe(provider);
      expect({ ...twin, spec: { ...twin.spec, provider: 'CPUExecutionProvider' } }).toEqual(cpu);
    }
  }
  // Each released face/OCR default is the precision-corrected CPU profile of that model.
  for (const workload of ['ocr', 'face'] as const) {
    for (const [modelName, key] of Object.entries(desktopImageModelKeys[workload])) {
      const profile = catalogue.profiles.find((p) => p.modelKey === key)!;
      expect([profile.workload, profile.modelName, profile.runtimeSourceRevision]).toEqual([
        workload,
        modelName,
        'f2c451a6bf71ca3f3aec986e07f0852937268e2f',
      ]);
      expect(desktopImageModelKey(workload, modelName)).toBe(key);
    }
    expect(desktopImageModelKey(workload, 'constructor')).toBeUndefined();
  }
});

it('epoch 14 appended a twin of every f2c451a6 profile; epoch 16 names the runtime source that works on every provider', () => {
  const catalogue = parseDesktopModelCatalogue(raw());
  expect(catalogue.epoch).toBe(16);
  expect(catalogue.profiles).toHaveLength(162);
  expect(
    createHash('sha256')
      .update(canonicalJson(catalogue.profiles.slice(0, 102)))
      .digest('hex'),
  ).toBe('3f080358db3bfd856755e7f48b43e057cea1c0ce67e6cde15c4441eac347e2f3');
  const previous = 'f2c451a6bf71ca3f3aec986e07f0852937268e2f';
  const source = 'b3905b4aebd22e48a1a3843c2831efcef543336e';
  const originals = catalogue.profiles.slice(0, 102).filter((p) => p.runtimeSourceRevision === previous);
  const twins = catalogue.profiles.slice(102);
  expect(originals).toHaveLength(60);
  for (const [index, twin] of twins.entries()) {
    // the same model key, files, fixture, preprocessing and reference output: only the runtime source differs
    expect(twin.runtimeSourceRevision).toBe(source);
    expect({ ...twin, runtimeSourceRevision: previous }).toEqual(originals[index]);
    expect(matchDesktopModelProfile(catalogue, twin.modelName, twin.spec.entries, source, twin.spec.provider)).toEqual(
      twin,
    );
  }
  for (const provider of [
    'CPUExecutionProvider',
    'CoreMLExecutionProvider',
    'CUDAExecutionProvider',
    'OpenVINOExecutionProvider',
  ])
    expect(twins.filter((p) => p.spec.provider === provider)).toHaveLength(15);
  // a released default key still resolves to the same profile content, whichever source serves it
  for (const workload of ['ocr', 'face'] as const)
    for (const key of Object.values(desktopImageModelKeys[workload]))
      expect(twins.some((p) => p.modelKey === key && p.spec.provider === 'CPUExecutionProvider')).toBe(true);
});
