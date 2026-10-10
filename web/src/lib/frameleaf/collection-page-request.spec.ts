import { describe, expect, it } from 'vitest';
import { publishCollectionPage } from './collection-page-request';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe('collection page requests', () => {
  it('keeps the new collection visible when an old request finishes late', async () => {
    const old = deferred<string[]>();
    const next = deferred<string[]>();
    let collection = 'old';
    let visible: string[] = [];
    let loading = true;
    const request = (id: string, result: Promise<string[]>) =>
      publishCollectionPage(
        () => result,
        () => id === collection,
        (items) => (visible = items),
        () => (loading = false),
      );

    const oldRequest = request('old', old.promise);
    collection = 'next';
    const nextRequest = request('next', next.promise);
    next.resolve(['new-frame']);
    await nextRequest;
    old.resolve(['old-frame']);
    await oldRequest;

    expect(visible).toEqual(['new-frame']);
    expect(loading).toBe(false);
  });

  it('does not settle the current loading state when an old request fails', async () => {
    const old = deferred<string[]>();
    const next = deferred<string[]>();
    let collection = 'old';
    let loading = true;
    const oldRequest = publishCollectionPage(
      () => old.promise,
      () => collection === 'old',
      () => {},
      () => (loading = false),
    );
    collection = 'next';
    const nextRequest = publishCollectionPage(
      () => next.promise,
      () => collection === 'next',
      () => {},
      () => (loading = false),
    );
    old.reject(new Error('offline'));
    await expect(oldRequest).resolves.toBeUndefined();
    expect(loading).toBe(true);
    next.resolve([]);
    await nextRequest;
    expect(loading).toBe(false);
  });
});
