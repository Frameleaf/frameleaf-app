/** Production Edit timeline and its docked keyframe panel. No replacement axis, scroll or pointer code. */
import "./editor-controls.browser";
import { useKeyframeSelectionStore } from "@/features/timeline/stores/keyframe-selection-store";
import { useZoomStore } from "@/features/timeline/stores/zoom-store";
import { useSelectionStore } from "@/shared/state/selection";
import { useEditorStore } from "@/shared/state/editor";

const editor = (
  window as unknown as {
    fl100Editor: {
      seedEasing: (surface: "edit") => void;
      timeline: () => unknown;
      state: () => { canUndo: boolean; canRedo: boolean };
    };
  }
).fl100Editor;

const mainScroller = () =>
  document.querySelector<HTMLElement>("[data-timeline-scroll-container]")!;

Object.assign(window, {
  fl100Linked: {
    // Arrangement only, before native input: the seeded scene in the Edit timeline with the
    // keyframe panel closed. The runner opens the panel, pans and zooms with the native controls.
    prepare: (width = 1200) => {
      document.getElementById("editor")!.style.width = `${width}px`;
      useSelectionStore.getState().setEditKeyframePanelOpen(false);
      editor.seedEasing("edit");
      useEditorStore.getState().setWorkspace("edit");
      useSelectionStore.getState().selectItems(["hero"]);
      useKeyframeSelectionStore.getState().clearSelection();
    },
    // Arrangement only: the scroll position a native pan leaves on the production scroll surface.
    // The panel follows it through its own scroll listener, exactly as it follows a wheel pan.
    pan: (scrollLeft: number) => {
      mainScroller().scrollLeft = scrollLeft;
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
    // Read-only: the main timeline's own axis, measured on its own elements, so the expected
    // marker position never comes from the keyframe panel under test.
    mainAxis: () => {
      const scroller = mainScroller();
      const clip = document.querySelector<HTMLElement>(
        '[data-timeline-item][data-item-id="hero"]',
      )!;
      const box = (node: Element) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const zoom = useZoomStore.getState();
      return {
        scroller: box(scroller),
        scrollLeft: scroller.scrollLeft,
        clientWidth: scroller.clientWidth,
        heroClip: box(clip),
        heroFrames: 60,
        pixelsPerSecond: zoom.pixelsPerSecond,
        zoomSettled:
          !zoom.isZoomInteracting &&
          zoom.contentPixelsPerSecond === zoom.pixelsPerSecond,
      };
    },
  },
});
