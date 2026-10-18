import { readFileSync } from 'node:fs';
import { defaults } from 'src/config.js';
import { DesktopModelInventoryDto, DesktopModelInventoryRequestSchema } from 'src/dtos/desktop-model-inventory.dto.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { selectDesktopModelInventory } from 'src/utils/desktop-model-inventory.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';

const catalogue = parseDesktopModelCatalogue(
  JSON.parse(readFileSync('resources/desktop/model-catalogue.json', 'utf8')),
);
const spaces = parseDesktopClipSpaces(
  JSON.parse(readFileSync('resources/desktop/model-spaces.json', 'utf8')),
  catalogue,
);
const request = { provider: 'CPUExecutionProvider', runtimeSourceRevision: 'f93c34d196955da3e2760c095c08b27ccbf53315' };
const setup = () => ({
  ...request,
  catalogue,
  spaces,
  config: structuredClone(defaults.machineLearning),
  routes: [MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Face, MlWorkload.Enrichment].map((workload) => ({
    workload,
    destinationId: 'nas',
    origin: 'default' as 'default' | 'pinned' | 'legacy',
    revisionId: 'route',
  })),
  destinations: [{ ...structuredClone(mlDestinationStub.local), id: 'nas', authToken: 'private-destination-token' }],
});
it('advertises complete compiled groups and reports unqualified enrichment without exposing destinations', () => {
  const input = setup();
  const original = structuredClone(input);
  const result = selectDesktopModelInventory(input);
  expect(result.map(({ workload, state, modelKeys }) => [workload, state, modelKeys.length])).toEqual([
    [MlWorkload.Clip, 'eligible', 3],
    [MlWorkload.Ocr, 'eligible', 1],
    [MlWorkload.Face, 'eligible', 1],
    [MlWorkload.Enrichment, 'unsupported', 0],
  ]);
  expect(JSON.stringify(result)).not.toMatch(
    /private-destination-token|localhost|frameleaf-machine-learning|destinationId/,
  );
  expect(input).toEqual(original);
  expect(DesktopModelInventoryDto.schema.parse({ protocolVersion: 1, ...request, workloads: result })).toBeDefined();
});
it.each(['pinned', 'legacy'] as const)('preserves %s routes without blocking other workloads', (origin) => {
  const input = setup();
  input.routes[2].origin = origin;
  const result = selectDesktopModelInventory(input);
  expect(result[2]).toMatchObject({ state: origin, modelKeys: [] });
  expect(result[0].state).toBe('eligible');
  expect(result[1].state).toBe('eligible');
  expect(input.routes[2].origin).toBe(origin);
});
it.each(['model', 'options', 'provider', 'source'])('does not substitute another %s', (change) => {
  const input = setup();
  switch (change) {
    case 'model': {
      input.config.facialRecognition.modelName = 'buffalo_s';
      break;
    }
    case 'options': {
      input.config.facialRecognition.minScore = 0.8;
      break;
    }
    case 'provider': {
      input.provider = 'CUDAExecutionProvider';
      break;
    }
    case 'source': {
      input.runtimeSourceRevision = 'f'.repeat(40);
      // No default
      break;
    }
  }
  const result = selectDesktopModelInventory(input);
  expect(result[2]).toMatchObject({ state: 'unsupported', modelKeys: [] });
  if (change === 'model' || change === 'options') expect(result[1].state).toBe('eligible');
});
it.each(['disabled', 'cloud', 'url', 'allowlist', 'route'])(
  'refuses %s destination authority without probing it',
  (change) => {
    const input = setup();
    switch (change) {
      case 'disabled': {
        input.destinations[0].enabled = false;
        break;
      }
      case 'cloud': {
        input.destinations[0].kind = MlDestinationKind.FrameleafCloud;
        break;
      }
      case 'url': {
        input.destinations[0].url = null;
        break;
      }
      case 'allowlist': {
        input.destinations[0].workloads = [];
        break;
      }
      case 'route': {
        input.routes = [];
        // No default
        break;
      }
    }
    expect(selectDesktopModelInventory(input)[1]).toMatchObject({ state: 'unavailable', modelKeys: [] });
  },
);
it('keeps disabled models disabled and never relies on NAS inference health for inventory', () => {
  const input = setup();
  input.config.facialRecognition.enabled = false;
  input.destinations[0].lastProbeWorkloads = [];
  expect(selectDesktopModelInventory(input)[2]).toMatchObject({ state: 'disabled', modelKeys: [] });
  expect(selectDesktopModelInventory(input)[1].state).toBe('eligible');
  input.config.enabled = false;
  expect(
    selectDesktopModelInventory(input).every((item) => item.state === 'disabled' && item.modelKeys.length === 0),
  ).toBe(true);
});
it('rejects protocol/request additions and keys in a refused inventory entry', () => {
  expect(() => DesktopModelInventoryRequestSchema.parse({ ...request, url: 'https://untrusted.invalid' })).toThrow();
  const workloads = selectDesktopModelInventory(setup());
  workloads[2].state = 'pinned';
  expect(() => DesktopModelInventoryDto.schema.parse({ protocolVersion: 1, ...request, workloads })).toThrow();
});

it.each(['25b22c16e47a27a2eb50017d838497abce850d11', '1ca4d52e2b8158d89d8de8b17e1e6535e17691f4'])(
  'retains legacy CLIP spaces but refuses outdated default image producer %s',
  (source) => {
    const input = setup();
    input.runtimeSourceRevision = source;
    expect(
      selectDesktopModelInventory(input)
        .slice(0, 3)
        .map(({ state }) => state),
    ).toEqual(['eligible', 'unsupported', 'unsupported']);
  },
);

it('offers all qualified current-main CPU groups without changing routes or model configuration', () => {
  const input = setup();
  input.runtimeSourceRevision = 'f93c34d196955da3e2760c095c08b27ccbf53315';
  const original = structuredClone(input);
  const result = selectDesktopModelInventory(input);
  expect(result.slice(0, 3).map(({ state, modelKeys }) => [state, modelKeys.length])).toEqual([
    ['eligible', 3],
    ['eligible', 1],
    ['eligible', 1],
  ]);
  expect(input).toEqual(original);
});
