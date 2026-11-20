import { readFileSync } from 'node:fs';
import { defaults } from 'src/config.js';
import { MlWorkload } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { desktopImageModelKey } from 'src/utils/desktop-model-catalogue.js';
import { equivalentDesktopModelKeys } from 'src/utils/desktop-model-equivalents.js';

const space = JSON.parse(readFileSync(new URL('../../resources/desktop/model-spaces.json', import.meta.url), 'utf8'))
  .spaces[0];
const index = { selectProfile: vi.fn(), modelName: vi.fn() };
const settings = () => structuredClone(defaults.machineLearning);
const repository = (config = settings()) => {
  const sut = new MachineLearningRepository(
    LoggingRepository.create(),
    undefined,
    undefined,
    undefined,
    index as never,
  );
  sut.setup(config);
  return sut;
};
beforeEach(() => {
  vi.resetAllMocks();
  index.selectProfile.mockResolvedValue({ profile: { modelKey: space.visualModelKey } });
});

describe('the model keys a desktop needs for queued work, from the saved settings', () => {
  it('names the configured face and OCR models, and every revision of the admitted search encoder', async () => {
    const sut = repository();
    expect(await sut.desktopModelKeys(MlWorkload.Face)).toEqual([desktopImageModelKey('face', 'buffalo_l')]);
    expect(await sut.desktopModelKeys(MlWorkload.Ocr)).toEqual([desktopImageModelKey('ocr', 'PP-OCRv5_mobile')]);
    const clip = await sut.desktopModelKeys(MlWorkload.Clip);
    expect(clip).toEqual([...equivalentDesktopModelKeys(space.visualModelKey)]);
    expect(clip.length).toBeGreaterThan(1);
    expect(index.selectProfile).toHaveBeenCalledWith(defaults.machineLearning.clip.modelName, 'image');
    expect(await sut.desktopModelKeys(MlWorkload.Enrichment)).toEqual([]);
  });

  it('names none for a task that is off, a model without a profile, or smart search no desktop was granted', async () => {
    const off = settings();
    off.facialRecognition.enabled = false;
    off.ocr.minDetectionScore = 0.123; // no catalogue profile for these settings
    const sut = repository(off);
    expect(await sut.desktopModelKeys(MlWorkload.Face)).toEqual([]);
    expect(await sut.desktopModelKeys(MlWorkload.Ocr)).toEqual([]);
    index.selectProfile.mockResolvedValue(undefined);
    expect(await sut.desktopModelKeys(MlWorkload.Clip)).toEqual([]);
    index.selectProfile.mockRejectedValue(new Error('desktop_clip_profile_unavailable'));
    expect(await sut.desktopModelKeys(MlWorkload.Clip)).toEqual([]);
    expect(await repository({ ...settings(), enabled: false }).desktopModelKeys(MlWorkload.Face)).toEqual([]);
  });
});

describe('changing the search model after a desktop was granted', () => {
  it('lets a model the admitted index does not hold be saved, and still stops on an unreadable index', async () => {
    const sut = repository();
    index.selectProfile.mockRejectedValue(new Error('desktop_clip_profile_unavailable'));
    await expect(sut.assertClipModel('ViT-B-32__openai')).resolves.toBeUndefined();
    index.selectProfile.mockRejectedValue(new Error('desktop_clip_index_invalid'));
    await expect(sut.assertClipModel('ViT-B-32__openai')).rejects.toThrow('desktop_clip_index_invalid');
  });

  it('knows when the admitted index holds another model than the saved one', async () => {
    const sut = repository();
    index.modelName.mockResolvedValue(undefined);
    expect(await sut.clipIndexStale('ViT-B-32__openai')).toBe(false);
    index.modelName.mockResolvedValue('ViT-B-32__openai');
    expect(await sut.clipIndexStale('ViT-B-32__openai')).toBe(false);
    expect(await sut.clipIndexStale('ViT-B-16-SigLIP-384__webli')).toBe(true);
  });
});
