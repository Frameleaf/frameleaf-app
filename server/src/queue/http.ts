import { jobSignal } from 'src/queue/context.js';
import { QUEUE_TIMING } from 'src/queue/types.js';

/** One deadline spans connection, headers, and the entire response body. */
export async function fetchJobText(
  input: string | URL,
  init: RequestInit,
  deadlineMs: number = QUEUE_TIMING.mlDeadline,
  maxResponseBytes = 32 * 1024 * 1024,
) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new RangeError('Invalid ML response byte limit');
  }
  const parent = jobSignal();
  const signal = AbortSignal.any([
    AbortSignal.timeout(deadlineMs),
    ...(init.signal ? [init.signal] : []),
    ...(parent ? [parent] : []),
  ]);
  const response = await fetch(input, { ...init, signal });
  const reader = response.body?.getReader();
  try {
    if (Number(response.headers.get('content-length')) > maxResponseBytes) {
      throw new Error('Machine learning response is too large');
    }
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    if (reader) {
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) throw new Error('Machine learning response is too large');
        chunks.push(decoder.decode(value, { stream: true }));
      }
    }
    chunks.push(decoder.decode());
    signal.throwIfAborted();
    return { response, body: chunks.join('') };
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
