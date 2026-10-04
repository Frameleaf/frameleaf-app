import { jobSignal } from 'src/queue/context.js';
import { QUEUE_TIMING } from 'src/queue/types.js';

/** One deadline spans connection, headers, and the entire response body. */
export async function fetchJobText(
  input: string | URL,
  init: RequestInit,
  deadlineMs: number = QUEUE_TIMING.mlDeadline,
) {
  const parent = jobSignal();
  const signal = AbortSignal.any([
    AbortSignal.timeout(deadlineMs),
    ...(init.signal ? [init.signal] : []),
    ...(parent ? [parent] : []),
  ]);
  const response = await fetch(input, { ...init, signal });
  const body = await response.text();
  signal.throwIfAborted();
  return { response, body };
}
