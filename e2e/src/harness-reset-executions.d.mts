export type ResetExecutionBlocker = { kind: 'attempt' | 'operation'; id: string; active: boolean };
export type ResetExecutionQuery = (text: string) => Promise<{ rows: ResetExecutionBlocker[] }>;

export function getResetExecutionBlocker(query: ResetExecutionQuery): Promise<ResetExecutionBlocker | undefined>;
export function resetExecutionRefusal(blocker: Pick<ResetExecutionBlocker, 'kind' | 'id'>): Error;
export function drainAfterExecutorStop(query: ResetExecutionQuery, drain: () => Promise<boolean>): Promise<boolean>;
export function assertResetExecutionsStopped(query: ResetExecutionQuery): Promise<void>;
