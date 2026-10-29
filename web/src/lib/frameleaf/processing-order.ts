/**
 * FL-456: the order processing tries its places in (this server, your computers, Frameleaf Cloud). A job
 * runs on the first place that can take it now and waits when none can. The page shows the order as a
 * list a person moves places up and down in, with what each place can do now.
 */
import { MlProcessingSource, MlProcessingSourceState, type MlProcessingSourceStatusDto } from '@frameleaf/sdk';

/** The Pill tones (`settings/kit/Pill.svelte`). */
type KitTone = 'good' | 'warn' | 'bad' | 'off';

export const SOURCE_NAME_KEY = {
  [MlProcessingSource.Local]: 'frameleaf_order_local',
  [MlProcessingSource.Desktops]: 'frameleaf_order_desktops',
  [MlProcessingSource.Cloud]: 'frameleaf_order_cloud',
} as const;

export const SOURCE_HELP_KEY = {
  [MlProcessingSource.Local]: 'frameleaf_order_local_help',
  [MlProcessingSource.Desktops]: 'frameleaf_order_desktops_help',
  [MlProcessingSource.Cloud]: 'frameleaf_order_cloud_help',
} as const;

export const STATE_KEY = {
  [MlProcessingSourceState.Ready]: 'frameleaf_order_state_ready',
  [MlProcessingSourceState.NotAnswering]: 'frameleaf_order_state_not_answering',
  [MlProcessingSourceState.TurnedOff]: 'frameleaf_order_state_off',
  [MlProcessingSourceState.NeedsPermission]: 'frameleaf_order_state_permission',
  [MlProcessingSourceState.NotSetUp]: 'frameleaf_order_state_not_set_up',
} as const;

export const STATE_TONE: Record<MlProcessingSourceState, KitTone> = {
  [MlProcessingSourceState.Ready]: 'good',
  [MlProcessingSourceState.NotAnswering]: 'warn',
  [MlProcessingSourceState.TurnedOff]: 'off',
  [MlProcessingSourceState.NeedsPermission]: 'warn',
  [MlProcessingSourceState.NotSetUp]: 'off',
};

/** The order with the place at `index` moved one step up (-1) or down (+1); unchanged at either end. */
export const moveSource = (order: readonly MlProcessingSource[], index: number, step: -1 | 1): MlProcessingSource[] => {
  const target = index + step;
  if (index < 0 || index >= order.length || target < 0 || target >= order.length) {
    return [...order];
  }
  const next = [...order];
  next.splice(target, 0, ...next.splice(index, 1));
  return next;
};

export const sameOrder = (a: readonly MlProcessingSource[], b: readonly MlProcessingSource[]) =>
  a.length === b.length && a.every((source, index) => source === b[index]);

/** What one place can do now; a place the server says nothing about is not set up. */
export const statusOf = (
  sources: readonly MlProcessingSourceStatusDto[],
  source: MlProcessingSource,
): MlProcessingSourceStatusDto =>
  sources.find((status) => status.source === source) ?? {
    source,
    state: MlProcessingSourceState.NotSetUp,
    ready: 0,
    total: 0,
  };
