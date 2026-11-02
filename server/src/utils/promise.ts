/** Node 22 equivalent of Promise.try: invoke now and reject synchronous throws. */
export async function tryPromise<T>(callback: () => T | PromiseLike<T>): Promise<T> {
  return callback();
}
