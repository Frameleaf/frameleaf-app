/**
 * Frameleaf Cloud model choice per workload (FL-186). The model a cloud job names is the SKU saved on
 * its workload route (`ml_workload_route.modelId`, `PUT ml-destinations/routes/{workload}`); with none
 * saved, the model Frameleaf Cloud's catalogue recommends for the workload (and restoration mode) in
 * this region. The catalogue (`GET admin/cloud/ml/catalog`) is the only list of cloud models; this
 * module never names one itself.
 */
import type { RoutedWorkload } from '$lib/frameleaf/cloud-ml';
import {
  CloudMlConnection,
  getCloudMlCatalog,
  getMlWorkloadRoutes,
  MlWorkload,
  type CloudMlModelDto,
  type CloudMlStatusResponseDto,
  type MlWorkloadRouteDto,
} from '@immich/sdk';

/**
 * The workloads a routed kind of work in Where each job runs covers. Faithful and creative restoration
 * are separate workloads, each with its own model; Studio AI is one workload.
 */
export const cloudWorkloadsFor = (row: RoutedWorkload): MlWorkload[] => {
  switch (row) {
    case 'descriptions': {
      return [MlWorkload.Enrichment];
    }
    case 'upscale': {
      return [MlWorkload.Upscale];
    }
    case 'restoration': {
      return [MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative];
    }
    case 'studio': {
      return [MlWorkload.StudioAi];
    }
    case 'interpolation': {
      return [MlWorkload.Interpolation];
    }
  }
};

/** Studio AI never takes a catalogue default: an administrator always chooses its model. */
export const takesCatalogDefault = (workload: MlWorkload) => workload !== MlWorkload.StudioAi;

/** The catalogue models for exactly one workload, lightest first (the catalogue's own rank). */
export const catalogModelsFor = (models: readonly CloudMlModelDto[], workload: MlWorkload): CloudMlModelDto[] =>
  models.filter((model) => model.workload === workload).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

export type CloudModelChoice =
  /** An administrator chose this model. */
  | { kind: 'chosen'; model: CloudMlModelDto }
  /** No model is chosen, so the catalogue's recommendation is used. */
  | { kind: 'default'; model: CloudMlModelDto }
  /** The chosen model is no longer in the catalogue: jobs are refused until another is chosen. */
  | { kind: 'missing'; id: string }
  /** No model is chosen and the catalogue recommends none: jobs are refused until one is chosen. */
  | { kind: 'none' };

/** What a workload's cloud jobs use now, exactly as admission decides it. */
export const cloudModelChoice = (
  models: readonly CloudMlModelDto[],
  workload: MlWorkload,
  modelId: string | null | undefined,
): CloudModelChoice => {
  if (modelId) {
    const model = models.find((entry) => entry.id === modelId);
    return model ? { kind: 'chosen', model } : { kind: 'missing', id: modelId };
  }
  const recommended = takesCatalogDefault(workload) ? models.find((entry) => entry.isDefault) : undefined;
  return recommended ? { kind: 'default', model: recommended } : { kind: 'none' };
};

/** The route of one workload, when it runs on the given Frameleaf Cloud destination. */
export const cloudRouteFor = (
  routes: readonly MlWorkloadRouteDto[],
  workload: MlWorkload,
  cloudDestinationId: string | null | undefined,
): MlWorkloadRouteDto | null => {
  if (!cloudDestinationId) {
    return null;
  }
  return routes.find((route) => route.workload === workload && route.destinationId === cloudDestinationId) ?? null;
};

export type CloudModelData = {
  /** The catalogue's models, or null when Frameleaf Cloud is not ready or could not be read. */
  catalog: CloudMlModelDto[] | null;
  /** Frameleaf Cloud is ready, but its catalogue could not be read. */
  catalogFailed: boolean;
  routes: MlWorkloadRouteDto[];
};

const readRoutes = async (): Promise<MlWorkloadRouteDto[]> => {
  try {
    return (await getMlWorkloadRoutes()).routes;
  } catch {
    return [];
  }
};

/**
 * The routes and, once Frameleaf Cloud is ready and added as a destination, its catalogue. The
 * catalogue is only read then: before that the gateway is not reachable and there is nothing to route.
 */
export const loadCloudModelData = async (status: CloudMlStatusResponseDto | null): Promise<CloudModelData> => {
  const routes = await readRoutes();
  if (status?.connection !== CloudMlConnection.Ready || !status.destination) {
    return { catalog: null, catalogFailed: false, routes };
  }
  try {
    return { catalog: (await getCloudMlCatalog()).models, catalogFailed: false, routes };
  } catch {
    return { catalog: null, catalogFailed: true, routes };
  }
};
