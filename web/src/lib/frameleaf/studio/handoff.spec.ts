import { describe, expect, it } from 'vitest';
import { maxStudioHandoffAssets, parseStudioHandoff, studioHandoffQuery } from './handoff';

const parse = (query: string) => parseStudioHandoff(new URLSearchParams(query));

describe('studio handoff', () => {
  it('keeps the selection order, because it becomes the first cut', () => {
    expect(parse('assets=c,a,b').assetIds).toEqual(['c', 'a', 'b']);
  });

  it('collapses duplicates to the first occurrence', () => {
    expect(parse('assets=a,b,a').assetIds).toEqual(['a', 'b']);
  });

  it('drops anything that is not a plain identifier', () => {
    expect(parse('assets=good-1,../../etc,,  ,<script>,also_good').assetIds).toEqual(['good-1', 'also_good']);
  });

  it('caps the list so a pasted URL cannot fan out into thousands of requests', () => {
    const ids = Array.from({ length: maxStudioHandoffAssets + 25 }, (_, index) => `asset-${index}`);

    expect(parse(`assets=${ids.join(',')}`).assetIds).toHaveLength(maxStudioHandoffAssets);
  });

  it('opens a new draft when no project is named, and refuses a malformed one', () => {
    expect(parse('').projectId).toBeNull();
    expect(parse('project=proj-1').projectId).toBe('proj-1');
    expect(parse('project=../secret').projectId).toBeNull();
  });

  it('builds a link that parses back to what went in', () => {
    const query = studioHandoffQuery({ projectId: 'proj-1', assetIds: ['a', 'b'] });

    expect(parse(query.slice(1))).toEqual({ projectId: 'proj-1', assetIds: ['a', 'b'], returnTo: null, at: null });
  });

  it('builds a bare link when there is nothing to carry', () => {
    expect(studioHandoffQuery({})).toBe('');
    expect(studioHandoffQuery({ assetIds: ['../bad'] })).toBe('');
  });

  it('carries the quick editor that opened Studio and its exact playhead (FL-113)', () => {
    const query = studioHandoffQuery({ assetIds: ['a'], returnTo: 'a', at: { num: 25, den: 2 } });
    expect(query).toBe('?assets=a&from=a&at=25%2F2');
    expect(parseStudioHandoff(new URLSearchParams(query))).toEqual({
      projectId: null,
      assetIds: ['a'],
      returnTo: 'a',
      at: { num: 25, den: 2 },
    });
    expect(parseStudioHandoff(new URLSearchParams('from=../x&at=1.5'))).toMatchObject({ returnTo: null, at: null });
  });
});
