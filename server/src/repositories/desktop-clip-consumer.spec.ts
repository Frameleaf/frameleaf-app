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
let index: Record<'selectProfile' | 'assertCurrent', ReturnType<typeof vi.fn>>;
let ml: MachineLearningRepository;
beforeEach(() => {
  index = {
    selectProfile: vi.fn(),
    assertCurrent: vi.fn().mockResolvedValue(undefined),
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
  const refused = () =>
    new MachineLearningBindingRefusedError('model_identity_unavailable: the AI does not hold the catalogue model');
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

  it('fails by name when its build is not a catalogue runtime revision, and never asks by model name', async () => {
    const warn = vi.spyOn(LoggingRepository.prototype, 'warn').mockImplementation(() => {});
    const bound = vi.spyOn(ml, 'encodeBoundClip').mockRejectedValue(refused());
    // a photo is not embedded, and nothing is written for it
    await expect(
      ml.encodeImage(selection, '/synthetic/image', { ...defaults.machineLearning.clip, modelName: image.modelName }),
    ).rejects.toThrow('model_identity_unavailable');
    // a search for words fails the same way
    await expect(ml.encodeText(selection, 'a dog', { modelName: image.modelName })).rejects.toBeInstanceOf(
      MachineLearningBindingRefusedError,
    );
    expect(plain).not.toHaveBeenCalled();
    // asked again each time: nothing remembers the refusal, so a fixed AI works at once
    expect(bound).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'Smart search on lan destination selected failed: model_identity_unavailable: the AI does not hold the catalogue model',
    );
    bound.mockResolvedValue({ embedding: '[0.1]', modelKey: text.modelKey });
    expect(await ml.encodeText(selection, 'a dog', { modelName: image.modelName })).toBe('[0.1]');
    warn.mockRestore();
  });
});
