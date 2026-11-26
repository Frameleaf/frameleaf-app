import { readFileSync } from 'node:fs';
import { defaults } from 'src/config.js';
import { DesktopModelInventoryDto, DesktopModelInventoryRequestSchema } from 'src/dtos/desktop-model-inventory.dto.js';
import { MlWorkload } from 'src/enum.js';
import { parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { selectDesktopModelInventory } from 'src/utils/desktop-model-inventory.js';

const catalogue = parseDesktopModelCatalogue(
  JSON.parse(readFileSync('resources/desktop/model-catalogue.json', 'utf8')),
);
const spaces = parseDesktopClipSpaces(
  JSON.parse(readFileSync('resources/desktop/model-spaces.json', 'utf8')),
  catalogue,
);
const request = { provider: 'CPUExecutionProvider', runtimeSourceRevision: 'f2c451a6bf71ca3f3aec986e07f0852937268e2f' };
const setup = () => ({
  ...request,
  catalogue,
  spaces,
  config: structuredClone(defaults.machineLearning),
});
it.each(['CPUExecutionProvider', 'CoreMLExecutionProvider'])(
  'advertises complete compiled groups for %s from the settings alone',
  (provider) => {
    const input = { ...setup(), provider };
    const original = structuredClone(input);
    const result = selectDesktopModelInventory(input);
    expect(result.map(({ workload, state, modelKeys }) => [workload, state, modelKeys.length])).toEqual([
      [MlWorkload.Clip, 'eligible', 3],
      [MlWorkload.Ocr, 'eligible', 1],
      [MlWorkload.Face, 'eligible', 1],
      [MlWorkload.Enrichment, 'unsupported', 0],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/localhost|frameleaf-machine-learning|destinationId/);
    expect(input).toEqual(original);
    expect(
      DesktopModelInventoryDto.schema.parse({ protocolVersion: 1, ...request, provider, workloads: result }),
    ).toBeDefined();
  },
);
it.each(['model', 'options', 'provider', 'source'])('does not substitute another %s', (change) => {
  const input = setup();
  switch (change) {
    case 'model': {
      input.config.facialRecognition.modelName = 'yunet_sface';
      break;
    }
    case 'options': {
      input.config.facialRecognition.minScore = 0.8;
      break;
    }
    case 'provider': {
      // a provider the release has no profile for (CUDA and OpenVINO twins exist since epoch 12)
      input.provider = 'MIGraphXExecutionProvider';
      break;
    }
    case 'source': {
      input.runtimeSourceRevision = 'f'.repeat(40);
      // No default
      break;
    }
  }
  const result = selectDesktopModelInventory(input);
  expect(result[2]).toMatchObject({ state: 'unsupported', modelKeys: [] });
  if (change === 'model' || change === 'options') expect(result[1].state).toBe('eligible');
});
it('keeps disabled models disabled', () => {
  const input = setup();
  input.config.facialRecognition.enabled = false;
  expect(selectDesktopModelInventory(input)[2]).toMatchObject({ state: 'disabled', modelKeys: [] });
  expect(selectDesktopModelInventory(input)[1].state).toBe('eligible');
  input.config.enabled = false;
  expect(
    selectDesktopModelInventory(input).every((item) => item.state === 'disabled' && item.modelKeys.length === 0),
  ).toBe(true);
});
it('rejects protocol/request additions and keys in a refused inventory entry', () => {
  expect(() => DesktopModelInventoryRequestSchema.parse({ ...request, url: 'https://untrusted.invalid' })).toThrow();
  const workloads = selectDesktopModelInventory(setup());
  workloads[2].state = 'pinned';
  expect(() => DesktopModelInventoryDto.schema.parse({ protocolVersion: 1, ...request, workloads })).toThrow();
});

it.each([
  '25b22c16e47a27a2eb50017d838497abce850d11',
  '1ca4d52e2b8158d89d8de8b17e1e6535e17691f4',
  'f93c34d196955da3e2760c095c08b27ccbf53315',
])('retains legacy CLIP spaces but refuses outdated default image producer %s', (source) => {
  const input = setup();
  input.runtimeSourceRevision = source;
  expect(
    selectDesktopModelInventory(input)
      .slice(0, 3)
      .map(({ state }) => state),
  ).toEqual(['eligible', 'unsupported', 'unsupported']);
});

it('offers all qualified current-main CPU groups without changing model configuration', () => {
  const input = setup();
  input.runtimeSourceRevision = 'f2c451a6bf71ca3f3aec986e07f0852937268e2f';
  const original = structuredClone(input);
  const result = selectDesktopModelInventory(input);
  expect(result.slice(0, 3).map(({ state, modelKeys }) => [state, modelKeys.length])).toEqual([
    ['eligible', 3],
    ['eligible', 1],
    ['eligible', 1],
  ]);
  expect(input).toEqual(original);
});

it.each([
  ['ViT-B-32__openai', 'buffalo_s', 'PP-OCRv5_server'],
  ['ViT-SO400M-16-SigLIP2-384__webli', 'antelopev2', 'PP-OCRv5_mobile'],
  ['ViT-B-16-SigLIP-384__webli', 'buffalo_m', 'PP-OCRv5_server'],
])('offers the released groups of the selected %s, %s and %s', (clip, face, ocr) => {
  for (const provider of ['CPUExecutionProvider', 'CoreMLExecutionProvider', 'CUDAExecutionProvider']) {
    const input = { ...setup(), provider };
    input.config.clip.modelName = clip;
    input.config.facialRecognition.modelName = face;
    input.config.ocr.modelName = ocr;
    const result = selectDesktopModelInventory(input);
    expect(result.slice(0, 3).map(({ state, modelNames, modelKeys }) => [state, modelNames, modelKeys.length])).toEqual(
      [
        ['eligible', [clip], 3],
        ['eligible', [ocr], 1],
        ['eligible', [face], 1],
      ],
    );
    for (const key of result.flatMap((item) => item.modelKeys)) {
      expect(catalogue.profiles.find((p) => p.modelKey === key && p.spec.provider === provider)?.modelName).toBe(
        key.startsWith('clip:') ? clip : key.startsWith('face:') ? face : ocr,
      );
    }
  }
});
it('offers a newly qualified search model to the factory desktop runtime, which still refuses outdated image producers', () => {
  const input = setup();
  input.runtimeSourceRevision = '25b22c16e47a27a2eb50017d838497abce850d11';
  input.config.clip.modelName = 'ViT-SO400M-16-SigLIP2-384__webli';
  input.config.facialRecognition.modelName = 'antelopev2';
  expect(
    selectDesktopModelInventory(input)
      .slice(0, 3)
      .map(({ state, modelKeys }) => [state, modelKeys.length]),
  ).toEqual([
    ['eligible', 3],
    ['unsupported', 0],
    ['unsupported', 0],
  ]);
});

it('FD-31: offers descriptions when the configured model has a desktop build for this runtime', () => {
  const profile = parseDesktopModelCatalogue({
    schemaVersion: 1,
    epoch: 19,
    profiles: [JSON.parse(readFileSync('test/fixtures/desktop-description-profile.json', 'utf8'))],
  }).profiles[0];
  const input = {
    ...setup(),
    catalogue: { ...catalogue, profiles: [...catalogue.profiles, profile] },
    runtimeSourceRevision: profile.runtimeSourceRevision,
  };
  input.config.imageDescription = {
    ...input.config.imageDescription,
    enabled: true,
    modelName: 'Qwen/Qwen2.5-VL-7B-Instruct',
  };
  const enrichment = () =>
    selectDesktopModelInventory(input).find(({ workload }) => workload === MlWorkload.Enrichment);
  expect(enrichment()).toMatchObject({ state: 'eligible', modelKeys: [profile.modelKey] });
  expect(
    DesktopModelInventoryDto.schema.parse({
      protocolVersion: 1,
      provider: input.provider,
      runtimeSourceRevision: input.runtimeSourceRevision,
      workloads: selectDesktopModelInventory(input),
    }),
  ).toBeDefined();
  // another model, another runtime or the processor's own profile on CoreML: none
  input.config.imageDescription.modelName = 'Qwen/Qwen2.5-VL-3B-Instruct';
  expect(enrichment()?.state).toBe('unsupported');
  input.config.imageDescription.modelName = 'Qwen/Qwen2.5-VL-7B-Instruct';
  expect(selectDesktopModelInventory({ ...input, provider: 'CoreMLExecutionProvider' })[3].state).toBe('unsupported');
  input.config.imageDescription.enabled = false;
  input.config.nsfwDetection.enabled = false;
  expect(enrichment()?.state).toBe('disabled');
});
