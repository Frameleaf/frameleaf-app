/** Reuse the actual editor fixture. No replacement controls or pointer handlers. */
import "./editor-controls.browser";
import { useKeyframeSelectionStore } from "@/features/timeline/stores/keyframe-selection-store";

const editor = (
  window as unknown as {
    fl100Editor: {
      seedEasing: () => void;
      timeline: () => unknown;
      state: () => { canUndo: boolean; canRedo: boolean };
    };
  }
).fl100Editor;

Object.assign(window, {
  fl100Boundary: {
    // Arrangement only, before native input. Never call this to retime or undo.
    prepare: (width = 1200) => {
      document.getElementById("editor")!.style.width = `${width}px`;
      editor.seedEasing();
      useKeyframeSelectionStore.getState().clearSelection();
    },
    snapshot: () =>
      structuredClone({
        graph: editor.timeline(),
        selection: useKeyframeSelectionStore.getState().selectedKeyframes,
        history: {
          canUndo: editor.state().canUndo,
          canRedo: editor.state().canRedo,
        },
      }),
  },
});
