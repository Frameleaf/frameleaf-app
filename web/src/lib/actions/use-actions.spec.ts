import { type ActionArray, type HTMLActionEntry, useActions } from '$lib/actions/use-actions';

describe('composed actions', () => {
  const node = document.createElement('div');

  it('passes the original node, parameter references and argument counts in order', () => {
    const plain = vi.fn();
    const parameter = { value: 1 };
    const tuple = vi.fn();
    const shortTuple = vi.fn();
    const explicitUndefined = vi.fn();
    useActions(node, [
      plain,
      [tuple, parameter],
      [shortTuple] as unknown as HTMLActionEntry,
      [explicitUndefined, undefined],
    ]);
    expect(plain.mock.calls).toEqual([[node]]);
    expect(tuple.mock.calls).toEqual([[node, parameter]]);
    expect(tuple.mock.calls[0][1]).toBe(parameter);
    expect(shortTuple.mock.calls).toEqual([[node]]);
    expect(explicitUndefined.mock.calls).toEqual([[node, undefined]]);
    for (const action of [plain, tuple, shortTuple, explicitUndefined]) {
      expect(action.mock.contexts[0]).toBeUndefined();
    }
    expect(plain.mock.invocationCallOrder[0]).toBeLessThan(tuple.mock.invocationCallOrder[0]);
  });

  it('mounts SVG actions without changing their node', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const action = vi.fn();
    useActions(svg, [[action, 3]]);
    expect(action).toHaveBeenCalledWith(svg, 3);
  });

  it('updates the mounted handlers, retaining their receiver and argument counts', () => {
    const first = { update: vi.fn(), destroy: vi.fn() };
    const second = { update: vi.fn() };
    const third = { update: vi.fn() };
    const replacement = vi.fn();
    const parameter = { value: 2 };
    const actions = useActions(node, [() => first, [() => second, 1], [() => third, undefined]]);
    actions.update([replacement, [replacement, parameter], [replacement, undefined]]);
    expect(replacement).not.toHaveBeenCalled();
    expect(first.update.mock.calls).toEqual([[]]);
    expect(second.update.mock.calls).toEqual([[parameter]]);
    expect(second.update.mock.calls[0][0]).toBe(parameter);
    expect(third.update.mock.calls).toEqual([[undefined]]);
    expect(first.update.mock.contexts[0]).toBe(first);
    expect(second.update.mock.contexts[0]).toBe(second);
  });

  it('supports empty and absent action arrays', () => {
    for (const entries of [[], undefined] as unknown as ActionArray[]) {
      const actions = useActions(node, entries);
      actions.update([]);
      actions.destroy();
    }
  });

  it('refuses length changes before updating any handler', () => {
    const update = vi.fn();
    const destroy = vi.fn();
    const actions = useActions(node, [() => ({ update, destroy })]);
    expect(() => actions.update([])).toThrow('You must not change the length of an actions array.');
    expect(update).not.toHaveBeenCalled();
    actions.destroy();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('skips void returns without losing the update slot of later actions', () => {
    const update = vi.fn();
    const actions = useActions(node, [() => {}, () => ({ update })]);
    actions.update([() => {}, [() => {}, 5]]);
    expect(update).toHaveBeenCalledWith(5);
    actions.destroy();
  });

  it('preserves update failures and stops the remaining updates', () => {
    const failure = new Error('update failed');
    const next = vi.fn();
    const actions = useActions(node, [
      () => ({
        update: () => {
          throw failure;
        },
      }),
      () => ({ update: next }),
    ]);
    expect(() => actions.update([() => {}, () => {}])).toThrow(failure);
    expect(next).not.toHaveBeenCalled();
    actions.destroy();
  });

  it('destroys in registration order, with the mounted receiver, exactly once', () => {
    const first = { destroy: vi.fn() };
    const second = { destroy: vi.fn() };
    const actions = useActions(node, [() => first, () => second]);
    actions.destroy();
    actions.destroy();
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(second.destroy).toHaveBeenCalledOnce();
    expect(first.destroy.mock.contexts[0]).toBe(first);
    expect(first.destroy.mock.invocationCallOrder[0]).toBeLessThan(second.destroy.mock.invocationCallOrder[0]);
  });

  it('releases earlier actions when a later setup fails', () => {
    const first = vi.fn();
    const second = vi.fn();
    const failure = new Error('mount failed');
    expect(() =>
      useActions(node, [
        () => ({ destroy: first }),
        () => ({ destroy: second }),
        () => {
          throw failure;
        },
      ]),
    ).toThrow(failure);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('reports the setup error and cleanup error together while releasing other actions', () => {
    const setupFailure = new Error('mount failed');
    const cleanupFailure = new Error('cleanup failed');
    const next = vi.fn();
    let thrown: unknown;
    try {
      useActions(node, [
        () => ({
          destroy: () => {
            throw cleanupFailure;
          },
        }),
        () => ({ destroy: next }),
        () => {
          throw setupFailure;
        },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).cause).toBe(setupFailure);
    expect((thrown as AggregateError).errors).toEqual([setupFailure, cleanupFailure]);
    expect(next).toHaveBeenCalledOnce();
  });

  it('continues cleanup after a failure and retries only the failed handler', () => {
    const failure = new Error('cleanup failed');
    const first = vi.fn().mockImplementationOnce(() => {
      throw failure;
    });
    const next = vi.fn();
    const actions = useActions(node, [() => ({ destroy: first }), () => ({ destroy: next })]);
    expect(() => actions.destroy()).toThrow(failure);
    expect(next).toHaveBeenCalledOnce();
    actions.destroy();
    actions.destroy();
    expect(first).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, 0])('preserves a thrown cleanup value %s without skipping later cleanup', (failure) => {
    const next = vi.fn();
    const actions = useActions(node, [
      () => ({
        destroy: () => {
          throw failure;
        },
      }),
      () => ({ destroy: next }),
    ]);
    let caught = false;
    try {
      actions.destroy();
    } catch (error) {
      caught = true;
      expect(error).toBe(failure);
    }
    expect(caught).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });

  it('ignores reentrant destroy calls and does not update during or after disposal', () => {
    const update = vi.fn();
    const destroy = vi.fn(() => {
      actions.destroy();
      actions.update([]);
    });
    const next = vi.fn();
    const actions = useActions(node, [() => ({ update, destroy }), () => ({ destroy: next })]);
    actions.destroy();
    actions.update([() => {}, () => {}]);
    expect(destroy).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it('stops subsequent updates if the first update disposes the composed action', () => {
    const next = vi.fn();
    const actions = useActions(node, [() => ({ update: () => actions.destroy() }), () => ({ update: next })]);
    actions.update([() => {}, () => {}]);
    expect(next).not.toHaveBeenCalled();
  });
});
