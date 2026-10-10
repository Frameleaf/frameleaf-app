import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const draftSync = ts.transpileModule(readFileSync('../studio/adapters/web/src/draft-sync.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const { sendEditorDraft } = new Function('exports', `${draftSync.outputText}\nreturn exports;`)({});

// Exercise the component closures with their real bodies and small dependency fakes.
const closure = (file: string, start: string, end: string, result: string, dependencies: Record<string, unknown>) => {
  const source = readFileSync(`src/lib/components/frameleaf/${file}.svelte`, 'utf8');
  const code = source.slice(
    source.indexOf(start),
    source.indexOf(end, source.indexOf(start)) + (end === '\n  };' ? end.length : 0),
  );
  const { outputText } = ts.transpileModule(`${code.replace(/^export /, '')}\nreturn ${result};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return new Function(...Object.keys(dependencies), outputText)(...Object.values(dependencies));
};
const deferred = () => {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>((done) => (resolve = done));
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

it.each(['LibraryView', 'ResultsView'])('%s discards a select-all count for an old query', async (file) => {
  const count = deferred();
  const session = { revision: 1, state: {}, dispatch: vi.fn(), applyTotal: vi.fn() };
  const select = closure(file, 'const selectAllMatching =', '\n  };', 'selectAllMatching', {
    session,
    bulk: { count: () => count.promise },
    loadedIds: () => ['a'],
    assets: [{ id: 'a' }],
  });
  const selecting = select();
  session.revision++;
  count.resolve(100);
  await selecting;
  expect(session.dispatch).not.toHaveBeenCalled();
  expect(session.applyTotal).not.toHaveBeenCalled();
});

it('LibraryView leaves shortcuts to an open modal', () => {
  const handler = closure('LibraryView', 'const handleKeyDown =', '\n  };', 'handleKeyDown', {
    document: { querySelector: () => ({}) },
    MODAL_SELECTOR: 'dialog',
  });
  expect(() => handler({ key: 'Escape' })).not.toThrow();
});

it('Library Care does not restart polling after destruction during a request', async () => {
  vi.useFakeTimers();
  const request = deferred();
  let destroy!: () => void;
  const state = closure('LibraryCareHealth', 'let destroyed =', '\n  const FINISHED:', '({ schedule })', {
    setTimeout,
    clearTimeout,
    active: true,
    jobs: new Set(),
    poll: () => request.promise,
    LIBRARY_CARE_POLL_MS: 10,
    onDestroy: (callback: () => void) => (destroy = callback),
  });
  state.schedule();
  await vi.advanceTimersByTimeAsync(10);
  destroy();
  request.resolve(1);
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});

it('reports a rejected bulk precondition', async () => {
  const error = new Error('precondition failed');
  const handleError = vi.fn();
  const run = closure('LibraryView', 'const runBulk =', '\n  };', 'runBulk', {
    beforeAction: () => Promise.reject(error),
    dispatchBulk: vi.fn(),
    handleError,
    $t: (key: string) => key,
  });
  run('delete');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(handleError).toHaveBeenCalledWith(error, expect.any(String));
});

it('runs the bulk precondition after the event that asked, and reports one that throws', async () => {
  const error = new Error('precondition threw');
  const handleError = vi.fn();
  const dispatchBulk = vi.fn();
  const beforeAction = vi.fn((id: string) => {
    if (id === 'delete') {
      throw error;
    }
    return true;
  });
  const run = closure('LibraryView', 'const runBulk =', '\n  };', 'runBulk', {
    beforeAction,
    dispatchBulk,
    handleError,
    $t: (key: string) => key,
  });

  run('archive');
  // Not inside the asking event: the gate has not been consulted when the call returns.
  expect(beforeAction).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(beforeAction).toHaveBeenCalledExactlyOnceWith('archive');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(dispatchBulk).toHaveBeenCalledExactlyOnceWith('archive', undefined);

  run('delete');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(handleError).toHaveBeenCalledWith(error, expect.any(String));
  expect(dispatchBulk).toHaveBeenCalledOnce();
});

it('reports a failed shift-click range and clears its pending state', async () => {
  const error = new Error('range failed');
  const handleError = vi.fn();
  const select = closure('LibraryTimeline', 'const selectRange =', '\n  };', 'selectRange', {
    anchorAsset: () => ({ id: 'a' }),
    session: { revision: 1 },
    rangePending: false,
    timelineManager: { retrieveRange: () => Promise.reject(error) },
    handleError,
    $t: (key: string) => key,
  });
  await select({ id: 'b' });
  expect(handleError).toHaveBeenCalledWith(error, expect.any(String));
});

const editorClosure = (name: string, end: string, dependencies: Record<string, unknown>) => {
  const source = readFileSync('../studio/adapters/web/src/editor-frame.tsx', 'utf8');
  const start = source.indexOf(`${name === 'revokeGenerated' ? 'async ' : ''}function ${name}(`);
  const code = source.slice(start, source.indexOf(end, start));
  const { outputText } = ts.transpileModule(`${code}\nreturn ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return new Function(...Object.keys(dependencies), outputText)(...Object.values(dependencies));
};

it('keeps the host dirty after Freecut saves while its draft send is pending', () => {
  let changed!: (settings: unknown, previous: unknown) => void;
  const post = vi.fn();
  const watch = editorClosure('watchDirty', '\nfunction onLoadFinished', {
    useTimelineSettingsStore: {
      subscribe: (callback: typeof changed) => {
        changed = callback;
        return () => {};
      },
    },
    post,
  });
  watch({ unsubscribe: [], writePending: true, pendingSend: false });
  changed({ isDirty: false }, { isDirty: true });
  expect(post).toHaveBeenLastCalledWith({ type: 'dirty', dirty: true });
});

it.each([false, true])('revocation stages a graph only with unsent edits (%s)', async (dirty) => {
  const call = vi.fn().mockResolvedValue({ status: 'staged' });
  const dispose = vi.fn();
  const revoke = editorClosure(
    'revokeGenerated',
    '\n/* ------------------------------------------------------------------ */',
    {
      session: {
        disposed: false,
        mount: { loaded: true, projectId: 'p', revision: 3, graphVersion: 0 },
        context: { project: { graph: {} } },
      },
      useProjectStore: { getState: () => ({ currentProject: null }) },
      useTimelineSettingsStore: { getState: () => ({ isDirty: dirty }) },
      storeGeneratedMedia: (graph: unknown) => graph,
      buildTimelineFromStores: () => ({}),
      dispose,
      call,
      post: vi.fn(),
    },
  );
  await revoke();
  expect(dispose).toHaveBeenCalledOnce();
  expect(call).toHaveBeenCalledTimes(dirty ? 1 : 0);
});

it('reports a refused revocation draft without rejecting the host message handler', async () => {
  const post = vi.fn();
  const revoke = editorClosure(
    'revokeGenerated',
    '\n/* ------------------------------------------------------------------ */',
    {
      session: { disposed: false, mount: { loaded: true }, context: { project: { graph: {} } } },
      useProjectStore: { getState: () => ({ currentProject: null }) },
      useTimelineSettingsStore: { getState: () => ({ isDirty: true }) },
      storeGeneratedMedia: (graph: unknown) => graph,
      buildTimelineFromStores: () => ({}),
      dispose: vi.fn(),
      call: vi.fn().mockRejectedValue(new Error('host unavailable')),
      post,
    },
  );
  await expect(revoke()).resolves.toBeUndefined();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'notify', tone: 'error' }));
});

it('clears the guard when a pending write already equals the host graph', async () => {
  const state = {
    hostContent: '{}',
    mount: { generation: 1, projectId: 'p', revision: 1, graphVersion: 0, loaded: true },
    pendingSend: false,
    pendingSuperseded: false,
    writePending: true,
    disposed: false,
  };
  const dirty = vi.fn();
  await sendEditorDraft(state, state.mount, {
    read: async () => '{}',
    contentOf: JSON.stringify,
    stage: vi.fn(),
    dirty,
  });
  expect(state.writePending).toBe(false);
  expect(dirty).toHaveBeenCalledWith(false);
});

it('keeps a newer write dirty when an earlier draft is acknowledged', async () => {
  const state = {
    hostContent: '{}',
    mount: { generation: 1, projectId: 'p', revision: 1, graphVersion: 0, loaded: true },
    pendingSend: false,
    pendingSuperseded: false,
    writePending: true,
    writeVersion: 1,
    disposed: false,
  };
  let acknowledge!: (result: { status: string }) => void;
  const dirty = vi.fn();
  const sending = sendEditorDraft(state, state.mount, {
    read: async () => '{"v":1}',
    contentOf: JSON.stringify,
    stage: () => new Promise((resolve) => (acknowledge = resolve)),
    dirty,
  });
  await Promise.resolve();
  state.writeVersion = 2;
  acknowledge({ status: 'staged' });
  await sending;
  expect(state.writePending).toBe(true);
  expect(dirty).toHaveBeenCalledWith(true);
});

it('Best Photos does not append overlapping or repeated page assets', async () => {
  const assets = [{ id: 'a' }];
  const load = closure(
    '../../../routes/(user)/best-photos/[[photos=photos]]/[[assetId=id]]/+page',
    'export const loadNextPage =',
    '\n  };',
    'loadNextPage',
    {
      page: 2,
      isLoading: false,
      total: 3,
      loadFailed: false,
      assets,
      getBestPhotos: async () => ({ items: [{ id: 'a' }, { id: 'b' }, { id: 'b' }], total: 2, nextPage: null }),
    },
  );
  await load();
  expect(assets.map(({ id }) => id)).toEqual(['a', 'b']);
});
