import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadAssetsStore as uploads } from '$lib/stores/upload';
import { UploadState, type UploadAsset } from '$lib/types';

const file = new File(['bytes'], 'photo.jpg');
const row = (id: string): UploadAsset => ({ id, file });
beforeEach(() => uploads.reset());
afterEach(() => vi.restoreAllMocks());

describe('upload store contracts', () => {
  it('initializes rows, counts and remaining work and replaces an existing ID with the supplied reference', () => {
    uploads.addItem(row('a'));
    expect(get(uploads)[0]).toMatchObject({ id: 'a', file, state: UploadState.PENDING, progress: 0, speed: 0, eta: 0 });
    expect(get(uploads.remainingUploads)).toBe(1);
    expect(get(uploads.isUploading)).toBe(true);
    const replacement = { ...row('a'), state: UploadState.DONE };
    uploads.addItem(replacement);
    expect(get(uploads)[0]).toBe(replacement);
    expect(get(uploads.stats).total).toBe(1);
    expect(get(uploads.remainingUploads)).toBe(0);
  });

  it('keeps ordering, untouched row identity and previous update snapshots', () => {
    uploads.addItem(row('a'));
    uploads.addItem(row('b'));
    const previous = get(uploads);
    uploads.updateItem('a', { progress: 25 });
    const current = get(uploads);
    expect(current).not.toBe(previous);
    expect(current.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(current[1]).toBe(previous[1]);
    expect(previous[0].progress).toBe(0);
    expect(current[0].progress).toBe(25);
  });

  it('updates every row matching an ID even after a caller changes an ID', () => {
    uploads.addItem(row('a'));
    uploads.addItem(row('b'));
    uploads.updateItem('b', { id: 'a' });
    uploads.updateItem('a', { progress: 50 });
    expect(get(uploads).map(({ progress }) => progress)).toEqual([50, 50]);
  });

  it('replaces every duplicate ID without changing the old snapshot or total', () => {
    for (const id of ['before', 'match', 'between', 'other', 'after']) {
      uploads.addItem(row(id));
    }
    uploads.updateItem('other', { id: 'match' });
    const before = get(uploads);
    const replacement = { ...row('match'), state: UploadState.DONE };
    uploads.addItem(replacement);
    const after = get(uploads);
    expect(after).not.toBe(before);
    expect(after.map(({ id }) => id)).toEqual(['before', 'match', 'between', 'match', 'after']);
    expect(after[1]).toBe(replacement);
    expect(after[3]).toBe(replacement);
    expect(before[1]).not.toBe(replacement);
    expect(before[3]).not.toBe(replacement);
    for (const index of [0, 2, 4]) {
      expect(after[index]).toBe(before[index]);
    }
    expect(get(uploads.stats).total).toBe(5);
  });

  it('keeps submissions from a stats observer before the new row is appended', () => {
    let submitted = false;
    const stop = uploads.stats.subscribe(({ total }) => {
      if (total === 1 && !submitted) {
        submitted = true;
        uploads.addItem(row('observer'));
      }
    });
    uploads.addItem(row('new'));
    stop();
    expect(get(uploads).map(({ id }) => id)).toEqual(['observer', 'new']);
    expect(get(uploads.stats).total).toBe(2);
  });

  it('preserves removal counts and the distinction between dismissing errors and clearing finished rows', () => {
    for (const id of ['waiting', 'error', 'duplicate', 'done']) {
      uploads.addItem(row(id));
    }
    uploads.updateItem('error', { state: UploadState.ERROR });
    uploads.track('error');
    uploads.updateItem('duplicate', { state: UploadState.DUPLICATED });
    uploads.track('duplicate');
    uploads.updateItem('done', { state: UploadState.DONE });
    uploads.track('success');
    uploads.dismissErrors();
    expect(get(uploads).map(({ id }) => id)).toEqual(['waiting', 'duplicate', 'done']);
    expect(get(uploads.stats)).toEqual({ errors: 0, duplicates: 1, success: 1, total: 3 });
    uploads.clearFinished();
    expect(get(uploads).map(({ id }) => id)).toEqual(['waiting']);
    expect(get(uploads.stats)).toEqual({ errors: 0, duplicates: 0, success: 1, total: 3 });
    expect(get(uploads.remainingUploads)).toBe(1);
  });

  it('retains a row submitted by a stats subscriber during dismissal', () => {
    uploads.addItem(row('error'));
    uploads.updateItem('error', { state: UploadState.ERROR });
    uploads.track('error');
    const unsubscribe = uploads.stats.subscribe((stats) => {
      if (stats.errors === 0) {
        unsubscribe();
        uploads.addItem(row('new'));
      }
    });
    uploads.dismissErrors();
    unsubscribe();
    expect(get(uploads).map(({ id }) => id)).toEqual(['new']);
    expect(get(uploads.stats).total).toBe(1);
  });

  it('preserves update notification order and unknown-ID snapshots', () => {
    const events: string[] = [];
    const stopRows = uploads.subscribe(() => {
      events.push('rows');
    });
    const stopStats = uploads.stats.subscribe(() => {
      events.push('stats');
    });
    events.length = 0;
    uploads.addItem(row('a'));
    expect(events).toEqual(['stats', 'rows']);
    const previous = get(uploads);
    uploads.updateItem('missing', { progress: 99 });
    expect(get(uploads)).not.toBe(previous);
    expect(get(uploads)).toEqual(previous);
    stopRows();
    stopStats();
  });

  it('retains accurate progress, speed and ETA for ordinary upload events', () => {
    vi.spyOn(Date, 'now').mockReturnValue(4000);
    uploads.addItem(row('a'));
    uploads.updateItem('a', { startDate: 1000 });
    uploads.updateProgress('a', 300, 900);
    expect(get(uploads)[0]).toMatchObject({ progress: 33, speed: 100, eta: 6 });
  });
});

describe('upload progress bounds', () => {
  it.each([
    { loaded: 0, total: 0, start: 1000, now: 1000, progress: 0, speed: 0, eta: 0 },
    { loaded: 50, total: 100, start: 1000, now: 1000, progress: 50, speed: 0, eta: 0 },
    { loaded: 50, total: 100, start: 2000, now: 1000, progress: 50, speed: 0, eta: 0 },
    { loaded: 50, total: 100, start: 0, now: 1000, progress: 50, speed: 50, eta: 1 },
    { loaded: 150, total: 100, start: 1000, now: 2000, progress: 100, speed: 150, eta: 0 },
    { loaded: -50, total: 100, start: 1000, now: 2000, progress: 0, speed: 0, eta: 0 },
    { loaded: NaN, total: 100, start: 1000, now: 2000, progress: 0, speed: 0, eta: 0 },
    { loaded: 50, total: Infinity, start: 1000, now: 2000, progress: 0, speed: 50, eta: 0 },
  ])(
    'keeps progress finite when bytes=$loaded total=$total elapsed starts at $start',
    ({ loaded, total, start, now, ...expected }) => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      uploads.addItem(row('a'));
      uploads.updateItem('a', { startDate: start });
      uploads.updateProgress('a', loaded, total);
      expect(get(uploads)[0]).toMatchObject(expected);
    },
  );
});
