import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { defaults } from 'src/config.js';
import { MlWorkload } from 'src/enum.js';
import { DesktopNasProducerService } from 'src/services/desktop-nas-producer.service.js';
import * as config from 'src/utils/config.js';
import * as destinations from 'src/utils/ml-destination.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';

const space = JSON.parse(readFileSync(new URL('../../resources/desktop/model-spaces.json', import.meta.url), 'utf8'))
  .spaces[0];
const profiles = JSON.parse(
  readFileSync(new URL('../../resources/desktop/model-catalogue.json', import.meta.url), 'utf8'),
).profiles;
const selected = profiles.find((p: { modelKey: string }) => p.modelKey === space.visualModelKey);
let service: DesktopNasProducerService;
let settings = structuredClone(defaults);
const route = {
  workload: MlWorkload.Clip,
  destinationId: mlDestinationStub.local.id,
  origin: 'default',
  revisionId: 'revision',
};
const repository = { getRouteStates: vi.fn() };
const index = { getActive: vi.fn() };
const ml = { encodeBoundClip: vi.fn() };
const selection = {
  destinationId: route.destinationId,
  kind: mlDestinationStub.local.kind,
  workload: MlWorkload.Clip,
  endpoint: { url: mlDestinationStub.local.url!, assertAuthority: vi.fn() },
  record: vi.fn(),
};
beforeEach(() => {
  vi.restoreAllMocks();
  settings = structuredClone(defaults);
  settings.machineLearning.clip.modelName = selected.modelName;
  repository.getRouteStates.mockReset().mockResolvedValue([route]);
  index.getActive.mockReset().mockResolvedValue(undefined);
  selection.endpoint.assertAuthority.mockReset().mockResolvedValue(undefined);
  vi.spyOn(config, 'getConfig').mockImplementation(() => Promise.resolve(settings));
  vi.spyOn(destinations, 'selectMlDestination').mockResolvedValue(selection);
  ml.encodeBoundClip.mockReset().mockImplementation((_selection, _payload, profile) =>
    Promise.resolve({
      embedding: profile.spec.expectedOutput.clip,
      modelKey: profile.modelKey,
    }),
  );
  service = new DesktopNasProducerService(ml as never, repository as never, index as never, {} as never, {} as never);
});
it('verifies all released roles through the existing destination and removes its private image fixture', async () => {
  let image: string | undefined;
  ml.encodeBoundClip.mockImplementation(async (chosen, payload, profile) => {
    expect(chosen).toBe(selection);
    if ('imagePath' in payload) {
      image = payload.imagePath;
      expect(await readFile(image!)).toEqual(Buffer.from(profile.fixtureBase64, 'base64'));
      if (process.platform !== 'win32') expect((await stat(image!)).mode & 0o777).toBe(0o600);
    } else expect(payload.text).toBe(Buffer.from(profile.fixtureBase64, 'base64').toString('utf8'));
    return { embedding: profile.spec.expectedOutput.clip, modelKey: profile.modelKey };
  });
  const proof = await service.verify(space.spaceKey);
  expect(proof.spaceKey).toBe(space.spaceKey);
  expect([...proof.modelKeys].sort((a, b) => a.localeCompare(b))).toEqual(
    [space.visualModelKey, ...space.textModelKeys].sort((a, b) => a.localeCompare(b)),
  );
  expect(ml.encodeBoundClip).toHaveBeenCalledTimes(3);
  await proof.assertCurrent();
  await expect(stat(image!)).rejects.toThrow();
  repository.getRouteStates.mockResolvedValue([{ ...route, revisionId: 'changed' }]);
  await expect(proof.assertCurrent()).rejects.toThrow('desktop_nas_producer_changed');
});
it.each(['pinned', 'legacy'])('preserves %s routes without probing or rewriting them', async (origin) => {
  repository.getRouteStates.mockResolvedValue([{ ...route, origin }]);
  await expect(service.verify(space.spaceKey)).rejects.toThrow('desktop_route_review_required');
  expect(ml.encodeBoundClip).not.toHaveBeenCalled();
});
it.each(['disabled', 'model', 'unknown-space'])('refuses %s before sending a fixture', async (reason) => {
  if (reason === 'disabled') settings.machineLearning.enabled = false;
  else if (reason === 'model') settings.machineLearning.clip.modelName = 'ViT-B-16__openai';
  await expect(service.verify(reason === 'unknown-space' ? 'unknown' : space.spaceKey)).rejects.toThrow();
  expect(ml.encodeBoundClip).not.toHaveBeenCalled();
});
it.each(['config', 'urls', 'route', 'index', 'endpoint', 'vector', 'golden', 'key', 'failure'])(
  'refuses %s changes without another model or destination',
  async (reason) => {
    let fixture: string | undefined;
    ml.encodeBoundClip.mockImplementation((_selection, payload, profile) => {
      fixture = payload.imagePath;
      switch (reason) {
        case 'config': {
          settings.machineLearning.clip.modelName = 'ViT-B-16__openai';
          break;
        }
        case 'urls': {
          settings.machineLearning.urls = ['https://changed.invalid'];
          break;
        }
        case 'route': {
          repository.getRouteStates.mockResolvedValue([{ ...route, revisionId: 'changed' }]);
          break;
        }
        case 'index': {
          index.getActive.mockResolvedValue({ revisionId: 'new', space });
          break;
        }
        case 'endpoint': {
          selection.endpoint.assertAuthority.mockRejectedValue(new Error('revoked'));
          break;
        }
        case 'failure': {
          throw new Error('failed');
        }
        // No default
      }
      return {
        embedding:
          reason === 'vector'
            ? '[0,1]'
            : reason === 'golden'
              ? JSON.stringify(Array.from({ length: profile.embeddingDimensions }, () => 0))
              : profile.spec.expectedOutput.clip,
        modelKey: reason === 'key' ? 'wrong' : profile.modelKey,
      };
    });
    await expect(service.verify(space.spaceKey)).rejects.toThrow();
    expect(ml.encodeBoundClip).toHaveBeenCalledTimes(1);
    await expect(stat(fixture!)).rejects.toThrow();
  },
);

it('expires proof freshness and refuses clock rollback', async () => {
  const proof = await service.verify(space.spaceKey);
  vi.spyOn(Date, 'now').mockReturnValue(proof.verifiedAt + 60_001);
  await expect(proof.assertCurrent()).rejects.toThrow('desktop_nas_producer_expired');
  vi.mocked(Date.now).mockReturnValue(proof.verifiedAt - 1);
  await expect(proof.assertCurrent()).rejects.toThrow('desktop_nas_producer_expired');
  vi.restoreAllMocks();
});
