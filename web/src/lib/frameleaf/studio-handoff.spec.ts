import { describe, expect, it, vi } from 'vitest';
import {
  clearStudioHandoff,
  HANDOFF_TTL_MS,
  parseStudioHandoff,
  readStudioHandoff,
  studioHandoffKey,
  writeStudioHandoff,
} from '$lib/frameleaf/studio-handoff';

class MemoryStorage implements Storage {
  #data = new Map<string, string>();
  get length() {
    return this.#data.size;
  }
  clear(): void {
    this.#data.clear();
  }
  getItem(key: string): string | null {
    return this.#data.has(key) ? this.#data.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.#data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#data.set(key, value);
  }
}

describe('Studio handoff contract', () => {
  it('round-trips a well-formed handoff', () => {
    const storage = new MemoryStorage();
    const written = writeStudioHandoff(
      { source: 'memory', sourceId: 'memory-1', title: 'A day in Banff', assetIds: ['a', 'b', 'a', 'c'] },
      storage,
    );
    expect(written.assetIds).toEqual(['a', 'b', 'c']);
    const read = readStudioHandoff(storage);
    expect(read).toEqual(written);
  });

  it('clears the queued handoff', () => {
    const storage = new MemoryStorage();
    writeStudioHandoff({ source: 'memory', sourceId: 'memory-1', title: 'Trip', assetIds: ['a'] }, storage);
    clearStudioHandoff(storage);
    expect(storage.getItem(studioHandoffKey)).toBeNull();
    expect(readStudioHandoff(storage)).toBeNull();
  });

  it('rejects malformed JSON', () => {
    expect(parseStudioHandoff('not json')).toBeNull();
  });

  it('rejects a payload from another schema version or source', () => {
    expect(
      parseStudioHandoff(
        JSON.stringify({
          version: 2,
          source: 'memory',
          sourceId: 'x',
          title: 'x',
          assetIds: ['a'],
          createdAt: Date.now(),
        }),
      ),
    ).toBeNull();
    expect(
      parseStudioHandoff(
        JSON.stringify({
          version: 1,
          source: 'library',
          sourceId: 'x',
          title: 'x',
          assetIds: ['a'],
          createdAt: Date.now(),
        }),
      ),
    ).toBeNull();
  });

  it('rejects a handoff with no surviving asset ids', () => {
    expect(
      parseStudioHandoff(
        JSON.stringify({
          version: 1,
          source: 'memory',
          sourceId: 'x',
          title: 'x',
          assetIds: [],
          createdAt: Date.now(),
        }),
      ),
    ).toBeNull();
    expect(
      parseStudioHandoff(
        JSON.stringify({
          version: 1,
          source: 'memory',
          sourceId: 'x',
          title: 'x',
          assetIds: [1, null, {}],
          createdAt: Date.now(),
        }),
      ),
    ).toBeNull();
  });

  it('treats an expired handoff as absent', () => {
    const now = Date.now();
    const raw = JSON.stringify({
      version: 1,
      source: 'memory',
      sourceId: 'memory-1',
      title: 'Trip',
      assetIds: ['a'],
      createdAt: now - HANDOFF_TTL_MS - 1,
    });
    expect(parseStudioHandoff(raw, now)).toBeNull();
  });

  it('caps the asset id list and drops duplicates', () => {
    const many = Array.from({ length: 2100 }, (_, index) => `asset-${index}`);
    const raw = JSON.stringify({
      version: 1,
      source: 'memory',
      sourceId: 'memory-1',
      title: 'Trip',
      assetIds: [...many, ...many],
      createdAt: Date.now(),
    });
    const parsed = parseStudioHandoff(raw);
    expect(parsed?.assetIds.length).toBe(2000);
  });

  it('never throws when storage is unavailable', () => {
    const throwing: Storage = {
      length: 0,
      clear: () => {},
      key: () => null,
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() =>
      writeStudioHandoff({ source: 'memory', sourceId: 'x', title: 'x', assetIds: ['a'] }, throwing),
    ).not.toThrow();
    expect(readStudioHandoff(throwing)).toBeNull();
    expect(() => clearStudioHandoff(throwing)).not.toThrow();
  });

  it('is not disturbed by an unrelated vi mock reset (isolation smoke check)', () => {
    vi.restoreAllMocks();
    expect(studioHandoffKey).toBe('frameleaf:studio-handoff:v1');
  });
});
