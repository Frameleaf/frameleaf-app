import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from 'src/config.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';

const raw = JSON.parse(readFileSync('test/fixtures/desktop-face-profile.json', 'utf8'));
const profile = parseDesktopModelCatalogue({ schemaVersion: 1, epoch: 5, profiles: [raw] }).profiles[0];
afterEach(() => vi.unstubAllGlobals());
it.each(['valid', 'key', 'preprocessing', 'vector'])(
  'binds NAS face transport and refuses %s producer mismatch',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'frameleaf-face-bound-'));
    try {
      const path = join(root, 'fixture.png');
      await writeFile(path, Buffer.from(profile.fixtureBase64, 'base64'));
      const result = structuredClone(profile.spec.expectedOutput) as typeof raw.spec.expectedOutput;
      if (mode === 'vector') result['facial-recognition'][0].embedding = '[1,2]';
      const fetch = vi.fn().mockResolvedValue(
        Response.json(
          {
            protocolVersion: 1,
            modelKey: mode === 'key' ? 'face:' + 'f'.repeat(64) : profile.modelKey,
            preprocessingSha256: mode === 'preprocessing' ? 'f'.repeat(64) : profile.spec.preprocessingSha256,
            result,
          },
          { headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetch);
      const authority = vi.fn().mockResolvedValue(undefined);
      const record = vi.fn();
      const selection = {
        destinationId: 'face-nas',
        kind: MlDestinationKind.Lan,
        workload: MlWorkload.Face,
        endpoint: { url: 'https://nas.invalid/', authToken: 'synthetic', assertAuthority: authority },
        record,
      };
      const ml = new MachineLearningRepository(LoggingRepository.create());
      ml.setup(defaults.machineLearning);
      if (mode === 'valid') expect(await ml.detectBoundFaces(selection, path, profile)).toEqual(result);
      else await expect(ml.detectBoundFaces(selection, path, profile)).rejects.toThrow('producer_result_invalid');
      expect(String(fetch.mock.calls[0][0])).toBe('https://nas.invalid/predict-face-bound');
      expect(new Headers(fetch.mock.calls[0][1].headers).get('authorization')).toBe('Bearer synthetic');
      expect(authority).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: mode === 'valid' ? 'success' : 'failure' }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
