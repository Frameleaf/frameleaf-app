/**
 * Studio resource rights enforcement (FL-86, `STU-103`).
 *
 * Every model, voice, font, bundled weight, tool and asset service the pinned engine can reach
 * has a reviewed decision for three uses in `studio/dependency-attribution.json`, mirrored into
 * `studio-rights.generated.ts`, together with the owner's approval of all 210 bundled resources
 * (FL-146, September 25, 2026, `studio/rights-approval.json`), which is bound to each row's digest.
 * The owner withheld hosted use of MusicGen-small (CC-BY-NC-4.0, FL-146 comment 34944): it runs on
 * this server or a LAN worker, never on Frameleaf Cloud, and the refusal gives that reason.
 * A use is admitted only when its decision is `allowed`; a resource that is new, unknown or changed
 * after approval is blocked (`rightsPolicy.unknownResource`), and a
 * refusal always names the row, so a blocked resource blocks the feature that needs it instead
 * of being silently dropped.
 */
import { StudioDestination } from 'src/utils/studio-resources.js';
import {
  STUDIO_DISTRIBUTION_APPROVAL,
  type StudioResourceRights,
  studioResourceRights,
} from 'src/utils/studio-rights.generated.js';

export enum StudioRightsUse {
  /** Copying the bytes to someone else: a bundle, a download, an installer. */
  Redistribution = 'redistribution',
  /** Loading the resource on this deployment's own machines (this server or a LAN worker). */
  LocalRuntime = 'localRuntime',
  /** Loading it on a hosted service that runs work for the deployment (the cloud destination). */
  HostedUse = 'hostedUse',
}

/** The deployment catalogue classes and the rights-row prefix each resolves to. */
export type StudioRightsCatalog = 'font' | 'lut' | 'audio' | 'model' | 'voice' | 'weights' | 'tool' | 'asset';

export type StudioRightsVerdict = { allowed: true; id: string } | { allowed: false; id: string; detail: string };

/** The rights row id for a catalogue entry, e.g. `font:Roboto` or `model:Xenova/musicgen-small`. */
export const studioRightsId = (catalog: StudioRightsCatalog, name: string) => `${catalog}:${name}`;

/** Local and LAN workers run on the deployment's own machines; the cloud destination is hosted use. */
export const studioRightsUseFor = (destination: StudioDestination): StudioRightsUse =>
  destination === StudioDestination.RunPod ? StudioRightsUse.HostedUse : StudioRightsUse.LocalRuntime;

const useLabel: Record<StudioRightsUse, string> = {
  [StudioRightsUse.Redistribution]: 'redistribution',
  [StudioRightsUse.LocalRuntime]: 'use on this server',
  [StudioRightsUse.HostedUse]: 'hosted use',
};

export const checkStudioRights = (
  id: string,
  use: StudioRightsUse,
  table: Readonly<Record<string, StudioResourceRights>> = studioResourceRights,
  distributionApproval: boolean = STUDIO_DISTRIBUTION_APPROVAL,
): StudioRightsVerdict => {
  const row = Object.hasOwn(table, id) ? table[id] : undefined;
  if (!row) {
    return { allowed: false, id, detail: `${id} has no reviewed rights decision, so it is blocked.` };
  }
  if (use === StudioRightsUse.Redistribution && !distributionApproval) {
    return {
      allowed: false,
      id,
      detail: `${id}: redistribution is blocked until the engine distribution is approved.`,
    };
  }
  if (row[use] !== 'allowed') {
    // A use the owner withheld from an approved row says why (MusicGen-small's CC-BY-NC-4.0 licence
    // keeps it off hosted use); anything else is simply not approved yet.
    const restriction = row.restrictions?.[use];
    return {
      allowed: false,
      id,
      detail: restriction
        ? `${id}: ${useLabel[use]} is not allowed. ${restriction}`
        : `${id}: ${useLabel[use]} is blocked until the owner approves it.`,
    };
  }
  return { allowed: true, id };
};

/**
 * Generated intermediates whose producer needs model weights. A producer resolves only when at
 * least one model of its family is admitted for the use; otherwise the row names the family.
 */
export const studioProducerModels: Readonly<Record<string, readonly string[]>> = {
  musicgen: ['model:Xenova/musicgen-small'],
  tts: [
    'model:onnx-community/Kokoro-82M-v1.0-ONNX',
    'model:OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX',
    'model:supertonic-3',
  ],
  transcript: [
    'model:Olicorne/parakeet-tdt-0.6b-v3-smoothquant-onnx',
    'model:onnx-community/whisper-tiny_timestamped',
    'model:onnx-community/whisper-base_timestamped',
    'model:onnx-community/whisper-small_timestamped',
    'model:onnx-community/whisper-large-v3-turbo_timestamped',
  ],
};

/** Producers that run no licensed model: the editor's own derived files. */
export const STUDIO_LOCAL_PRODUCERS: ReadonlySet<string> = new Set(['proxy', 'waveform', 'reverse-conform', 'chunk']);

/**
 * The rights verdict for a generated file's producer. Null for the editor's own derived files; a
 * producer this server does not know is refused, never admitted by default.
 */
export const checkStudioProducerRights = (
  producer: string,
  use: StudioRightsUse,
  table: Readonly<Record<string, StudioResourceRights>> = studioResourceRights,
): StudioRightsVerdict | null => {
  if (STUDIO_LOCAL_PRODUCERS.has(producer)) {
    return null;
  }
  const models = Object.hasOwn(studioProducerModels, producer) ? studioProducerModels[producer] : undefined;
  if (!models) {
    return {
      allowed: false,
      id: `producer:${producer}`,
      detail: `${producer} is not a producer this server knows, so its output is not used.`,
    };
  }
  const admitted = models.map((id) => checkStudioRights(id, use, table)).find((verdict) => verdict.allowed);
  return (
    admitted ?? {
      allowed: false,
      id: models[0],
      detail: `${producer} needs one of ${models.join(', ')}; ${useLabel[use]} of each is blocked until the owner approves it.`,
    }
  );
};

/**
 * Whether any render worker has been qualified with the administrator-installed Dolby tools. The
 * owner approved the tools' rights (FL-146, 2026-09-25), but no worker proves them yet: that is
 * hardware and tool qualification (FL-145). Until then Dolby Vision output is refused.
 */
export const STUDIO_DOLBY_TOOLS_QUALIFIED = false;

/** Dolby Vision output needs the administrator-installed Dolby tools (`tool:dolby-portal`). */
export const STUDIO_DOLBY_TOOLS_ID = 'tool:dolby-portal';
