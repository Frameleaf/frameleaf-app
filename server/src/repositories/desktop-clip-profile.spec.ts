import { readFileSync } from 'node:fs';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';

const models = parseDesktopModelCatalogue(
  JSON.parse(readFileSync(new URL('../../resources/desktop/model-catalogue.json', import.meta.url), 'utf8')),
);
const space = JSON.parse(readFileSync(new URL('../../resources/desktop/model-spaces.json', import.meta.url), 'utf8'))
  .spaces[0];
const binding = { revisionId: 'revision', space };
const modelName = models.profiles[0].modelName;
let repository: DesktopClipIndexRepository;
beforeEach(() => {
  repository = new DesktopClipIndexRepository(undefined as never);
  vi.spyOn(repository, 'getActive').mockResolvedValue(binding);
});
it('selects the admitted visual and exact default or English text profiles', async () => {
  expect((await repository.selectProfile(modelName, 'image'))?.profile.modelKey).toBe(space.visualModelKey);
  for (const language of [undefined, 'en']) {
    const selected = await repository.selectProfile(modelName, 'text', language);
    expect(selected?.binding).toEqual(binding);
    expect(selected?.profile.spec.entries).toEqual({
      clip: { textual: { modelName, options: language ? { language } : {} } },
    });
  }
});
it('refuses model or language substitution for an admitted index', async () => {
  await expect(repository.selectProfile('ViT-B-16__openai', 'image')).rejects.toThrow(
    'desktop_clip_profile_unavailable',
  );
  await expect(repository.selectProfile(modelName, 'text', 'fr')).rejects.toThrow('desktop_clip_profile_unavailable');
});
it('retains legacy behavior only when no index is admitted', async () => {
  vi.mocked(repository.getActive).mockResolvedValue(undefined);
  expect(await repository.selectProfile('legacy-custom-model', 'text', 'fr')).toBeUndefined();
  vi.mocked(repository.getActive).mockRejectedValue(new Error('desktop_clip_index_invalid'));
  await expect(repository.selectProfile(modelName, 'image')).rejects.toThrow('desktop_clip_index_invalid');
});
