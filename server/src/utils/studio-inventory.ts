/**
 * What a native Studio client may use, and what a project uses (FL-348).
 *
 * The authorised inventory lists every resource the pinned engine can reach that has a reviewed
 * rights decision (`studio-rights.generated.ts`): fonts, LUTs, audio, models, voices, weights,
 * tools and runtimes, each with its licence, the three uses the owner decided, and the Studio
 * worker capability that runs it. It is a read of the same table `checkStudioRights` enforces, so a
 * client never offers a resource the server would refuse.
 *
 * The project inventory names the fonts, LUTs and models a project graph references, with the same
 * verdict for running them on this server. Pure: no I/O.
 */
import type { StudioCommandCapability } from 'src/utils/studio-commands.js';
import { StudioResourceKind, extractStudioResourceReferences } from 'src/utils/studio-resources.js';
import {
  STUDIO_DISTRIBUTION_APPROVAL,
  STUDIO_RIGHTS_APPROVAL,
  type StudioResourceRights,
  studioResourceRights,
} from 'src/utils/studio-rights.generated.js';
import { StudioRightsUse, checkStudioRights, studioProducerModels } from 'src/utils/studio-rights.js';

export const STUDIO_INVENTORY_KINDS = [
  'font',
  'lut',
  'audio',
  'model',
  'voice',
  'weights',
  'tool',
  'runtime',
  'asset',
] as const;
export type StudioInventoryKind = (typeof STUDIO_INVENTORY_KINDS)[number];

export type StudioInventoryItem = {
  /** The rights row id, e.g. `font:Roboto` or `model:onnx-community/whisper-base_timestamped`. */
  id: string;
  kind: StudioInventoryKind;
  /** The name a graph or a job uses: the font family, the model id. */
  name: string;
  license: string | null;
  uses: { redistribution: boolean; localRuntime: boolean; hostedUse: boolean };
  /** Why the owner withheld a use, by use. */
  restrictions: Partial<Record<'redistribution' | 'localRuntime' | 'hostedUse', string>>;
  approvedOn: string | null;
  /** The Studio worker capability that runs it, or null when nothing beyond the editor needs it. */
  capability: StudioCommandCapability | null;
  /** For a model: the generated-file producers it serves (`transcript`, `tts`, `musicgen`). */
  producers: string[];
};

export type StudioAuthorizedInventory = {
  approval: { approvedBy: string; approvedOn: string } | null;
  /** Whether the engine as a whole may be redistributed; false blocks every redistribution use. */
  distributionApproved: boolean;
  items: StudioInventoryItem[];
};

/** UTF-16 code-unit order, independent of the locale. */
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const PRODUCER_CAPABILITY: Readonly<Record<string, StudioCommandCapability>> = {
  transcript: 'transcriptionWorker',
  tts: 'generationWorker',
  musicgen: 'generationWorker',
};

/** Frame interpolation weights run where a restoration runs (`job.enqueueInterpolation`). */
const INTERPOLATION_MODELS = new Set(['model:walterlow/RIFE_fp32_timestep']);

const kindOf = (id: string, row: StudioResourceRights): StudioInventoryKind => {
  const prefix = id.slice(0, id.indexOf(':'));
  const kind = (STUDIO_INVENTORY_KINDS as readonly string[]).includes(prefix) ? prefix : row.kind;
  return (STUDIO_INVENTORY_KINDS as readonly string[]).includes(kind) ? (kind as StudioInventoryKind) : 'asset';
};

const producersOf = (id: string) =>
  Object.entries(studioProducerModels)
    .filter(([, models]) => models.includes(id))
    .map(([producer]) => producer)
    .sort();

const capabilityOf = (id: string, kind: StudioInventoryKind, producers: string[]): StudioCommandCapability | null => {
  if (kind === 'voice') {
    return 'generationWorker';
  }
  if (INTERPOLATION_MODELS.has(id)) {
    return 'restorationWorker';
  }
  for (const producer of producers) {
    if (PRODUCER_CAPABILITY[producer]) {
      return PRODUCER_CAPABILITY[producer];
    }
  }
  return null;
};

export const buildStudioAuthorizedInventory = (
  table: Readonly<Record<string, StudioResourceRights>> = studioResourceRights,
  distributionApproval: boolean = STUDIO_DISTRIBUTION_APPROVAL,
): StudioAuthorizedInventory => {
  const items = Object.entries(table)
    .map(([id, row]): StudioInventoryItem => {
      const kind = kindOf(id, row);
      const producers = producersOf(id);
      return {
        id,
        kind,
        name: id.slice(id.indexOf(':') + 1),
        license: row.license,
        uses: {
          redistribution: checkStudioRights(id, StudioRightsUse.Redistribution, table, distributionApproval).allowed,
          localRuntime: checkStudioRights(id, StudioRightsUse.LocalRuntime, table, distributionApproval).allowed,
          hostedUse: checkStudioRights(id, StudioRightsUse.HostedUse, table, distributionApproval).allowed,
        },
        restrictions: { ...row.restrictions },
        approvedOn: row.approvedOn,
        capability: capabilityOf(id, kind, producers),
        producers,
      };
    })
    .sort((a, b) => byCodeUnits(a.id, b.id));
  // the generator writes null when no owner approval exists
  const approval = STUDIO_RIGHTS_APPROVAL as { approvedBy: string; approvedOn: string } | null;
  return {
    approval: approval ? { approvedBy: approval.approvedBy, approvedOn: approval.approvedOn } : null,
    distributionApproved: distributionApproval,
    items,
  };
};

export type StudioProjectResourceUse = {
  kind: 'font' | 'lut' | 'model';
  /** As written in the graph. */
  name: string;
  /** The rights row it resolves to. */
  rightsId: string;
  license: string | null;
  /** Whether it may run on this server (the use a render or preview here needs). */
  allowed: boolean;
  /** Why not, when it may not. */
  detail: string | null;
};

const REFERENCE_KINDS: ReadonlyMap<StudioResourceKind, StudioProjectResourceUse['kind']> = new Map([
  [StudioResourceKind.Font, 'font'],
  [StudioResourceKind.Lut, 'lut'],
  [StudioResourceKind.Model, 'model'],
]);

/** The fonts, bundled LUTs and models a graph references, each with its rights verdict here. */
export const studioProjectResourceUses = (
  graph: unknown,
  table: Readonly<Record<string, StudioResourceRights>> = studioResourceRights,
): StudioProjectResourceUse[] => {
  const seen = new Set<string>();
  const uses: StudioProjectResourceUse[] = [];
  for (const reference of extractStudioResourceReferences(graph).references) {
    const kind = REFERENCE_KINDS.get(reference.kind);
    // a LUT kept with the project is a kept file, listed with the others
    if (!kind || (kind === 'lut' && reference.lutSource === 'import')) {
      continue;
    }
    const rightsId = `${kind}:${reference.id}`;
    if (seen.has(rightsId)) {
      continue;
    }
    seen.add(rightsId);
    const verdict = checkStudioRights(rightsId, StudioRightsUse.LocalRuntime, table);
    uses.push({
      kind,
      name: reference.id,
      rightsId,
      license: Object.hasOwn(table, rightsId) ? table[rightsId].license : null,
      allowed: verdict.allowed,
      detail: verdict.allowed ? null : verdict.detail,
    });
  }
  return uses.sort((a, b) => byCodeUnits(a.rightsId, b.rightsId));
};
