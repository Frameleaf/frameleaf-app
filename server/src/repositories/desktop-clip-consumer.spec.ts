import { readFileSync } from 'node:fs';
import { defaults } from 'src/config.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository, type MlSelection } from 'src/repositories/machine-learning.repository.js';
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
let index: { selectProfile: ReturnType<typeof vi.fn>; assertCurrent: ReturnType<typeof vi.fn> };
let ml: MachineLearningRepository;
beforeEach(() => {
  index = { selectProfile: vi.fn(), assertCurrent: vi.fn().mockResolvedValue(undefined) };
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
