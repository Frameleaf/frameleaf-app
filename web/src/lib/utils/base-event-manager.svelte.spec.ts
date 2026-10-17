import { render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import EventManagerReactivity from '../../test-data/components/EventManagerReactivity.svelte';
import { BaseEventManager } from './base-event-manager.svelte';

describe('BaseEventManager', () => {
  it('keeps ordered snapshots through removal, additions and nested dispatch', () => {
    const manager = new BaseEventManager<{ change: [number]; other: [] }>();
    const calls: string[] = [];
    const cleanups: (() => void)[] = [];
    let removeSecond = () => {};
    cleanups.push(
      manager.on({
        change: (value) => {
          calls.push(`first:${value}`);
          if (value === 1) {
            removeSecond();
            cleanups.push(
              manager.on({
                change: (next) => {
                  calls.push(`added:${next}`);
                },
              }),
            );
            manager.emit('change', 2);
          }
        },
      }),
    );
    removeSecond = manager.on({
      change: (value) => {
        calls.push(`second:${value}`);
      },
    });
    const duplicate = (value: number) => {
      calls.push(`duplicate:${value}`);
    };
    const removeDuplicate = manager.on({ change: duplicate, other: undefined });
    cleanups.push(manager.on({ change: duplicate }));

    manager.emit('change', 1);
    expect(calls).toEqual([
      'first:1',
      'first:2',
      'duplicate:2',
      'duplicate:2',
      'added:2',
      'second:1',
      'duplicate:1',
      'duplicate:1',
    ]);
    removeDuplicate();
    removeDuplicate();
    calls.length = 0;
    manager.emit('change', 3);
    expect(calls).toEqual(['first:3', 'duplicate:3', 'added:3']);
    for (const cleanup of cleanups) {
      cleanup();
    }
    expect(manager.hasListeners('change')).toBe(false);
    expect(manager.hasListeners('other')).toBe(false);
  });

  it('propagates synchronous throws and leaves async callbacks unawaited', async () => {
    const manager = new BaseEventManager<{ change: [] }>();
    const calls: string[] = [];
    const error = new Error('listener failed');
    const remove = manager.on({
      change: () => {
        throw error;
      },
    });
    manager.on({
      change: async () => {
        await Promise.resolve();
        calls.push('async');
      },
    });
    manager.on({
      change: () => {
        calls.push('sync');
      },
    });
    expect(() => manager.emit('change')).toThrow(error);
    expect(calls).toEqual([]);
    remove();
    expect(manager.emit('change')).toBeUndefined();
    expect(calls).toEqual(['sync']);
    await Promise.resolve();
    expect(calls).toEqual(['sync', 'async']);
  });

  it('preserves Svelte tracking for listener checks and dispatch across all subscriptions', () => {
    const manager = new BaseEventManager<Record<string, []>>();
    const observations: boolean[] = [];
    let dispatches = 0;
    const removeEffect = manager.on({ effect: () => dispatches++ });
    const view = render(EventManagerReactivity, { manager, observations });
    flushSync();
    expect(screen.getByRole('button')).toBeDisabled();
    const remove = manager.on({ first: () => {} });
    flushSync();
    expect(screen.getByRole('button')).toBeEnabled();
    const removeOther = manager.on({ other: () => {} });
    flushSync();
    removeOther();
    flushSync();
    removeOther();
    flushSync();
    manager.on({ missing: undefined })();
    flushSync();
    remove();
    flushSync();
    expect(screen.getByRole('button')).toBeDisabled();
    expect(observations).toEqual([false, true, true, true, true, false]);
    expect(dispatches).toBe(6);
    view.unmount();
    removeEffect();
  });
});
