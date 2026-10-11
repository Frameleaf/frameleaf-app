/**
 * "Can this run here?" (FL-364): the one rule Graphics card check, Where work runs, Computers and
 * the landing page share for what this server can do on its own, so they give the same answer.
 *
 * Until now the pages answered from different signs: Where each job runs called Studio export
 * "runs on this server" because the hardware check found a processor, while the Overview and
 * Studio itself said nothing could export because no computer was connected for it. The rule here:
 *
 * - Studio export needs a computer with a graphics card that is connected and has proved it can do
 *   the work. Only the server knows that (`render-workers/compatibility`), so that is what is read.
 * - AI restoration runs where the server says a connected computer can take it, or where the
 *   hardware check found a graphics card able to run a restoration model.
 * - The other AI features follow the hardware check: what the AI service can load on the card it
 *   reached, or on the processor. While the AI service does not answer, nothing is claimed.
 */
import type { HardwareCheckResponseDto, RenderWorkerCompatibilityResponseDto } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import { hardwareConsequences, mlWorkloads, workerFromHardware, type WorkloadRowId } from '$lib/frameleaf/cloud-ml';
import { canRunStudioWork } from '$lib/frameleaf/computers';
import type { LadderWorkload } from '$lib/frameleaf/gpu-model-catalog';

/** Every kind of heavy work, in the order the pages list it. */
export type WorkKind = WorkloadRowId;
export const WORK_KINDS: readonly WorkKind[] = mlWorkloads.map(({ id }) => id);

/** The household name of a kind of work (the names Search & intelligence and Editing & playback use). */
export const workKindNameKey = (kind: WorkKind) => `frameleaf_workruns_name_${kind}` as Translations;

/** Studio export is made by the video side of the server; everything else is an AI feature. */
export const isAiWork = (kind: WorkKind) => kind !== 'render';

/** Work that never leaves home: it may move to another computer at home, never to Frameleaf Cloud. */
export const staysHome = (kind: WorkKind) => !mlWorkloads.find(({ id }) => id === kind)?.cloud;

export type HereAnswer = 'works' | 'slow' | 'no' | 'unknown';

export type HereFacts = {
  check: HardwareCheckResponseDto | null | undefined;
  compatibility: RenderWorkerCompatibilityResponseDto | null | undefined;
};

/** Work the AI service does quickly enough on a processor that a graphics card is not needed. */
const LIGHT: readonly WorkKind[] = ['search', 'faces', 'ocr'];

/** Whether this server, with whatever is connected to it now, can do a kind of work. */
export const runsHere = (kind: WorkKind, { check, compatibility }: HereFacts): HereAnswer => {
  if (kind === 'render') {
    const can = canRunStudioWork(compatibility, 'export');
    return can === undefined ? 'unknown' : can ? 'works' : 'no';
  }
  if (kind === 'restoration' && canRunStudioWork(compatibility, 'restoration')) {
    return 'works';
  }
  if (!check || !check.ml.reachable) {
    return 'unknown';
  }
  if (LIGHT.includes(kind)) {
    return 'works';
  }
  const worker = workerFromHardware(check);
  const row = hardwareConsequences(worker, null).find(({ workload }) => workload === (kind as LadderWorkload));
  const heaviest = row?.heaviest;
  if (!heaviest) {
    return 'no';
  }
  // Restoration on a processor is not offered: a minute of video would take hours.
  if (kind === 'restoration' && heaviest.band !== 'gpu') {
    return 'no';
  }
  return heaviest.band === 'gpu' && heaviest.speedClass !== 'slow' ? 'works' : 'slow';
};

/** How many better choices only Frameleaf Cloud can run, for "better quality is available". */
export const cloudOnlyChoices = (kind: WorkKind, check: HardwareCheckResponseDto | null | undefined) =>
  hardwareConsequences(workerFromHardware(check), null).find(({ workload }) => workload === (kind as LadderWorkload))
    ?.cloudOnly ?? 0;
