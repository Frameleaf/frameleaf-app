/**
 * Frameleaf Cloud model choice per model group (FL-186). The model a cloud job names is the SKU an
 * administrator chose for its group (`GET`/`PUT admin/cloud/ml/models`), whatever its workload's route
 * points at; with none chosen, the model Frameleaf Cloud's catalogue recommends for the group in this
 * region. Groups are the catalogue's own: one per cloud workload, restoration once per mode, and Studio
 * AI twice (speech to text and captions, and speech). The catalogue (`GET admin/cloud/ml/catalog`) is
 * the only list of cloud models; this module never names one itself.
 */
import type { RoutedWorkload } from '$lib/frameleaf/cloud-ml';
import {
  CloudMlConnection,
  CloudMlModelGroup,
  getCloudMlCatalog,
  getCloudMlModelChoices,
  MlWorkload,
  type CloudMlModelChoiceDto,
  type CloudMlModelDto,
  type CloudMlStatusResponseDto,
} from '@immich/sdk';

export type CloudModelGroupRow = {
  group: CloudMlModelGroup;
  /** The app workload whose cloud jobs use this group. */
  workload: MlWorkload;
};

/**
 * The model groups a routed kind of work in Where each job runs covers: faithful and creative
 * restoration each have their own, and Studio AI has one for speech to text and captions and one for
 * speech.
 */
export const cloudModelGroupsFor = (row: RoutedWorkload): CloudModelGroupRow[] => {
  switch (row) {
    case 'descriptions': {
      return [{ group: CloudMlModelGroup.Descriptions, workload: MlWorkload.Enrichment }];
    }
    case 'upscale': {
      return [{ group: CloudMlModelGroup.Upscale, workload: MlWorkload.Upscale }];
    }
    case 'restoration': {
      return [
        { group: CloudMlModelGroup.RestorationFaithful, workload: MlWorkload.RestorationFaithful },
        { group: CloudMlModelGroup.RestorationCreative, workload: MlWorkload.RestorationCreative },
      ];
    }
    case 'studio': {
      return [
        { group: CloudMlModelGroup.Transcription, workload: MlWorkload.StudioAi },
        { group: CloudMlModelGroup.Tts, workload: MlWorkload.StudioAi },
      ];
    }
    case 'interpolation': {
      return [{ group: CloudMlModelGroup.Interpolation, workload: MlWorkload.Interpolation }];
    }
  }
};

/** Studio AI never takes a catalogue default: an administrator always chooses its models. */
export const takesCatalogDefault = (group: CloudMlModelGroup) =>
  group !== CloudMlModelGroup.Transcription && group !== CloudMlModelGroup.Tts;

/** The catalogue models of exactly one group, lightest first (the catalogue's own rank). */
export const catalogModelsFor = (models: readonly CloudMlModelDto[], group: CloudMlModelGroup): CloudMlModelDto[] =>
  models.filter((model) => model.group === group).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

export type CloudModelChoice =
  /** An administrator chose this model. */
  | { kind: 'chosen'; model: CloudMlModelDto }
  /** No model is chosen, so the catalogue's recommendation is used. */
  | { kind: 'default'; model: CloudMlModelDto }
  /** The chosen model is no longer in the catalogue: jobs are refused until another is chosen. */
  | { kind: 'missing'; id: string }
  /** No model is chosen and the catalogue recommends none: jobs are refused until one is chosen. */
  | { kind: 'none' };

/** What a group's cloud jobs use now, exactly as admission decides it. */
export const cloudModelChoice = (
  models: readonly CloudMlModelDto[],
  group: CloudMlModelGroup,
  modelId: string | null | undefined,
): CloudModelChoice => {
  if (modelId) {
    const model = models.find((entry) => entry.id === modelId);
    return model ? { kind: 'chosen', model } : { kind: 'missing', id: modelId };
  }
  const recommended = takesCatalogDefault(group) ? models.find((entry) => entry.isDefault) : undefined;
  return recommended ? { kind: 'default', model: recommended } : { kind: 'none' };
};

/** The chosen model SKU of each group; a group without one uses the catalogue default. */
export type CloudModelChoices = Partial<Record<CloudMlModelGroup, string | null>>;

export const choicesByGroup = (choices: readonly CloudMlModelChoiceDto[]): CloudModelChoices =>
  Object.fromEntries(choices.map((choice) => [choice.group, choice.modelId]));

export type CloudModelData = {
  /** The catalogue's models, or null when Frameleaf Cloud is not ready or could not be read. */
  catalog: CloudMlModelDto[] | null;
  /** Frameleaf Cloud is linked, but its catalogue could not be read. */
  catalogFailed: boolean;
  choices: CloudModelChoices;
};

const readChoices = async (): Promise<CloudModelChoices> => {
  try {
    return choicesByGroup((await getCloudMlModelChoices()).choices);
  } catch {
    return {};
  }
};

/**
 * The chosen models and, once Frameleaf Cloud answers, its catalogue. Before the server is linked the
 * gateway is not reachable and there is nothing to choose from.
 */
export const loadCloudModelData = async (status: CloudMlStatusResponseDto | null): Promise<CloudModelData> => {
  const choices = await readChoices();
  if (status?.connection !== CloudMlConnection.Ready) {
    return { catalog: null, catalogFailed: status?.connection === CloudMlConnection.Unavailable, choices };
  }
  try {
    return { catalog: (await getCloudMlCatalog()).models, catalogFailed: false, choices };
  } catch {
    return { catalog: null, catalogFailed: true, choices };
  }
};
