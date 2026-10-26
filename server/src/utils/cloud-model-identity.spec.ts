import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MlWorkload } from 'src/enum.js';
import {
  type CloudModelIdentity,
  CloudModelIdentityMismatchError,
  type ReleasedModels,
  acceptCloudClipResult,
  acceptCloudFaceResult,
  cloudIdentityProblem,
  localPinnedIdentity,
  localPinnedProfile,
  matchLocalModels,
  sameModelIdentity,
  withCloudIdentityGuard,
} from 'src/utils/cloud-model-identity.js';
import { parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { parseLocalModelPins } from 'src/utils/local-model-pins.js';

const SIGLIP = 'ViT-B-16-SigLIP-384__webli';

const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop', name), 'utf8'));
/** The release files as the guard reads them, for a test that swaps one of them. */
const released = (): ReleasedModels => {
  const catalogue = parseDesktopModelCatalogue(read('model-catalogue.json'));
  return {
    catalogue,
    spaces: parseDesktopClipSpaces(read('model-spaces.json'), catalogue),
    pins: parseLocalModelPins(read('model-pins.json')),
  };
};
const clipPin = () => localPinnedIdentity(MlWorkload.Clip, SIGLIP)!;
const facePin = () => localPinnedIdentity(MlWorkload.Face, 'buffalo_l')!;

describe('the local pin (FL-455)', () => {
  it("reads smart search's identity from the release pin, image encoder only", () => {
    const pin = clipPin();
    expect(pin).toMatchObject({
      name: SIGLIP,
      repo: `frameleaf/${SIGLIP}`,
      revision: '77dda0dfc7afd494b918ec174cddca24854a73d1',
      preprocess: 'frameleaf-clip-visual/1',
      output: { dim: 768, dtype: 'float32', normalized: false },
    });
    expect(pin.files).toContainEqual({
      path: 'visual/model.onnx',
      bytes: 372_841_652,
      sha256: 'c2a7778f7529bbf8812d74627b7a2b280e95c4537cbe6c039152a6788d0ddc63',
    });
    expect(pin.files.some((file) => file.path.startsWith('textual/'))).toBe(false);
    expect(pin.files.some((file) => file.path.startsWith('models--') || file.path.endsWith('.md'))).toBe(false);
  });

  it("reads faces' identity from the release pin", () => {
    expect(facePin()).toEqual({
      name: 'buffalo_l',
      repo: 'frameleaf/buffalo_l',
      revision: 'd09715916a0778919a770c343533641e250b8699',
      files: [
        {
          path: 'detection/model.onnx',
          bytes: 16_923_827,
          sha256: '5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91',
        },
        {
          path: 'recognition/model.onnx',
          bytes: 174_383_860,
          sha256: '4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43',
        },
      ],
      preprocess: 'frameleaf-face/3',
      output: { dim: 512, dtype: 'float32', normalized: false },
    });
  });

  it('pins nothing for a model the release neither qualifies nor pins, so the cloud is never offered for it', () => {
    expect(localPinnedIdentity(MlWorkload.Clip, 'ViT-B-16-SigLIP2__webli')).toBeNull();
    expect(localPinnedIdentity(MlWorkload.Face, 'buffalo_s')).toBeNull();
    expect(localPinnedIdentity(MlWorkload.Clip, 'antelopev2')).toBeNull();
    expect(localPinnedIdentity(MlWorkload.Face, 'ViT-B-32__openai')).toBeNull();
  });

  it("reads ViT-B-32's identity from the release's Cloud pin (A3), image encoder only", () => {
    const pin = localPinnedIdentity(MlWorkload.Clip, 'ViT-B-32__openai')!;
    expect(pin).toEqual({
      name: 'ViT-B-32__openai',
      repo: 'frameleaf/ViT-B-32__openai',
      revision: 'a857c8de2c07bbcfa6646adfcf31b798845afa1e',
      files: [
        { path: 'config.json', bytes: 196, sha256: '59a182a6dce0adeb303f3d72d73758d68ba29516d928dd92740465f498290409' },
        {
          path: 'visual/model.onnx',
          bytes: 351_613_724,
          sha256: '33a3df41ceef21acdf371af00f6dd0456ec1f9eba24d03a7720f9c3734e40859',
        },
        {
          path: 'visual/preprocess_cfg.json',
          bytes: 197,
          sha256: 'c4fd008cd177c58a8fe107b099bac98913eaa6be6114dd59a4b45145c3c7673f',
        },
      ],
      preprocess: 'frameleaf-clip-visual/1',
      output: { dim: 512, dtype: 'float32', normalized: false },
    });
    // the pin carries the text tower the server needs, which the identity leaves out
    const profile = localPinnedProfile(MlWorkload.Clip, 'ViT-B-32__openai')!;
    expect(profile.spec.models[0].artifacts['textual/model.onnx']).toBe(
      'b80cf0af751533a6712d92247f0ddc0c95208748bc59a1a27f33e67be6864e3b',
    );
    expect(profile.artifactBytes['textual/model.onnx']).toBe(254_193_396);
    expect(profile.modelKey).toMatch(/^clip:[\da-f]{64}$/);
  });

  it("reads antelopev2's identity from the release's Cloud pin (A3)", () => {
    expect(localPinnedIdentity(MlWorkload.Face, 'antelopev2')).toEqual({
      name: 'antelopev2',
      repo: 'frameleaf/antelopev2',
      revision: '51ca7e153bccebdbae224779e23c9c243e2fec85',
      files: [
        {
          path: 'detection/model.onnx',
          bytes: 16_923_827,
          sha256: '5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91',
        },
        {
          path: 'recognition/model.onnx',
          bytes: 260_665_334,
          sha256: '4ab1d6435d639628a6f3e5008dd4f929edf4c4124b1a7169e1048f9fef534cdf',
        },
      ],
      preprocess: 'frameleaf-face/3',
      output: { dim: 512, dtype: 'float32', normalized: false },
    });
  });

  it('prefers a qualified catalogue profile over a pin of the same model', () => {
    const qualified = localPinnedProfile(MlWorkload.Face, 'buffalo_l')!;
    const pins = parseLocalModelPins(
      JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-pins.json'), 'utf8')),
    );
    const antelope = pins.pins.find((pin) => pin.modelName === 'antelopev2')!;
    const models = {
      ...released(),
      pins: { ...pins, pins: [{ ...antelope, modelName: 'buffalo_l', modelKey: antelope.modelKey }] },
    };
    // the catalogue's profile (with its fixture and reference output) stays the pin, not the entry
    expect(localPinnedProfile(MlWorkload.Face, 'buffalo_l', models)!.modelKey).toBe(qualified.modelKey);
    expect(localPinnedProfile(MlWorkload.Face, 'antelopev2', models)).toBeNull();
  });
});

describe(sameModelIdentity.name, () => {
  it.each(['frameleaf-face/1', 'frameleaf-face/2'])('refuses the earlier face preprocessing %s', (preprocess) => {
    const pin = facePin();
    expect(pin.preprocess).toBe('frameleaf-face/3');
    expect(sameModelIdentity({ ...pin, preprocess }, pin)).toBe(false);
  });

  it('uses the same face preprocessing version as the golden-set producer', () => {
    const producer = readFileSync(join(import.meta.dirname, '../../../machine-learning/scripts/golden_set.py'), 'utf8');
    expect(producer.match(/^FACE_PREPROCESS = "([^"]+)"$/m)?.[1]).toBe(facePin().preprocess);
  });
  it('ignores file order and keys this server does not compare', () => {
    const pin = clipPin();
    const claimed = { ...pin, files: pin.files.toReversed(), upstream: 'elsewhere' } as CloudModelIdentity;
    expect(sameModelIdentity(claimed, pin)).toBe(true);
  });

  it('refuses another revision, file, preprocessing or output', () => {
    const pin = clipPin();
    expect(sameModelIdentity({ ...pin, revision: 'a'.repeat(40) }, pin)).toBe(false);
    expect(
      sameModelIdentity({ ...pin, files: pin.files.map((file) => ({ ...file, sha256: 'b'.repeat(64) })) }, pin),
    ).toBe(false);
    expect(sameModelIdentity({ ...pin, files: pin.files.slice(1) }, pin)).toBe(false);
    expect(sameModelIdentity({ ...pin, preprocess: 'frameleaf-clip-visual/2' }, pin)).toBe(false);
    expect(sameModelIdentity({ ...pin, output: { ...pin.output, normalized: true } }, pin)).toBe(false);
    expect(sameModelIdentity({ ...pin, name: 'other', repo: 'frameleaf/other' }, pin)).toBe(false);
  });
});

describe(matchLocalModels.name, () => {
  const names = { [MlWorkload.Clip]: SIGLIP, [MlWorkload.Face]: 'buffalo_l' };

  it('picks the catalogue model that is exactly this server’s model, per workload', () => {
    const entries = [
      { sku: 'ms_other', workload: 'clip', identity: { ...clipPin(), revision: 'c'.repeat(40) } },
      { sku: 'ms_clip', workload: 'clip', identity: clipPin() },
      { sku: 'ms_face', workload: 'face', identity: facePin() },
      { sku: 'ms_desc', workload: 'descriptions', identity: null },
    ];
    expect(matchLocalModels(entries, names)).toEqual({ [MlWorkload.Clip]: 'ms_clip', [MlWorkload.Face]: 'ms_face' });
  });

  it('matches nothing when the catalogue offers none, as today', () => {
    expect(matchLocalModels([], names)).toEqual({});
    expect(matchLocalModels([{ sku: 'ms_clip', workload: 'clip', identity: clipPin() }], {})).toEqual({});
  });

  it('never matches a face model under smart search or the other way round', () => {
    expect(matchLocalModels([{ sku: 'ms_face', workload: 'clip', identity: facePin() }], names)).toEqual({});
  });
});

describe('accepting a Cloud result (FL-455)', () => {
  const clipProfile = () => localPinnedProfile(MlWorkload.Clip, SIGLIP);
  const clipResult = {
    clip: JSON.stringify(Array.from({ length: 768 }, () => 0.01)),
    imageWidth: 1440,
    imageHeight: 1080,
  };

  it('stores a result made by the pinned model like a bound local result', () => {
    const profile = clipProfile()!;
    expect(acceptCloudClipResult(profile, { identity: clipPin(), result: clipResult })).toEqual({
      embedding: clipResult.clip,
      modelKey: profile.modelKey,
    });
  });

  it('rejects a result from another model, or with no identity', () => {
    const profile = clipProfile();
    expect(() =>
      acceptCloudClipResult(profile, { identity: { ...clipPin(), revision: 'd'.repeat(40) }, result: clipResult }),
    ).toThrow(CloudModelIdentityMismatchError);
    expect(() => acceptCloudClipResult(profile, { identity: undefined, result: clipResult })).toThrow(
      CloudModelIdentityMismatchError,
    );
    expect(() => acceptCloudClipResult(null, { identity: clipPin(), result: clipResult })).toThrow(
      CloudModelIdentityMismatchError,
    );
    expect(() =>
      acceptCloudFaceResult(localPinnedProfile(MlWorkload.Face, 'buffalo_l'), { identity: clipPin(), result: {} }),
    ).toThrow(CloudModelIdentityMismatchError);
  });

  it('says why an identity is refused', () => {
    expect(cloudIdentityProblem(MlWorkload.Clip, clipProfile(), clipPin())).toBeNull();
    expect(cloudIdentityProblem(MlWorkload.Clip, clipProfile(), { ...clipPin(), preprocess: 'x/9' })).toMatch(
      /preprocessing/,
    );
  });

  it('runs the work locally when the cloud result is rejected, and only then', async () => {
    const local = vi.fn().mockResolvedValue('local');
    const onRejected = vi.fn();
    const accept = (value: { identity: unknown }) => {
      if (value.identity !== 'pinned') {
        throw new CloudModelIdentityMismatchError(MlWorkload.Clip, 'another model');
      }
      return 'cloud';
    };

    await expect(
      withCloudIdentityGuard({
        cloud: () => Promise.resolve({ identity: 'pinned', result: {} }),
        accept,
        local,
        onRejected,
      }),
    ).resolves.toBe('cloud');
    expect(local).not.toHaveBeenCalled();

    await expect(
      withCloudIdentityGuard({
        cloud: () => Promise.resolve({ identity: 'other', result: {} }),
        accept,
        local,
        onRejected,
      }),
    ).resolves.toBe('local');
    expect(onRejected).toHaveBeenCalledWith(expect.any(CloudModelIdentityMismatchError));
  });

  it('does not hide other failures behind a local run', async () => {
    const local = vi.fn();
    await expect(
      withCloudIdentityGuard({
        cloud: () => Promise.resolve({ identity: 'x', result: {} }),
        accept: () => {
          throw new Error('producer_result_invalid');
        },
        local,
      }),
    ).rejects.toThrow('producer_result_invalid');
    expect(local).not.toHaveBeenCalled();
  });
});
