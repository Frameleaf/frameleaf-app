import { z } from 'zod';
import { Refusal } from './contracts.js';
import { importSourceKinds } from './import-plan.js';

const statusSchema = z.object({
  run: z
    .object({
      operationId: z.uuid(),
      source: z.object({ kind: z.enum(importSourceKinds), version: z.string() }),
      status: z.enum(['copying', 'verifying', 'activated', 'abandoned']),
    })
    .nullable(),
  execution: z
    .object({
      phase: z.enum(['prepared', 'copying', 'verifying', 'activating', 'activated', 'rolling-back', 'abandoned']),
      writersMayHaveStarted: z.boolean(),
      abandoned: z.boolean(),
    })
    .nullable(),
});
type Source = NonNullable<z.infer<typeof statusSchema>['run']>['source'];
type Launch = (action: 'status' | 'run' | 'resume' | 'verify', activate?: true) => Promise<unknown>;
const refuse = (): never => {
  throw new Refusal('import_common_status_unexpected');
};

function parseStatus(value: unknown, operationId: string, source: Source) {
  const result = statusSchema.safeParse(value);
  if (!result.success) return refuse();
  const { run, execution } = result.data;
  if (
    run &&
    (!execution ||
      run.operationId !== operationId ||
      run.source.kind !== source.kind ||
      run.source.version !== source.version)
  )
    return refuse();
  return result.data;
}

/** Call after the durable Manager preflight step has initialized the Server's local journal. */
export async function completeCommonImport(operationId: string, source: Source, launch: Launch): Promise<void> {
  const readStatus = async () => {
    const { run, execution } = parseStatus(await launch('status'), operationId, source);
    if (execution?.abandoned) return refuse();
    if (!run) {
      if (execution && (execution.phase !== 'prepared' || execution.writersMayHaveStarted)) return refuse();
      return 'fresh';
    }
    if (!execution) return refuse();
    const { phase, writersMayHaveStarted } = execution;
    if (run.status === 'activated' && writersMayHaveStarted && phase === 'activated') return 'activated';
    if (run.status === 'activated' && writersMayHaveStarted && phase === 'activating') return 'verify';
    if (run.status === 'copying' && !writersMayHaveStarted && (phase === 'prepared' || phase === 'copying'))
      return 'resume';
    if (
      run.status === 'verifying' &&
      (phase === 'copying' || phase === 'verifying' || (phase === 'activating' && writersMayHaveStarted))
    )
      return 'verify';
    return refuse();
  };
  let state = await readStatus();
  if (state === 'fresh' || state === 'resume') {
    await launch(state === 'fresh' ? 'run' : 'resume');
    state = await readStatus();
  }
  if (state === 'activated') return;
  if (state !== 'verify') return refuse();
  await launch('verify', true);
  if ((await readStatus()) !== 'activated') return refuse();
}

/** Do not restart the source until the Server confirms rollback or an untouched journal. */
export async function rollbackCommonImport(
  operationId: string,
  source: Source,
  launch: (action: 'status' | 'rollback') => Promise<unknown>,
): Promise<void> {
  const inspect = async () => {
    const { run, execution } = parseStatus(await launch('status'), operationId, source);
    if (!execution) return 'untouched';
    const { phase, writersMayHaveStarted, abandoned } = execution;
    if (writersMayHaveStarted || run?.status === 'activated' || phase === 'activating' || phase === 'activated')
      return refuse();
    if (abandoned) {
      if ((!run || run.status === 'abandoned') && ['prepared', 'rolling-back', 'abandoned'].includes(phase))
        return 'abandoned';
      return refuse();
    }
    if (phase === 'abandoned' || (!run && phase !== 'prepared')) return refuse();
    return 'rollback';
  };
  if ((await inspect()) !== 'rollback') return;
  await launch('rollback');
  if ((await inspect()) !== 'abandoned') return refuse();
}
