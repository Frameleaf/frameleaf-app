import { describe, expect, it } from 'vite-plus/test';
import { useEditorStore } from '@/shared/state/editor';
import { applyStudioMode } from '../src/studio-mode';

describe('Basic and Advanced (FL-1822)', () => {
  it("follows the host's mode, Basic when it sends none", () => {
    applyStudioMode({ mode: 'advanced' });
    expect(useEditorStore.getState().advancedTools).toBe(true);
    applyStudioMode({ mode: 'basic' });
    expect(useEditorStore.getState().advancedTools).toBe(false);
    applyStudioMode({ mode: 'advanced' });
    applyStudioMode({});
    expect(useEditorStore.getState().advancedTools).toBe(false);
  });
});
