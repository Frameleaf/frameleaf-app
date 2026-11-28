/**
 * Basic or Advanced (FL-1822). The host owns the header's switch and sends the choice in its
 * context; absent means Basic. Advanced shows the editor's advanced tools (Transform's fields,
 * colour scopes, the wheels and curves); Basic hides them, as in the approved Studio.
 */
import { useEditorStore } from '@/shared/state/editor';
import type { StudioHostContext } from '@frameleaf/host/host-contract';

export function applyStudioMode(
  context: Pick<StudioHostContext, 'mode'>,
): void {
  const advanced = context.mode === 'advanced';
  if (useEditorStore.getState().advancedTools !== advanced)
    useEditorStore.getState().setAdvancedTools(advanced);
}
