import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MlWorkload } from 'src/enum.js';
import {
  type CloudModelIdentity,
  CloudModelIdentityMismatchError,
  acceptCloudClipResult,
  acceptCloudFaceResult,
  cloudIdentityProblem,
  localPinnedIdentity,
  localPinnedProfile,
  matchLocalModels,
  sameModelIdentity,
  withCloudIdentityGuard,
} from 'src/utils/cloud-model-identity.js';

const SIGLIP = 'ViT-B-16-SigLIP-384__webli';

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

  it('pins nothing for a model the release does not pin, so the cloud is never offered for it', () => {
    expect(localPinnedIdentity(MlWorkload.Clip, 'ViT-B-32__openai')).toBeNull();
    expect(localPinnedIdentity(MlWorkload.Face, 'antelopev2')).toBeNull();
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
