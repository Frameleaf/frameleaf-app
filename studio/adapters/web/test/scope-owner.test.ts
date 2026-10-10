import { afterEach, describe, expect, it } from 'vite-plus/test';
import { usePreviewBridgeStore } from '@/shared/state/preview-bridge';
import { beginMount, confirmEcho, loadFinished, type DraftSendState } from '../src/draft-sync';
import { publishScopeOwner, scopeTimelineContent } from '../src/scope-owner';

afterEach(() => usePreviewBridgeStore.setState({ scopeOwner: null }));

function state(): DraftSendState {
  return {
    hostContent: 'r3',
    mount: { generation: 0, projectId: 'p', revision: 3, graphVersion: 1, loaded: false },
    pendingSend: false,
    pendingSuperseded: false,
    disposed: false,
  };
}

describe('loaded scope revision authority', () => {
  it('keeps an edit during deferred echo reading separate from the confirmed stored baseline', async () => {
    const current = state()
    loadFinished(current, 'p', true)
    let content = JSON.stringify({ items: [{ label: 'stored' }] })
    publishScopeOwner(current, () => content)
    const stored = content
    let finish!: (value: string) => void
    const read = new Promise<string>((resolve) => { finish = resolve })
    const echo = read.then((baseline) => {
      confirmEcho(current, baseline, baseline, 4)
      publishScopeOwner(current, () => content, scopeTimelineContent(JSON.parse(baseline)))
    })
    content = JSON.stringify({ items: [{ label: 'new unsaved edit' }] })
    finish(stored)
    await echo
    expect(usePreviewBridgeStore.getState().scopeOwner?.baseRevision).toBe(4)
    expect(usePreviewBridgeStore.getState().scopeOwner?.hasLocalEdits()).toBe(true)
  })

  it('keeps failed and superseded loads unknown, then publishes only the actual loaded graph', () => {
    const current = state();
    let content = JSON.stringify({ items: [{ label: 'r3' }] });
    publishScopeOwner(current, () => content);
    expect(usePreviewBridgeStore.getState().scopeOwner).toBeNull();
    expect(loadFinished(current, 'p', false)).toBe('failed');
    publishScopeOwner(current, () => content);
    expect(usePreviewBridgeStore.getState().scopeOwner).toBeNull();
    const next = beginMount(current, 'p-m1', 4, 2);
    expect(loadFinished(current, 'p', true)).toBe('ignored');
    publishScopeOwner(current, () => content);
    expect(usePreviewBridgeStore.getState().scopeOwner).toBeNull();
    content = JSON.stringify({ items: [{ label: 'r4' }] });
    expect(loadFinished(current, next.projectId, true)).toBe('loaded');
    publishScopeOwner(current, () => content);
    const owner = usePreviewBridgeStore.getState().scopeOwner!;
    expect(owner).toMatchObject({ baseRevision: 4, mountGeneration: 1, projectId: 'p-m1' });
    expect(owner.hasLocalEdits()).toBe(false);
    content = JSON.stringify({ items: [{ label: 'unsaved edit' }] });
    expect(owner.hasLocalEdits()).toBe(true);
    confirmEcho(current, content, content, 5);
    publishScopeOwner(current, () => content);
    expect(usePreviewBridgeStore.getState().scopeOwner).toMatchObject({ baseRevision: 5 });
    expect(usePreviewBridgeStore.getState().scopeOwner?.hasLocalEdits()).toBe(false);
    current.disposed = true;
    publishScopeOwner(current, () => content);
    expect(usePreviewBridgeStore.getState().scopeOwner).toBeNull();
  });
});
