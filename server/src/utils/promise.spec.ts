import { tryPromise } from 'src/utils/promise.js';

describe('tryPromise', () => {
  it('invokes the callback synchronously and resolves its value', async () => {
    let called = false;
    const result = tryPromise(() => {
      called = true;
      return 42;
    });
    expect(called).toBe(true);
    await expect(result).resolves.toBe(42);
  });

  it('rejects synchronous throws without throwing to the caller', async () => {
    const error = new Error('failed');
    const result = tryPromise(() => {
      throw error;
    });
    await expect(result).rejects.toBe(error);
  });

  it('adopts an asynchronous result and its rejection', async () => {
    await expect(tryPromise(() => Promise.resolve(42))).resolves.toBe(42);
    const error = new Error('failed');
    await expect(tryPromise(() => Promise.reject(error))).rejects.toBe(error);
  });
});
