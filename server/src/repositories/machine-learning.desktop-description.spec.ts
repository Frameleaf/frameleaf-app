import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineLearningHardwareAcceleration, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository, type MlSelection } from 'src/repositories/machine-learning.repository.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';

const fixture = parseDesktopModelCatalogue({
  schemaVersion: 1,
  epoch: 19,
  profiles: [JSON.parse(readFileSync('test/fixtures/desktop-description-profile.json', 'utf8'))],
}).profiles[0];
vi.mock('src/utils/desktop-description.js', async (original) => ({
  ...(await original<typeof import('src/utils/desktop-description.js')>()),
  desktopDescriptionProfile: () => fixture,
}));

const options = {
  modelName: 'Qwen/Qwen2.5-VL-7B-Instruct',
  fallbackModelName: 'microsoft/Florence-2-base-ft',
  acceleration: MachineLearningHardwareAcceleration.Cpu,
  device: 'AUTO',
};
const output = {
  'image-description-tagging': {
    description: 'A red square.',
    people: [],
    environment: '',
    objects: [],
    visible_text: [],
    context: '',
    tags: [],
  },
};

describe('FD-31 desktop descriptions', () => {
  let directory: string;
  let image: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-description-'));
    image = join(directory, 'preview.jpg');
    await writeFile(image, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  const selection = (desktopDescription: MlSelection['desktopDescription']): MlSelection => ({
    destinationId: 'nas',
    kind: MlDestinationKind.Local,
    workload: MlWorkload.Enrichment,
    endpoint: { url: 'https://unused.invalid' },
    record: vi.fn(),
    desktopDescription,
  });

  it('asks the desktop for its catalogue build of the configured model and stores the sentence', async () => {
    const desktop = vi.fn().mockResolvedValue(output);
    const chosen = selection(desktop);
    const sut = new MachineLearningRepository(LoggingRepository.create());
    const run = await sut.describeImageRun(chosen, image, options, undefined, 'the server prompt');
    expect(desktop).toHaveBeenCalledWith({ imagePath: image }, fixture.spec.entries);
    expect(run).toEqual({ result: output['image-description-tagging'], model: options.modelName, device: null });
    expect(chosen.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', bytesSent: 4 }));
  });

  it('refuses anything but one bounded sentence, and never falls back to this server', async () => {
    for (const value of [
      { ...output, extra: true },
      { 'image-description-tagging': { ...output['image-description-tagging'], tags: ['red'] } },
      { 'image-description-tagging': { ...output['image-description-tagging'], description: 'x'.repeat(241) } },
    ]) {
      const chosen = selection(vi.fn().mockResolvedValue(value));
      await expect(
        new MachineLearningRepository(LoggingRepository.create()).describeImageRun(chosen, image, options),
      ).rejects.toThrow();
      expect(chosen.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
    }
    // a selection a desktop took is never sent to the destination's own AI
    await expect(
      new MachineLearningRepository(LoggingRepository.create()).predict(selection(vi.fn()), { imagePath: image }, {}),
    ).rejects.toThrow('desktop_bound_profile_required');
  });
});
