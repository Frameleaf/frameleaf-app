import { CloudMlConnection, MlWorkload, type CloudMlModelDto, type CloudMlStatusResponseDto } from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import {
  catalogModelsFor,
  cloudModelChoice,
  cloudRouteFor,
  cloudWorkloadsFor,
  loadCloudModelData,
  takesCatalogDefault,
} from './cloud-models';

const model = (id: string, workload: MlWorkload | null, rank: number, isDefault = false): CloudMlModelDto => ({
  id,
  workload,
  name: id,
  rank,
  isDefault,
  description: `${id} model`,
  fingerprint: 'mr_68JDMAM8444M',
  pricingUnit: 'second',
  priceUsd: 0.001,
});

const catalog = [
  model('ms_HEAVY001', MlWorkload.Enrichment, 5),
  model('ms_LIGHT001', MlWorkload.Enrichment, 1, true),
  model('ms_FAITH001', MlWorkload.RestorationFaithful, 1, true),
  model('ms_CREAT001', MlWorkload.RestorationCreative, 2),
  model('ms_STUDIO01', MlWorkload.StudioAi, 1, true),
  model('ms_UNKNOWN1', null, 1),
];

describe('Frameleaf Cloud model choice (FL-186)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives restoration a workload per mode and every other kind of work one workload', () => {
    expect(cloudWorkloadsFor('restoration')).toEqual([MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative]);
    expect(cloudWorkloadsFor('descriptions')).toEqual([MlWorkload.Enrichment]);
    expect(cloudWorkloadsFor('studio')).toEqual([MlWorkload.StudioAi]);
    expect(cloudWorkloadsFor('upscale')).toEqual([MlWorkload.Upscale]);
    expect(cloudWorkloadsFor('interpolation')).toEqual([MlWorkload.Interpolation]);
  });

  it('lists only the models of exactly one workload, lightest first', () => {
    expect(catalogModelsFor(catalog, MlWorkload.Enrichment).map((entry) => entry.id)).toEqual([
      'ms_LIGHT001',
      'ms_HEAVY001',
    ]);
    expect(catalogModelsFor(catalog, MlWorkload.RestorationCreative).map((entry) => entry.id)).toEqual(['ms_CREAT001']);
    expect(catalogModelsFor(catalog, MlWorkload.Upscale)).toEqual([]);
  });

  it('uses the chosen model, else the recommended one, and never a default for Studio AI', () => {
    const enrichment = catalogModelsFor(catalog, MlWorkload.Enrichment);
    expect(cloudModelChoice(enrichment, MlWorkload.Enrichment, 'ms_HEAVY001')).toEqual({
      kind: 'chosen',
      model: catalog[0],
    });
    expect(cloudModelChoice(enrichment, MlWorkload.Enrichment, null)).toEqual({ kind: 'default', model: catalog[1] });
    expect(cloudModelChoice(enrichment, MlWorkload.Enrichment, 'ms_GONE0001')).toEqual({
      kind: 'missing',
      id: 'ms_GONE0001',
    });
    const creative = catalogModelsFor(catalog, MlWorkload.RestorationCreative);
    expect(cloudModelChoice(creative, MlWorkload.RestorationCreative, null)).toEqual({ kind: 'none' });
    const studio = catalogModelsFor(catalog, MlWorkload.StudioAi);
    expect(takesCatalogDefault(MlWorkload.StudioAi)).toBe(false);
    expect(cloudModelChoice(studio, MlWorkload.StudioAi, null)).toEqual({ kind: 'none' });
  });

  it('finds a route only when it points at the Frameleaf Cloud destination', () => {
    const routes = [
      { workload: MlWorkload.Enrichment, destinationId: 'cloud-1', modelId: 'ms_HEAVY001' },
      { workload: MlWorkload.Upscale, destinationId: 'lan-1', modelId: null },
    ];
    expect(cloudRouteFor(routes, MlWorkload.Enrichment, 'cloud-1')).toEqual(routes[0]);
    expect(cloudRouteFor(routes, MlWorkload.Upscale, 'cloud-1')).toBeNull();
    expect(cloudRouteFor(routes, MlWorkload.Enrichment, null)).toBeNull();
  });

  it('reads the catalogue only once Frameleaf Cloud is ready and added, and reports a failed read', async () => {
    const routes = [{ workload: MlWorkload.Enrichment, destinationId: 'cloud-1', modelId: null }];
    sdkMock.getMlWorkloadRoutes.mockResolvedValue({ routes });
    sdkMock.getCloudMlCatalog.mockResolvedValue({ models: catalog });
    const ready = { connection: CloudMlConnection.Ready, destination: { id: 'cloud-1' } } as CloudMlStatusResponseDto;

    await expect(
      loadCloudModelData({ connection: CloudMlConnection.NotLinked, destination: null } as CloudMlStatusResponseDto),
    ).resolves.toEqual({ catalog: null, catalogFailed: false, routes });
    expect(sdkMock.getCloudMlCatalog).not.toHaveBeenCalled();

    await expect(loadCloudModelData(ready)).resolves.toEqual({ catalog, catalogFailed: false, routes });

    sdkMock.getCloudMlCatalog.mockRejectedValue(new Error('unavailable'));
    await expect(loadCloudModelData(ready)).resolves.toEqual({ catalog: null, catalogFailed: true, routes });

    sdkMock.getMlWorkloadRoutes.mockRejectedValue(new Error('forbidden'));
    await expect(loadCloudModelData(null)).resolves.toEqual({ catalog: null, catalogFailed: false, routes: [] });
  });
});
