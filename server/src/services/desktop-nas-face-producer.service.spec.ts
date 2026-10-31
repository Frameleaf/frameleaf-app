import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { defaults } from 'src/config.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { DesktopNasProducerService } from 'src/services/desktop-nas-producer.service.js';
import * as config from 'src/utils/config.js';
import * as destinations from 'src/utils/ml-destination.js';

const profile = JSON.parse(readFileSync('test/fixtures/desktop-face-profile.json', 'utf8'));
let settings = structuredClone(defaults);
const route = { workload: MlWorkload.Face, destinationId: 'nas', origin: 'default', revisionId: 'route' };
const routes = { getRouteStates: vi.fn() };
const ml = { detectBoundFaces: vi.fn() };
const index = { getActive: vi.fn() };
const selection = {
  destinationId: 'nas',
  kind: MlDestinationKind.Local,
  workload: MlWorkload.Face,
  endpoint: { url: 'https://unused.invalid', assertAuthority: vi.fn() },
  record: vi.fn(),
};
let service: DesktopNasProducerService;
beforeEach(() => {
  vi.restoreAllMocks();
  settings = structuredClone(defaults);
  routes.getRouteStates.mockReset().mockResolvedValue([route]);
  selection.endpoint.assertAuthority.mockReset().mockResolvedValue(undefined);
  ml.detectBoundFaces.mockReset().mockResolvedValue(profile.spec.expectedOutput);
  vi.spyOn(config, 'getConfig').mockImplementation(() => Promise.resolve(settings));
  vi.spyOn(destinations, 'selectMlDestination').mockResolvedValue(selection);
  service = new DesktopNasProducerService(ml as never, routes as never, index as never, {} as never, {} as never);
});
it('proves exact NAS face output without admitting or rewriting a CLIP index', async () => {
  let path = '';
  ml.detectBoundFaces.mockImplementation((_selection, image) => {
    path = image;
    return Promise.resolve(profile.spec.expectedOutput);
  });
  const proof = await service.verifyFace(profile.modelKey);
  expect(proof.modelKeys).toEqual([profile.modelKey]);
  expect(index.getActive).not.toHaveBeenCalled();
  await expect(stat(path)).rejects.toThrow();
  await proof.assertCurrent();
  settings.machineLearning.facialRecognition.maxDistance += 0.1;
  await expect(proof.assertCurrent()).rejects.toThrow('desktop_nas_producer_changed');
});
it.each(['disabled', 'model', 'options', 'pinned', 'legacy', 'unknown', 'vector'])(
  'refuses %s without another model or route',
  async (reason) => {
    switch (reason) {
      case 'disabled': {
        settings.machineLearning.facialRecognition.enabled = false;
        break;
      }
      case 'model': {
        settings.machineLearning.facialRecognition.modelName = 'buffalo_s';
        break;
      }
      case 'options': {
        settings.machineLearning.facialRecognition.minScore = 0.8;
        break;
      }
      case 'pinned':
      case 'legacy': {
        routes.getRouteStates.mockResolvedValue([{ ...route, origin: reason }]);
        break;
      }
      case 'vector': {
        const result = structuredClone(profile.spec.expectedOutput);
        result['facial-recognition'][0].embedding = JSON.stringify(Array.from({ length: 512 }, () => 10));
        ml.detectBoundFaces.mockResolvedValue(result);

        break;
      }
      // No default
    }
    await expect(
      service.verifyFace(reason === 'unknown' ? 'face:' + 'f'.repeat(64) : profile.modelKey),
    ).rejects.toThrow();
    if (reason !== 'vector') expect(ml.detectBoundFaces).not.toHaveBeenCalled();
  },
);
