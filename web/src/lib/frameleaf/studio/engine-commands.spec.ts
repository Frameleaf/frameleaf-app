import { describe, expect, it, vi } from 'vitest';
import { createStudioBridge, type StudioBridgeContext } from './bridge';
import { createStudioCommandEnvelope, studioCommandDefinition } from './commands';
import { createStudioEngineCommandHandlers, createStudioGraphHistory, studioEngineCommandIds } from './engine-commands';
import { emptyStudioCapabilities, type StudioCommandApplication, type StudioCommandEngine } from './host-contract';

/**
 * FL-92 in the host: canonical commands reach the engine's command runtime through the bridge, the
 * result is staged as a draft, refusals are named, and history walks back and forward.
 */

const context = (overrides: Partial<StudioBridgeContext> = {}): StudioBridgeContext => ({
  revision: 4,
  hasLease: true,
  hasAccess: true,
  online: true,
  capabilities: emptyStudioCapabilities(),
  ...overrides,
});

const setup = (applyResult?: (graph: unknown) => StudioCommandApplication) => {
  let graph: unknown = { id: 'p', timeline: { items: [] }, step: 0 };
  let revision = 4;
  const staged: Array<{ graph: unknown; ids: readonly string[] }> = [];
  const engine: StudioCommandEngine = {
    apply: vi.fn(async (current: unknown) =>
      applyResult
        ? applyResult(current)
        : {
            status: 'applied' as const,
            graph: { ...(current as object), step: (current as { step: number }).step + 1 },
            digest: 'd',
          },
    ),
    dispose: vi.fn(),
  };
  const restore = vi.fn(async (to: number) => {
    revision += 1;
    graph = { restoredFrom: to };
    return true;
  });
  const history = createStudioGraphHistory(3);
  const handlers = createStudioEngineCommandHandlers({
    graph: () => graph,
    revision: () => revision,
    assets: () => [],
    stage: (next, ids) => {
      staged.push({ graph: next, ids });
      graph = next;
    },
    restore,
    engine: async () => engine,
    history,
  });
  const bridge = createStudioBridge({ context: () => context({ revision }), handlers });
  return { bridge, engine, staged, restore, history, graphOf: () => graph };
};

describe('studio engine commands (FL-92)', () => {
  it('handles every engine row the catalogue says changes the graph and can be undone', () => {
    for (const id of studioEngineCommandIds) {
      expect(studioCommandDefinition(id)).toMatchObject({ mutatesGraph: true, undoable: true });
    }
  });

  it('applies through the engine and stages the result with its command id', async () => {
    const { bridge, staged, engine } = setup();
    const [result] = await bridge.submit([
      createStudioCommandEnvelope('track.add', { kind: 'video' }, 4, { idempotencyKey: 'k1' }),
    ]);
    expect(result).toEqual({ status: 'accepted', idempotencyKey: 'k1', revision: 4 });
    expect(engine.apply).toHaveBeenCalledTimes(1);
    expect(staged).toEqual([{ graph: expect.objectContaining({ step: 1 }), ids: ['track.add'] }]);
  });

  it('settles an engine refusal with its reason, so a retry does not apply twice', async () => {
    const { bridge, engine, staged } = setup(() => ({
      status: 'rejected',
      index: 0,
      reason: 'invalid',
      detail: 'clipId: clip "x" does not exist',
    }));
    const envelope = createStudioCommandEnvelope('clip.delete', { clipId: 'x' }, 4, { idempotencyKey: 'k2' });
    const [first] = await bridge.submit([envelope]);
    const [second] = await bridge.submit([envelope]);
    expect(first).toMatchObject({
      status: 'rejected',
      reason: 'invalid',
      messageKey: 'frameleaf_studio_command_invalid',
    });
    expect(second).toEqual(first);
    expect(engine.apply).toHaveBeenCalledTimes(1);
    expect(staged).toEqual([]);
  });

  it('rejects a stale revision before the engine is asked', async () => {
    const { bridge, engine } = setup();
    const [result] = await bridge.submit([createStudioCommandEnvelope('track.add', { kind: 'audio' }, 3)]);
    expect(result).toMatchObject({ status: 'rejected', reason: 'stale-revision', revision: 4 });
    expect(engine.apply).not.toHaveBeenCalled();
  });

  it('undoes and redoes the graphs this session replaced', async () => {
    const { bridge, graphOf } = setup();
    await bridge.submit([createStudioCommandEnvelope('track.add', { kind: 'video' }, 4)]);
    await bridge.submit([createStudioCommandEnvelope('track.add', { kind: 'video' }, 4)]);
    expect(graphOf()).toMatchObject({ step: 2 });

    await bridge.submit([createStudioCommandEnvelope('history.undo', {}, 4)]);
    expect(graphOf()).toMatchObject({ step: 1 });
    await bridge.submit([createStudioCommandEnvelope('history.redo', {}, 4)]);
    expect(graphOf()).toMatchObject({ step: 2 });

    const [nothing] = await bridge.submit([createStudioCommandEnvelope('history.redo', {}, 4)]);
    expect(nothing).toMatchObject({ status: 'rejected', reason: 'invalid' });
  });

  it('falls back to the previous stored revision once session history is empty, and restores toRevision', async () => {
    const { bridge, restore } = setup();
    await bridge.submit([createStudioCommandEnvelope('history.undo', {}, 4)]);
    expect(restore).toHaveBeenCalledWith(3);
    await bridge.submit([createStudioCommandEnvelope('history.undo', { toRevision: 2 }, 5)]);
    expect(restore).toHaveBeenLastCalledWith(2);
    const [bad] = await bridge.submit([createStudioCommandEnvelope('history.undo', { toRevision: 0 }, 6)]);
    expect(bad).toMatchObject({ status: 'rejected', reason: 'invalid' });
  });

  it('keeps a bounded history', () => {
    const history = createStudioGraphHistory(2);
    history.record('a', 'b');
    history.record('b', 'c');
    history.record('c', 'd');
    expect(history.depth).toEqual({ undo: 2, redo: 0 });
    expect(history.undo('d')).toBe('c');
    expect(history.undo('c')).toBe('b');
    expect(history.undo('b')).toBeNull();
  });

  it('refuses a command when there is no graph yet or no engine', async () => {
    const history = createStudioGraphHistory();
    const noGraph = createStudioBridge({
      context: () => context(),
      handlers: createStudioEngineCommandHandlers({
        graph: () => null,
        revision: () => 4,
        assets: () => [],
        stage: vi.fn(),
        restore: vi.fn(),
        engine: async () => null,
        history,
      }),
    });
    const [result] = await noGraph.submit([createStudioCommandEnvelope('track.add', { kind: 'video' }, 4)]);
    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid' });
  });
});
