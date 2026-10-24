import { MlProcessingSource, MlProcessingSourceState } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { moveSource, sameOrder, statusOf } from '$lib/frameleaf/processing-order';

const { Local, Desktops, Cloud } = MlProcessingSource;

describe('the processing order (FL-456)', () => {
  it('moves a place one step up or down, and not past either end', () => {
    expect(moveSource([Local, Desktops, Cloud], 2, -1)).toEqual([Local, Cloud, Desktops]);
    expect(moveSource([Local, Desktops, Cloud], 0, 1)).toEqual([Desktops, Local, Cloud]);
    expect(moveSource([Local, Desktops, Cloud], 0, -1)).toEqual([Local, Desktops, Cloud]);
    expect(moveSource([Local, Desktops, Cloud], 2, 1)).toEqual([Local, Desktops, Cloud]);
  });

  it('compares orders place by place', () => {
    expect(sameOrder([Local, Cloud], [Local, Cloud])).toBe(true);
    expect(sameOrder([Local, Cloud], [Cloud, Local])).toBe(false);
  });

  it('says a place the server does not mention is not set up', () => {
    expect(statusOf([], Cloud)).toEqual({ source: Cloud, state: MlProcessingSourceState.NotSetUp, ready: 0, total: 0 });
    const ready = { source: Local, state: MlProcessingSourceState.Ready, ready: 1, total: 1 };
    expect(statusOf([ready], Local)).toBe(ready);
  });
});
