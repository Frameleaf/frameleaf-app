import {
  CloudMlConnection,
  CloudMlModelGroup,
  MlWorkload,
  type CloudMlModelDto,
  type CloudMlStatusResponseDto,
} from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import {
  catalogModelsFor,
  choicesByGroup,
  cloudModelChoice,
  cloudModelGroupsFor,
  loadCloudModelData,
  takesCatalogDefault,
} from './cloud-models';

const model = (id: string, group: CloudMlModelGroup | null, rank: number, isDefault = false): CloudMlModelDto => ({
  id,
  workload: MlWorkload.Enrichment,
  group,
  name: id,
  rank,
  isDefault,
  description: `${id} model`,
  fingerprint: 'mr_68JDMAM8444M',
  pricingUnit: 'second',
  priceUsd: 0.001,
});

const catalog = [
  model('ms_HEAVY001', CloudMlModelGroup.Descriptions, 5),
  model('ms_LIGHT001', CloudMlModelGroup.Descriptions, 1, true),
  model('ms_FAITH001', CloudMlModelGroup.RestorationFaithful, 1, true),
  model('ms_CREAT001', CloudMlModelGroup.RestorationCreative, 2),
  model('ms_WORDS001', CloudMlModelGroup.Transcription, 1, true),
  model('ms_VOICE001', CloudMlModelGroup.Tts, 1),
  model('ms_UNKNOWN1', null, 1),
];

describe('Frameleaf Cloud model choice (FL-186)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives restoration a group per mode, Studio AI one per feature, and other work one group', () => {
    expect(cloudModelGroupsFor('restoration').map(({ group }) => group)).toEqual([
      CloudMlModelGroup.RestorationFaithful,
      CloudMlModelGroup.RestorationCreative,
    ]);
    expect(cloudModelGroupsFor('studio')).toEqual([
      { group: CloudMlModelGroup.Transcription, workload: MlWorkload.StudioAi },
      { group: CloudMlModelGroup.Tts, workload: MlWorkload.StudioAi },
    ]);
    expect(cloudModelGroupsFor('descriptions')).toEqual([
      { group: CloudMlModelGroup.Descriptions, workload: MlWorkload.Enrichment },
    ]);
    expect(cloudModelGroupsFor('upscale').map(({ group }) => group)).toEqual([CloudMlModelGroup.Upscale]);
    expect(cloudModelGroupsFor('interpolation').map(({ group }) => group)).toEqual([CloudMlModelGroup.Interpolation]);
  });

  it('lists only the models of exactly one group, lightest first', () => {
    expect(catalogModelsFor(catalog, CloudMlModelGroup.Descriptions).map((entry) => entry.id)).toEqual([
      'ms_LIGHT001',
      'ms_HEAVY001',
    ]);
    expect(catalogModelsFor(catalog, CloudMlModelGroup.Tts).map((entry) => entry.id)).toEqual(['ms_VOICE001']);
    expect(catalogModelsFor(catalog, CloudMlModelGroup.Upscale)).toEqual([]);
  });

  it('uses the chosen model, else the recommended one, and never a default for Studio AI', () => {
    const descriptions = catalogModelsFor(catalog, CloudMlModelGroup.Descriptions);
    expect(cloudModelChoice(descriptions, CloudMlModelGroup.Descriptions, 'ms_HEAVY001')).toEqual({
      kind: 'chosen',
      model: catalog[0],
    });
    expect(cloudModelChoice(descriptions, CloudMlModelGroup.Descriptions, null)).toEqual({
      kind: 'default',
      model: catalog[1],
    });
    expect(cloudModelChoice(descriptions, CloudMlModelGroup.Descriptions, 'ms_GONE0001')).toEqual({
      kind: 'missing',
      id: 'ms_GONE0001',
    });
    const creative = catalogModelsFor(catalog, CloudMlModelGroup.RestorationCreative);
    expect(cloudModelChoice(creative, CloudMlModelGroup.RestorationCreative, null)).toEqual({ kind: 'none' });
    const words = catalogModelsFor(catalog, CloudMlModelGroup.Transcription);
    expect(takesCatalogDefault(CloudMlModelGroup.Transcription)).toBe(false);
    expect(takesCatalogDefault(CloudMlModelGroup.Tts)).toBe(false);
    expect(cloudModelChoice(words, CloudMlModelGroup.Transcription, null)).toEqual({ kind: 'none' });
  });

  it('reads the choices, and the catalogue only once Frameleaf Cloud answers', async () => {
    const choices = [
      { group: CloudMlModelGroup.Descriptions, modelId: 'ms_HEAVY001' },
      { group: CloudMlModelGroup.Tts, modelId: null },
    ];
    sdkMock.getCloudMlModelChoices.mockResolvedValue({ choices });
    sdkMock.getCloudMlCatalog.mockResolvedValue({ models: catalog });
    const byGroup = choicesByGroup(choices);
    expect(byGroup).toEqual({ descriptions: 'ms_HEAVY001', tts: null });

    await expect(
      loadCloudModelData({ connection: CloudMlConnection.NotLinked } as CloudMlStatusResponseDto),
    ).resolves.toEqual({ catalog: null, catalogFailed: false, choices: byGroup });
    expect(sdkMock.getCloudMlCatalog).not.toHaveBeenCalled();
    await expect(
      loadCloudModelData({ connection: CloudMlConnection.Unavailable } as CloudMlStatusResponseDto),
    ).resolves.toEqual({ catalog: null, catalogFailed: true, choices: byGroup });

    const ready = { connection: CloudMlConnection.Ready } as CloudMlStatusResponseDto;
    await expect(loadCloudModelData(ready)).resolves.toEqual({ catalog, catalogFailed: false, choices: byGroup });

    sdkMock.getCloudMlCatalog.mockRejectedValue(new Error('unavailable'));
    await expect(loadCloudModelData(ready)).resolves.toEqual({ catalog: null, catalogFailed: true, choices: byGroup });

    sdkMock.getCloudMlModelChoices.mockRejectedValue(new Error('forbidden'));
    await expect(loadCloudModelData(null)).resolves.toEqual({ catalog: null, catalogFailed: false, choices: {} });
  });
});
