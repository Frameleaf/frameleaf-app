import { describe, expect, it } from 'vitest';
import { emptyDiscoveryQuery, parseDiscoveryQuery } from '$lib/components/discovery/query';
import { compilePaletteQuery, readPaletteState, availablePaletteModes } from '$lib/frameleaf/search-palette';
import { workflowFromSearch } from '$lib/frameleaf/workflow-source';

describe('spoken words query contract', () => {
  it('roundtrips raw words and explicit metadata without treating operators or dates as syntax', () => {
    const raw = 'photos in Paris 2024 person:Alex "ask not"';
    const q = compilePaletteQuery(
      { ...emptyDiscoveryQuery(), filter: { isFavorite: { eq: true } } },
      { text: raw, filter: {} },
      'speech',
    )!;
    expect(q.mode).toBe('speech');
    expect(q.text).toBe(raw);
    expect(readPaletteState(q)).toMatchObject({ input: raw, mode: 'speech' });
    const serialized = JSON.stringify(q);
    expect(parseDiscoveryQuery(JSON.parse(serialized))).toMatchObject({ ok: true, query: q });
    expect(q.filter).toEqual({ isFavorite: { eq: true } });
  });
  it('hides unavailable speech and refuses lossy workflow copying', () => {
    expect(availablePaletteModes({ smartSearch: true, ocr: true }).some((m) => m.value === 'speech')).toBe(false);
    expect(
      availablePaletteModes({ smartSearch: true, ocr: true, speech: true }).some((m) => m.value === 'speech'),
    ).toBe(true);
    expect(() => workflowFromSearch({ ...emptyDiscoveryQuery(), mode: 'speech', text: 'literal' })).toThrow();
  });
});
