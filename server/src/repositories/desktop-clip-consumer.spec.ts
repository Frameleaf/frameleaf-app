import { readFileSync } from 'node:fs';
import type { MockInstance } from 'vitest';
import { defaults } from 'src/config.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MachineLearningBindingRefusedError,
  MachineLearningRepository,
  type MlSelection,
} from 'src/repositories/machine-learning.repository.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';

const profiles = parseDesktopModelCatalogue(
  JSON.parse(readFileSync(new URL('../../resources/desktop/model-catalogue.json', import.meta.url), 'utf8')),
).profiles;
const selection: MlSelection = {
  destinationId: 'selected',
  kind: MlDestinationKind.Lan,
  workload: MlWorkload.Clip,
  endpoint: { url: 'https://selected.invalid' },
  record: vi.fn(),
};
const binding = { revisionId: 'revision', space: {} };
let index: Record<'selectProfile' | 'assertCurrent' | 'admitServerVectors', ReturnType<typeof vi.fn>>;
let ml: MachineLearningRepository;
beforeEach(() => {
  index = {
    selectProfile: vi.fn(),
    assertCurrent: vi.fn().mockResolvedValue(undefined),
    admitServerVectors: vi.fn().mockResolvedValue(undefined),
  };
  ml = new MachineLearningRepository(
    LoggingRepository.create(),
    undefined,
    undefined,
    undefined,
    index as unknown as DesktopClipIndexRepository,
  );
  ml.setup(defaults.machineLearning);
});
it('uses bound image output with provenance and rechecks the index before returning', async () => {
  const profile = profiles.find((p) => p.spec.fixtureKind === 'image')!;
  index.selectProfile.mockResolvedValue({ binding, profile });
  const result = { embedding: '[0.1]', modelKey: profile.modelKey };
  const bound = vi.spyOn(ml, 'encodeBoundClip').mockResolvedValue(result);
  expect(
    await ml.encodeImage(selection, '/synthetic/image', {
      ...defaults.machineLearning.clip,
      modelName: profile.modelName,
    }),
  ).toEqual(result);
  expect(bound).toHaveBeenCalledWith(selection, { imagePath: '/synthetic/image' }, profile);
  expect(index.assertCurrent).toHaveBeenCalledWith(binding);
});
it('keeps text query output as a string and description output with producer identity', async () => {
  const profile = profiles[0];
  index.selectProfile.mockResolvedValue({ binding, profile });
  const result = { embedding: '[0.1]', modelKey: profile.modelKey };
  vi.spyOn(ml, 'encodeBoundClip').mockResolvedValue(result);
  expect(await ml.encodeText(selection, 'query', { modelName: profile.modelName, language: 'en' })).toBe(
    result.embedding,
  );
  expect(index.selectProfile).toHaveBeenCalledWith(profile.modelName, 'text', 'en');
  expect(await ml.encodeTextWithProvenance(selection, 'description', { modelName: profile.modelName })).toEqual(result);
});
it.each(['selection', 'inference', 'revision'])('refuses %s failure without legacy fallback', async (stage) => {
  const profile = profiles.find((p) => p.spec.fixtureKind === 'image')!;
  index.selectProfile.mockResolvedValue({ binding, profile });
  const bound = vi.spyOn(ml, 'encodeBoundClip').mockResolvedValue({ embedding: '[0.1]', modelKey: profile.modelKey });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  switch (stage) {
    case 'selection': {
      index.selectProfile.mockRejectedValue(new Error('refused'));
      break;
    }
    case 'inference': {
      bound.mockRejectedValue(new Error('refused'));
      break;
    }
    case 'revision': {
      index.assertCurrent.mockRejectedValue(new Error('refused'));
      // No default
      break;
    }
  }
  await expect(
    ml.encodeImage(selection, '/synthetic/image', { ...defaults.machineLearning.clip, modelName: profile.modelName }),
  ).rejects.toThrow('refused');
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('names caches with the admitted revision and exact text producer', async () => {
  const profile = profiles[0];
  index.selectProfile.mockResolvedValue({ binding, profile });
  expect(await ml.clipCacheKey(profile.modelName)).toBe(`revision:${profile.modelKey}`);
  index.selectProfile.mockResolvedValue(undefined);
  expect(await ml.clipCacheKey(profile.modelName)).toBe('legacy');
});

it.each(['image', 'text'])('refuses legacy %s output when admission occurs during inference', async (kind) => {
  index.selectProfile.mockResolvedValue(undefined);
  Object.assign(index, { getActive: vi.fn().mockResolvedValue(binding) });
  vi.spyOn(ml as unknown as { predict: () => Promise<unknown> }, 'predict').mockResolvedValue({ clip: '[0.1]' });
  await expect(
    kind === 'image'
      ? ml.encodeImage(selection, '/synthetic/image', defaults.machineLearning.clip)
      : ml.encodeText(selection, 'query', { modelName: 'legacy' }),
  ).rejects.toThrow('desktop_clip_index_changed');
});

describe('this server’s own AI after a desktop was granted smart search', () => {
  const image = profiles.find((p) => p.spec.fixtureKind === 'image')!;
  const text = profiles.find((p) => p.spec.fixtureKind === 'text' && p.modelName === image.modelName)!;
  const refused = () => new MachineLearningBindingRefusedError('names a model identity this worker does not serve');
  const encode = () =>
    ml.encodeImage(selection, '/synthetic/image', { ...defaults.machineLearning.clip, modelName: image.modelName });
  let plain: MockInstance;
  beforeEach(() => {
    index.selectProfile.mockImplementation((_name: string, kind: string) => ({
      binding,
      profile: kind === 'image' ? image : text,
    }));
    plain = vi
      .spyOn(ml as unknown as { predict: () => Promise<unknown> }, 'predict')
      .mockResolvedValue({ clip: '[0.2]' });
  });

  it('keeps embedding and searching by model name when its build is not a catalogue runtime revision', async () => {
    const bound = vi.spyOn(ml, 'encodeBoundClip').mockRejectedValue(refused());
    // the vector is this server's own: no producer key, which the admitted index accepts
    expect(await encode()).toBe('[0.2]');
    expect(index.admitServerVectors).toHaveBeenCalledWith(binding);
    expect(plain).toHaveBeenCalledWith(
      selection,
      { imagePath: '/synthetic/image' },
      { clip: { visual: { modelName: image.modelName } } },
      undefined,
      undefined,
    );
    // the index is still the one the request started under
    expect(index.assertCurrent).toHaveBeenLastCalledWith(binding);
    // the refusal is remembered: the next photo does not ask twice
    await encode();
    expect(bound).toHaveBeenCalledTimes(1);
    expect(plain).toHaveBeenCalledTimes(2);
    // search text is its own identity, asked once, then by name too
    expect(await ml.encodeText(selection, 'a dog', { modelName: image.modelName })).toBe('[0.2]');
    expect(await ml.encodeText(selection, 'a cat', { modelName: image.modelName })).toBe('[0.2]');
    expect(bound).toHaveBeenCalledTimes(2);
  });

  it('asks under the catalogue identity again after a while (a new build may serve it)', async () => {
    const bound = vi.spyOn(ml, 'encodeBoundClip').mockRejectedValue(refused());
    await encode();
    vi.useFakeTimers({ now: Date.now() + 11 * 60 * 1000 });
    try {
      bound.mockResolvedValue({ embedding: '[0.1]', modelKey: image.modelKey });
      expect(await encode()).toEqual({ embedding: '[0.1]', modelKey: image.modelKey });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never answers for a desktop that refused, or after any other failure, or under a changed index', async () => {
    const bound = vi.spyOn(ml, 'encodeBoundClip').mockRejectedValue(refused());
    const desktop = { ...selection, desktopClip: vi.fn() };
    await expect(
      ml.encodeImage(desktop, '/synthetic/image', { ...defaults.machineLearning.clip, modelName: image.modelName }),
    ).rejects.toBeInstanceOf(MachineLearningBindingRefusedError);
    bound.mockRejectedValue(new Error('failed with status 500'));
    await expect(encode()).rejects.toThrow('failed with status 500');
    expect(plain).not.toHaveBeenCalled();
    bound.mockRejectedValue(refused());
    index.admitServerVectors.mockRejectedValue(new Error('desktop_clip_index_changed'));
    await expect(encode()).rejects.toThrow('desktop_clip_index_changed');
    expect(plain).not.toHaveBeenCalled();
  });
});
