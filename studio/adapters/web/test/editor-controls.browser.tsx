/** Production Compose and Animate components, stores and history; no backend substitute. */
import { useEffect, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { i18n, i18nReady } from "@/i18n";
import { CompositingTimeline } from "@/features/editor/components/compose-workspace/compositing-timeline";
import { KeyframeGraphPanel } from "@/features/timeline/components/keyframe-graph-panel";
import { Timeline } from "@/features/timeline/components/timeline";
import { useSettingsStore } from "@/features/timeline/deps/settings";
import {
  getEditorLayout,
  getEditorLayoutCssVars,
} from "@/config/editor-layout";
import { useEditingShortcuts } from "@/features/timeline/hooks/shortcuts/use-editing-shortcuts";
import { useUIShortcuts } from "@/features/timeline/hooks/shortcuts/use-ui-shortcuts";
import { useSlipEditPreviewStore } from "@/features/timeline/stores/slip-edit-preview-store";
import { useLinkedEditPreviewStore } from "@/features/timeline/stores/linked-edit-preview-store";
import { useItemsStore } from "@/features/timeline/stores/items-store";
import { useCompositionsStore } from "@/features/timeline/stores/compositions-store";
import { useCompositionNavigationStore } from "@/features/timeline/stores/composition-navigation-store";
import { useTimelineCommandStore } from "@/features/timeline/stores/timeline-command-store";
import { useKeyframesStore } from "@/features/timeline/stores/keyframes-store";
import { useSelectionStore } from "@/shared/state/selection";
import { useEditorStore } from "@/shared/state/editor";
import {
  buildTimelineFromStores,
  loadTimeline,
  saveTimeline,
} from "@/features/timeline/stores/timeline-persistence";
import { createProject, getProject } from "@/infrastructure/storage";
import { setWorkspaceRoot } from "@/infrastructure/storage/workspace-fs/root";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { CURRENT_SCHEMA_VERSION } from "@/shared/projects/migrations";
import { installTimelineTouchEditing } from "../src/timeline-touch";
import "../src/editor.css";
import { usePlaybackStore } from "@/shared/state/playback";
import {
  makeTimelineTrack,
  makeTimelineVideoItem,
  makeTimelineAudioItem,
  resetTimelineCompositionTestState,
} from "@/features/timeline/test-helpers";
import { renderItem } from "@/features/export/utils/canvas-item-renderer/render-item";
import { getAnimatedTransform } from "@/features/export/utils/canvas-keyframes";
import {
  CanvasPool,
  TextMeasurementCache,
} from "@/features/export/utils/canvas-pool";
import { LottieExportProvider } from "@/infrastructure/lottie/lottie-frame-provider";
import type { TimelineItem } from "@/types/timeline";
import type { ItemRenderContext } from "@/features/export/utils/canvas-item-renderer/types";
import "./keyframe-browser.css";

await i18nReady;
await i18n.changeLanguage("en");
const root = createRoot(document.getElementById("editor")!);
const settings = { width: 128, height: 96, fps: 30 };
const hero: TimelineItem = {
  id: "hero",
  type: "shape",
  trackId: "hero-track",
  label: "Hero rectangle",
  from: 0,
  durationInFrames: 60,
  shapeType: "rectangle",
  fillColor: "#ff0000",
  strokeEnabled: false,
  transform: { x: 0, y: 0, width: 16, height: 16, rotation: 0, opacity: 1 },
};
const controller: TimelineItem = {
  id: "null",
  type: "controller",
  controllerKind: "null",
  trackId: "null-track",
  label: "Null Object",
  from: 0,
  durationInFrames: 60,
  transform: { x: 0, y: 0, width: 16, height: 16, rotation: 0, opacity: 1 },
};
const group: TimelineItem = {
  id: "group-instance",
  type: "composition",
  compositionId: "group-comp",
  trackId: "group-track",
  label: "Compose Group",
  from: 0,
  durationInFrames: 60,
  compositionWidth: 128,
  compositionHeight: 96,
  transform: { x: 0, y: 0, width: 128, height: 96, rotation: 0, opacity: 1 },
};

type Surface = "compose" | "animate" | "edit";
function mountEditorControls(surface: Surface, reset = false) {
  if (reset) {
    resetTimelineCompositionTestState();
    useCompositionNavigationStore.getState().resetToRoot();
    useEditorStore.getState().setWorkspace("motion");
    const items = [
      structuredClone(hero),
      structuredClone(controller),
      structuredClone(group),
    ];
    const tracks = items.map((item, order) =>
      makeTimelineTrack({
        id: item.trackId,
        name: item.label,
        kind: "video",
        order,
      }),
    );
    useCompositionsStore.getState().addComposition({
      id: "group-comp",
      name: "Compose Group",
      editorKind: "composite-2d",
      tracks: [],
      items: [],
      transitions: [],
      keyframes: [],
      ...settings,
      durationInFrames: 60,
    });
    useCompositionsStore.getState().addComposition({
      id: "main-comp",
      name: "Acceptance scene",
      editorKind: "composite-2d",
      tracks,
      items,
      transitions: [],
      keyframes: [],
      ...settings,
      durationInFrames: 60,
    });
    useCompositionNavigationStore.getState().switchToSequence("main-comp");
    useSelectionStore.getState().selectItems(["hero"]);
    usePlaybackStore.getState().setCurrentFrame(0);
    useTimelineCommandStore.getState().clearHistory();
  }
  flushSync(() => root.render(<Controls surface={surface} />));
}
let timelineTouchReady = false;
let disposeTimelineTouchForControl: (() => void) | undefined;
function NativeEditTimeline() {
  useEditingShortcuts({});
  useEffect(() => {
    const dispose = installTimelineTouchEditing();
    disposeTimelineTouchForControl = dispose;
    timelineTouchReady = true;
    return () => {
      timelineTouchReady = false;
      disposeTimelineTouchForControl = undefined;
      dispose();
    };
  }, []);
  const duration = useProjectStore(
    (state) => state.currentProject?.duration ?? 3,
  );
  return <Timeline duration={duration} />;
}
function Controls({ surface }: { surface: Surface }) {
  useUIShortcuts({});
  const density = useSettingsStore((settings) => settings.editorDensity);
  // The Edit timeline docks the keyframe panel on its own scroll axis (linked Edit axis). The
  // editor shell publishes its layout as CSS variables (editor.tsx); the timeline needs the same.
  if (surface === "edit") {
    return (
      <div
        className="flex h-full flex-col"
        style={
          getEditorLayoutCssVars(getEditorLayout(density)) as CSSProperties
        }
      >
        <NativeEditTimeline />
      </div>
    );
  }
  return surface === "compose" ? (
    <CompositingTimeline defaults={settings} />
  ) : (
    <KeyframeGraphPanel
      isOpen
      onClose={() => {}}
      splitView
      showCloseButton={false}
    />
  );
}
const state = () =>
  structuredClone({
    items: useItemsStore.getState().items,
    tracks: useItemsStore.getState().tracks,
    keys: useKeyframesStore.getState().keyframes,
    selectedItemIds: useSelectionStore.getState().selectedItemIds,
    linkedSelectionEnabled: useEditorStore.getState().linkedSelectionEnabled,
    undoCount: useTimelineCommandStore.getState().undoStack.length,
    canUndo: useTimelineCommandStore.getState().canUndo,
    canRedo: useTimelineCommandStore.getState().canRedo,
    mode: localStorage.getItem("timeline:keyframeEditorMode"),
  });
async function renderHero(frame = 0, expectedX?: number) {
  const items = useItemsStore.getState().itemById,
    keys = useKeyframesStore.getState().keyframes;
  const keyframesMap = new Map(keys.map((entry) => [entry.itemId, entry]));
  const canvasSettings = {
    ...settings,
    getExpressionItem: (id: string) => items[id],
    getExpressionKeyframes: (id: string) => keyframesMap.get(id),
  };
  const canvas = new OffscreenCanvas(settings.width, settings.height),
    ctx = canvas.getContext("2d")!;
  const item = items.hero!,
    pose = getAnimatedTransform(
      item,
      keyframesMap.get(item.id),
      frame,
      canvasSettings,
    );
  const rctx: ItemRenderContext = {
    fps: 30,
    canvasSettings,
    canvasPool: new CanvasPool(128, 96, 2),
    textMeasureCache: new TextMeasurementCache(),
    renderMode: "export",
    renderItem,
    videoExtractors: new Map(),
    videoElements: new Map(),
    useMediabunny: new Set(),
    mediabunnyDisabledItems: new Set(),
    mediabunnyFailureCountByItem: new Map(),
    imageElements: new Map(),
    gifFramesMap: new Map(),
    lottieProvider: new LottieExportProvider(),
    keyframesMap,
    adjustmentLayers: [],
    subCompRenderData: new Map(),
  };
  await renderItem(ctx, item, pose, frame, rctx);
  const pixels = ctx.getImageData(0, 0, 128, 96).data;
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", pixels)),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  const oracle = new OffscreenCanvas(128, 96),
    reference = oracle.getContext("2d")!;
  reference.fillStyle = "#ff0000";
  reference.fillRect(
    64 + (expectedX ?? pose.x) - 8,
    48 + (expectedX === undefined ? pose.y : 0) - 8,
    16,
    16,
  );
  const expected = reference.getImageData(0, 0, 128, 96).data;
  let maxDelta = 0;
  for (let i = 0; i < pixels.length; i++)
    maxDelta = Math.max(maxDelta, Math.abs(pixels[i]! - expected[i]!));
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const png = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
  return { pose, digest, maxDelta, png };
}
Object.assign(window, {
  fl100Editor: {
    touchReady: () => timelineTouchReady,
    // Negative controls retire the real route or corrupt only an existing retained snapshot.
    disableTouchForControl: () => {
      if (!disposeTimelineTouchForControl)
        throw new Error("Touch hook is not installed");
      disposeTimelineTouchForControl();
    },
    corruptRetainedTouchHistoryForControl: () => {
      const history = useTimelineCommandStore.getState();
      if (history.undoStack.length !== 1 || history.redoStack.length !== 0)
        throw new Error("Expected exactly the retained touch move");
      const entry = history.undoStack[0]!;
      const beforeSnapshot = structuredClone(entry.beforeSnapshot);
      beforeSnapshot.items = beforeSnapshot.items.map((item) => ({
        ...item,
        from: item.from + 1,
      }));
      useTimelineCommandStore.setState({
        undoStack: [{ ...entry, beforeSnapshot }],
      });
    },
    // OPFS is an isolated browser-owned fixture, never a host project or selected directory.
    prepareTouchTimeline: async (projectId: string) => {
      const root = await navigator.storage.getDirectory();
      setWorkspaceRoot(
        await root.getDirectoryHandle(projectId, { create: true }),
      );
      resetTimelineCompositionTestState();
      useEditorStore.setState({
        workspace: "edit",
        linkedSelectionEnabled: true,
      });
      useItemsStore.getState().setTracks([
        makeTimelineTrack({
          id: "tablet-v",
          name: "V1",
          kind: "video",
          syncLock: true,
          order: 0,
        }),
        makeTimelineTrack({
          id: "tablet-a",
          name: "A1",
          kind: "audio",
          syncLock: true,
          order: 1,
        }),
      ]);
      const common = {
        from: 30,
        durationInFrames: 60,
        sourceStart: 12,
        sourceEnd: 60,
        sourceFps: 24,
        sourceDuration: 120,
        src: "",
        mediaId: undefined,
        linkedGroupId: "tablet-av",
        originId: "tablet-source",
      };
      useItemsStore.getState().setItems([
        makeTimelineVideoItem({
          ...common,
          id: "tablet-v",
          trackId: "tablet-v",
        }),
        makeTimelineAudioItem({
          ...common,
          id: "tablet-a",
          trackId: "tablet-a",
        }),
      ]);
      useSelectionStore.getState().clearSelection();
      useTimelineCommandStore.getState().clearHistory();
      const project = await createProject({
        id: projectId,
        name: "FL94 isolated touch fixture",
        description:
          "Linked A/V graph; no media decoding or host/API qualification",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        duration: 3,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        metadata: settings,
        timeline: buildTimelineFromStores(),
      });
      useProjectStore.getState().setCurrentProject(project);
      document.getElementById("editor")!.style.width = "100%";
      mountEditorControls("edit");
    },
    // Arrangement only: Slip tool choice, drag, cancellation and history use native input.
    prepareSlipTimeline: async (projectId: string, lockedCompanion = false) => {
      const root = await navigator.storage.getDirectory();
      setWorkspaceRoot(
        await root.getDirectoryHandle(projectId, { create: true }),
      );
      resetTimelineCompositionTestState();
      useEditorStore.setState({
        workspace: "edit",
        linkedSelectionEnabled: true,
      });
      useItemsStore.getState().setTracks([
        makeTimelineTrack({
          id: "slip-v",
          name: "V1",
          kind: "video",
          syncLock: true,
          order: 0,
        }),
        makeTimelineTrack({
          id: "slip-a",
          name: "A1",
          kind: "audio",
          syncLock: true,
          locked: lockedCompanion,
          order: 1,
        }),
        makeTimelineTrack({
          id: "slip-other",
          name: "Unrelated",
          kind: "video",
          syncLock: true,
          order: 2,
        }),
      ]);
      const common = {
        src: "",
        sourceFps: 30,
        sourceDuration: 240,
        originId: "slip-source",
      };
      useItemsStore.getState().setItems([
        ...["A", "B"].flatMap((part) => {
          const range =
            part === "A"
              ? {
                  from: 0,
                  durationInFrames: 120,
                  sourceStart: 0,
                  sourceEnd: 120,
                }
              : {
                  from: 120,
                  durationInFrames: 210,
                  sourceStart: 30,
                  sourceEnd: 240,
                };
          return [
            makeTimelineVideoItem({
              ...common,
              ...range,
              id: `slip-v-${part}`,
              trackId: "slip-v",
              linkedGroupId: `slip-${part}`,
            }),
            makeTimelineAudioItem({
              ...common,
              ...range,
              id: `slip-a-${part}`,
              trackId: "slip-a",
              linkedGroupId: `slip-${part}`,
            }),
          ];
        }),
        makeTimelineVideoItem({
          ...common,
          id: "slip-unrelated",
          trackId: "slip-other",
          originId: "other-source",
          from: 15,
          durationInFrames: 45,
          sourceStart: 15,
          sourceEnd: 60,
        }),
      ]);
      useSelectionStore.getState().clearSelection();
      useTimelineCommandStore.getState().clearHistory();
      const project = await createProject({
        id: projectId,
        name: "FL94 isolated linked Slip fixture",
        description:
          "30fps source-range oracle; no media decoding or host/API qualification",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        duration: 11,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        metadata: settings,
        timeline: buildTimelineFromStores(),
      });
      useProjectStore.getState().setCurrentProject(project);
      document.getElementById("editor")!.style.width = "100%";
      mountEditorControls("edit");
    },
    // Read-only evidence that the second gesture reached a real source-range preview.
    slipPreview: () =>
      structuredClone({
        itemId: useSlipEditPreviewStore.getState().itemId,
        slipDelta: useSlipEditPreviewStore.getState().slipDelta,
        linkedUpdates: useLinkedEditPreviewStore.getState().updatesById,
      }),
    saveTouchTimeline: async (projectId: string) => {
      await saveTimeline(projectId);
      return (await getProject(projectId))?.timeline;
    },
    reopenTouchTimeline: async (projectId: string) => {
      const root = await navigator.storage.getDirectory();
      setWorkspaceRoot(await root.getDirectoryHandle(projectId));
      resetTimelineCompositionTestState();
      const project = await getProject(projectId);
      if (!project) throw new Error("Touch fixture project disappeared");
      useProjectStore.getState().setCurrentProject(project);
      await loadTimeline(projectId);
      useEditorStore.setState({
        workspace: "edit",
        linkedSelectionEnabled: true,
      });
      document.getElementById("editor")!.style.width = "100%";
      mountEditorControls("edit");
    },
    disposeTouchTimeline: async (projectId: string) => {
      if (!/^fl94-touch-[a-f0-9-]{36}$/.test(projectId))
        throw new Error("Refusing to remove a non-fixture OPFS entry");
      setWorkspaceRoot(null);
      useProjectStore.getState().setCurrentProject(null);
      await (
        await navigator.storage.getDirectory()
      ).removeEntry(projectId, { recursive: true });
    },
    // Arrangement only: all selection/join/history input is sent through native controls.
    seedLinkedChain: (legacy = false) => {
      resetTimelineCompositionTestState();
      useEditorStore.setState({
        workspace: "edit",
        linkedSelectionEnabled: true,
      });
      useItemsStore.getState().setTracks([
        makeTimelineTrack({
          id: "chain-v",
          name: "V1",
          kind: "video",
          order: 0,
        }),
        makeTimelineTrack({
          id: "chain-a",
          name: "A1",
          kind: "audio",
          order: 1,
        }),
      ]);
      useItemsStore.getState().setItems(
        Array.from({ length: 3 }, (_, index) => [
          makeTimelineVideoItem({
            id: `chain-v-${index}`,
            trackId: "chain-v",
            src: "",
            from: index * 30,
            durationInFrames: 30,
            sourceStart: index * 24,
            sourceEnd: (index + 1) * 24,
            sourceFps: 24,
            linkedGroupId: legacy ? undefined : `chain-g-${index}`,
            originId: "native-linked-source",
          }),
          makeTimelineAudioItem({
            id: `chain-a-${index}`,
            trackId: "chain-a",
            src: "",
            from: index * 30,
            durationInFrames: 30,
            sourceStart: index * 24,
            sourceEnd: (index + 1) * 24,
            sourceFps: 24,
            linkedGroupId: legacy ? undefined : `chain-g-${index}`,
            originId: "native-linked-source",
          }),
        ]).flat(),
      );
      useSelectionStore.getState().clearSelection();
      useTimelineCommandStore.getState().clearHistory();
      mountEditorControls("edit");
    },
    mount: mountEditorControls,
    state,
    renderHero,
    timeline: () => structuredClone(buildTimelineFromStores()),
    // Arrangement only; runners never use this to mutate a keyframe after native input.
    setPlayhead: (frame: number) =>
      usePlaybackStore.getState().setCurrentFrame(frame),
    prepareAutoKey: () => {
      const keys = useKeyframesStore.getState().keyframes;
      useKeyframesStore.getState().setKeyframes(
        keys.map((entry) => ({
          ...entry,
          properties: [
            {
              property: "opacity",
              keyframes: [
                { id: "opacity-k0", frame: 0, value: 1, easing: "linear" },
              ],
            },
          ],
        })),
      );
      usePlaybackStore.getState().setCurrentFrame(15);
      useTimelineCommandStore.getState().clearHistory();
    },
    // Fixture setup only. Subsequent interpolation and undo/redo use native production controls.
    seedEasing: (surface: Surface = "animate") => {
      mountEditorControls("compose", true);
      useKeyframesStore.getState().setKeyframes([
        {
          itemId: "hero",
          animationVersion: 2,
          properties: [],
          vectorProperties: [
            {
              property: "position",
              keyframes: [
                {
                  id: "k0",
                  frame: 0,
                  value: { x: -24, y: 0 },
                  easing: "linear",
                },
                {
                  id: "k30",
                  frame: 30,
                  value: { x: 24, y: 0 },
                  easing: "linear",
                },
              ],
            },
          ],
        },
      ]);
      mountEditorControls(surface);
    },
    moveParent: (id: string, x: number) =>
      useItemsStore.getState()._updateItemTransform(id, { x }),
    selectLayers: () =>
      useSelectionStore.getState().selectItems(["hero", "null"]),
  },
});
mountEditorControls("compose", true);
