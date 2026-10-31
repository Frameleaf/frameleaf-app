import { AsyncLocalStorage } from 'node:async_hooks';
import { queueExecution } from 'src/queue/context.js';
/** Carried through host calls and child jobs so a workflow never reenters an asset's causal chain. */
export const workflowCausation = new AsyncLocalStorage<string[]>();

export function inheritWorkflowCausation<T extends Record<string, unknown>>(data: T): T & { causation?: string[] } {
  const chain =
    (data.causation as string[] | undefined) ??
    workflowCausation.getStore() ??
    (queueExecution.getStore()?.claim.data?.causation as string[] | undefined);
  return chain?.length ? { ...data, causation: [...chain] } : data;
}

export const workflowOwnership = new AsyncLocalStorage<() => Promise<void>>();
