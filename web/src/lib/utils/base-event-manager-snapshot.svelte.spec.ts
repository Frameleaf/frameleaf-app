import { BaseEventManager, type EventMap } from './base-event-manager.svelte';

describe('event snapshot ownership', () => {
  it('retains bare callback context and shared argument identity', () => {
    const manager = new BaseEventManager<{ change: [{ count: number }, string[]] }>();
    const data = { count: 0 };
    const values: string[] = [];
    const contexts: unknown[] = [];
    const references: unknown[][] = [];
    manager.on({
      change(this: unknown, payload, output) {
        contexts.push(this);
        references.push([payload, output]);
        payload.count++;
        output.push('first');
      },
    });
    manager.on({
      change(this: unknown, payload, output) {
        contexts.push(this);
        references.push([payload, output]);
        output.push(`second:${payload.count}`);
      },
    });

    expect(manager.emit('change', data, values)).toBeUndefined();
    expect(contexts).toEqual([undefined, undefined]);
    expect(values).toEqual(['first', 'second:1']);
    for (const [payload, output] of references) {
      expect(payload).toBe(data);
      expect(output).toBe(values);
    }
  });

  it('cleans every owned event while the outer dispatch retains its snapshot', () => {
    const manager = new BaseEventManager<{ first: []; second: [] }>();
    const calls: string[] = [];
    let remove = () => {};
    const removeFirst = manager.on({
      first: () => {
        calls.push('first');
        remove();
        manager.emit('second');
      },
    });
    remove = manager.on({
      first: () => {
        calls.push('owned:first');
      },
      second: () => {
        calls.push('owned:second');
      },
    });
    const removeOther = manager.on({
      second: () => {
        calls.push('other:second');
      },
    });

    manager.emit('first');
    expect(calls).toEqual(['first', 'other:second', 'owned:first']);
    remove();
    calls.length = 0;
    manager.emit('first');
    expect(calls).toEqual(['first', 'other:second']);
    removeFirst();
    removeOther();
    expect(manager.hasListeners('first')).toBe(false);
    expect(manager.hasListeners('second')).toBe(false);
  });

  it('captures subscription getters before registration and owns their callback references', () => {
    const manager = new BaseEventManager<{ first: []; second: [] }>();
    const observations: boolean[] = [];
    const calls: string[] = [];
    const subscriptions: EventMap<{ first: []; second: [] }> = {
      first: () => {
        calls.push('original');
      },
      get second() {
        observations.push(manager.hasListeners('first'));
        return () => {
          calls.push('second');
        };
      },
    };
    const remove = manager.on(subscriptions);
    subscriptions.first = () => {
      calls.push('replacement');
    };
    manager.emit('first');
    manager.emit('second');
    expect(observations).toEqual([false]);
    expect(calls).toEqual(['original', 'second']);
    remove();
    expect(manager.hasListeners('first')).toBe(false);
    expect(manager.hasListeners('second')).toBe(false);
  });
});
