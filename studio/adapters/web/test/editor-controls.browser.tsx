/** Production Compose and Animate components, stores and history; no backend substitute. */
import { useEffect, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { i18n, i18nReady } from "@/i18n";
import { CompositingTimeline } from "@/features/editor/components/compose-workspace/compositing-timeline";
import { PreviewArea } from "@/features/editor/components/preview-area";
import { KeyframeGraphPanel } from "@/features/timeline/components/keyframe-graph-panel";
import { Timeline } from "@/features/timeline/components/timeline";
import { useSettingsStore } from "@/features/timeline/deps/settings";
import { getEditorLayout, getEditorLayoutCssVars } from "@/config/editor-layout";
import { useEditingShortcuts } from "@/features/timeline/hooks/shortcuts/use-editing-shortcuts";
import { useUIShortcuts } from "@/features/timeline/hooks/shortcuts/use-ui-shortcuts";
import { useRollingEditPreviewStore } from "@/features/timeline/stores/rolling-edit-preview-store";
import { useTimelineSettingsStore } from "@/features/timeline/stores/timeline-settings-store";
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
import { CanvasPool, TextMeasurementCache } from "@/features/export/utils/canvas-pool";
import { LottieExportProvider } from "@/infrastructure/lottie/lottie-frame-provider";
import type { TimelineItem } from "@/types/timeline";
import type { ItemRenderContext } from "@/features/export/utils/canvas-item-renderer/types";
import { int16StereoToWavBlob } from "@/runtime/composition-runtime/utils/audio-buffer-wav";
import { peekSharedPreviewAudioContext } from "@/runtime/composition-runtime/utils/preview-audio-graph";
import type { MasterAudioEpoch } from "@/shared/utils/master-audio-epoch";
import { buildRenderJob } from "@/features/export/utils/build-render-job";
import { convertTimelineToComposition } from "@/features/export/utils/timeline-to-composition";
import {
  processAudio,
  processAudioWindows,
  getAudioPacketPassthroughPlan,
} from "@/features/export/utils/canvas-audio";
import type { RenderJob } from "@/features/export/stores/render-queue-store";
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

type Surface = "compose" | "animate" | "edit" | "monitor";
function mountEditorControls(surface: Surface, reset = false) {
  if (reset) {
    resetTimelineCompositionTestState();
    useCompositionNavigationStore.getState().resetToRoot();
    useEditorStore.getState().setWorkspace("motion");
    const items = [structuredClone(hero), structuredClone(controller), structuredClone(group)];
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
  const duration = useProjectStore((state) => state.currentProject?.duration ?? 3);
  return <Timeline duration={duration} />;
}
function Controls({ surface }: { surface: Surface }) {
  useUIShortcuts({});
  const density = useSettingsStore((settings) => settings.editorDensity);
  if (surface === "monitor") {
    return (
      <PreviewArea project={settings} durationInFrames={90} preferProjectStoreMetadata={false} />
    );
  }
  // The Edit timeline docks the keyframe panel on its own scroll axis (linked Edit axis). The
  // editor shell publishes its layout as CSS variables (editor.tsx); the timeline needs the same.
  if (surface === "edit") {
    return (
      <div
        className="flex h-full flex-col"
        style={getEditorLayoutCssVars(getEditorLayout(density)) as CSSProperties}
      >
        <NativeEditTimeline />
      </div>
    );
  }
  return surface === "compose" ? (
    <CompositingTimeline defaults={settings} />
  ) : (
    <KeyframeGraphPanel isOpen onClose={() => {}} splitView showCloseButton={false} />
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
    pose = getAnimatedTransform(item, keyframesMap.get(item.id), frame, canvasSettings);
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
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", pixels))]
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

/** Observe real root PCM/ACKs; the native processor, transport and destination stay intact. */
function observeNativeMaster() {
  const connect = AudioNode.prototype.connect,
    post = MessagePort.prototype.postMessage;
  const destinations = new Set<AudioNode>();
  const gates = new Map<MessagePort, GainNode>();
  const taps = new Map<
    MessagePort,
    { gate: GainNode; analyser: AnalyserNode; drain: GainNode; connected: boolean }
  >();
  const listeners = new Map<MessagePort, (event: MessageEvent) => void>();
  const epochs: Array<{ port: MessagePort; epoch: MasterAudioEpoch; forwarded: MasterAudioEpoch }> =
    [];
  const acks: Array<{ rootId: string; contextId: string; generation: number; accepted: boolean }> =
    [];
  let replayNext = false,
    staleGeneration: number | undefined;
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
    const result = Reflect.apply(connect, this, args),
      destination = args[0];
    if (destination instanceof AudioDestinationNode) destinations.add(this);
    if (this instanceof AudioWorkletNode && destination instanceof GainNode)
      gates.set(this.port, destination);
    return result;
  } as typeof connect;
  MessagePort.prototype.postMessage = function (
    this: MessagePort,
    message: unknown,
    ...args: unknown[]
  ) {
    const epoch = message as MasterAudioEpoch,
      gate = gates.get(this);
    if (
      gate &&
      destinations.has(gate) &&
      epoch &&
      Array.isArray(epoch.points) &&
      typeof epoch.gainDb === "number" &&
      typeof epoch.rootId === "string"
    ) {
      if (!taps.has(this)) {
        const analyser = gate.context.createAnalyser(),
          drain = gate.context.createGain();
        analyser.fftSize = 2048;
        drain.gain.value = 0;
        Reflect.apply(connect, gate, [analyser]);
        Reflect.apply(connect, analyser, [drain]);
        Reflect.apply(connect, drain, [gate.context.destination]);
        taps.set(this, { gate, analyser, drain, connected: true });
        const listener = (event: MessageEvent) => {
          const ack = event.data;
          if (
            ack?.rootId === epoch.rootId &&
            ack.contextId === epoch.contextId &&
            typeof ack.accepted === "boolean"
          )
            acks.push(structuredClone(ack));
        };
        this.addEventListener("message", listener);
        this.start();
        listeners.set(this, listener);
      }
      const previous = epochs.findLast((entry) => entry.port === this);
      const forwarded = replayNext && previous ? previous.epoch : epoch;
      replayNext = false;
      epochs.push({
        port: this,
        epoch: structuredClone(epoch),
        forwarded: structuredClone(forwarded),
      });
      return Reflect.apply(post, this, [forwarded, ...args]);
    }
    return Reflect.apply(post, this, [message, ...args]);
  } as typeof post;
  return {
    read: () => {
      const latest = epochs.at(-1),
        tap = latest && taps.get(latest.port);
      const samples = new Float32Array(tap?.analyser.fftSize ?? 0);
      tap?.analyser.getFloatTimeDomainData(samples);
      const contextTime = tap?.analyser.context.currentTime ?? 0;
      const epoch = latest?.epoch;
      const mean = samples.length
        ? samples.reduce((sum, value) => sum + value, 0) / samples.length
        : 0;
      const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
      const spread = samples.reduce((max, value) => Math.max(max, Math.abs(value - mean)), 0);
      return {
        epochCount: epochs.length,
        latest: latest && { epoch: latest.epoch, forwarded: latest.forwarded },
        acknowledged:
          !!epoch &&
          acks.some(
            (ack) =>
              ack.accepted &&
              ack.rootId === epoch.rootId &&
              ack.contextId === epoch.contextId &&
              ack.generation === epoch.generation,
          ),
        staleRejected:
          staleGeneration !== undefined &&
          acks.some((ack) => ack.generation === staleGeneration && !ack.accepted),
        nativeTap: !!tap?.connected,
        settled: !!epoch && contextTime - epoch.contextTime >= 0.08,
        transportFrame: epoch
          ? epoch.frame +
            (epoch.running
              ? ((contextTime - epoch.contextTime) * epoch.rate * epoch.num) / epoch.den
              : 0)
          : -1,
        mean,
        peak,
        spread,
      };
    },
    replayStale: () => {
      const latest = epochs.at(-1),
        stale =
          latest &&
          epochs.find(
            (entry) =>
              entry.port === latest.port && entry.epoch.generation < latest.epoch.generation,
          );
      if (!latest || !stale) throw new Error("A real older root epoch is required");
      staleGeneration = stale.epoch.generation;
      Reflect.apply(post, latest.port, [stale.epoch]);
    },
    replayNextForControl: () => {
      replayNext = true;
    },
    disconnectTapForControl: () => {
      const latest = epochs.at(-1),
        tap = latest && taps.get(latest.port);
      if (!tap) throw new Error("Native root output tap is required");
      tap.gate.disconnect(tap.analyser);
      tap.connected = false;
    },
    dispose: () => {
      AudioNode.prototype.connect = connect;
      MessagePort.prototype.postMessage = post;
      for (const [port, listener] of listeners) port.removeEventListener("message", listener);
      for (const tap of taps.values()) {
        if (tap.connected) tap.gate.disconnect(tap.analyser);
        tap.analyser.disconnect();
        tap.drain.disconnect();
      }
    },
  };
}
let masterObservation: ReturnType<typeof observeNativeMaster> | undefined;
let monitorProjectId: string | undefined;
const capturedMonitorJobs = new Map<string, RenderJob>();
const monitorMaster = {
  masterBusDb: -6,
  masterBusMuted: false,
  masterGainEnvelope: [
    { id: "a", frame: 0, gainDb: -20 },
    { id: "b", frame: 29, gainDb: -20 },
    { id: "c", frame: 30, gainDb: 0 },
    { id: "d", frame: 89, gainDb: 0 },
  ],
};
Object.assign(window, {
  fl98Monitor: {
    wavBytes: async () => {
      const plane = new Int16Array(144000).fill(4096);
      return Array.from(
        new Uint8Array(await int16StereoToWavBlob(plane, plane, 48000).arrayBuffer()),
      );
    },
    open: async (projectId: string, src: string, reopen = false) => {
      if (
        !/^fl98-monitor-[a-f0-9-]{36}$/.test(projectId) ||
        new URL(src).origin !== location.origin ||
        new URL(src).pathname !== "/__fl98__/constant.wav"
      )
        throw new Error("Isolated same-origin monitor fixture required");
      monitorProjectId = projectId;
      const directory = await navigator.storage.getDirectory();
      setWorkspaceRoot(await directory.getDirectoryHandle(projectId, { create: !reopen }));
      resetTimelineCompositionTestState();
      useEditorStore.setState({ workspace: "edit" });
      if (reopen) {
        const project = await getProject(projectId);
        if (!project) throw new Error("Saved monitor project is missing");
        useProjectStore.getState().setCurrentProject(project);
        await loadTimeline(projectId);
      } else {
        usePlaybackStore.setState({ volume: 1, muted: false, currentFrame: 0, isPlaying: false });
        usePlaybackStore.getState().setMasterAudio(structuredClone(monitorMaster));
        useItemsStore.getState().setTracks([
          makeTimelineTrack({
            id: "monitor-a",
            name: "Synthetic audio",
            kind: "audio",
            order: 0,
          }),
        ]);
        useItemsStore.getState().setItems([
          makeTimelineAudioItem({
            id: "monitor-source",
            trackId: "monitor-a",
            src,
            mediaId: undefined,
            from: 0,
            durationInFrames: 90,
            sourceStart: 0,
            sourceEnd: 90,
            sourceDuration: 90,
            sourceFps: 30,
            volume: 0,
            audioFadeIn: 0,
            audioFadeOut: 0,
          }),
        ]);
        const project = await createProject({
          id: projectId,
          name: "FL98 local monitor qualification",
          description: "Synthetic PCM; local OPFS only",
          createdAt: 1,
          updatedAt: 1,
          duration: 3,
          schemaVersion: CURRENT_SCHEMA_VERSION,
          metadata: settings,
          timeline: buildTimelineFromStores(),
        });
        useProjectStore.getState().setCurrentProject(project);
        await loadTimeline(projectId);
      }
      masterObservation = observeNativeMaster();
      document.getElementById("editor")!.style.width = "100%";
      mountEditorControls("monitor");
    },
    state: () => {
      const {
        volume,
        muted,
        currentFrame,
        isPlaying,
        masterBusDb,
        masterBusMuted,
        masterGainEnvelope,
      } = usePlaybackStore.getState();
      return structuredClone({
        volume,
        muted,
        currentFrame,
        isPlaying,
        masterBusDb,
        masterBusMuted,
        masterGainEnvelope,
      });
    },
    observation: () => masterObservation?.read(),
    replayStale: () => masterObservation!.replayStale(),
    replayNextForControl: () => masterObservation!.replayNextForControl(),
    disconnectTapForControl: () => masterObservation!.disconnectTapForControl(),
    capture: async () => {
      const job = await buildRenderJob({
        settings: {
          mode: "audio",
          audioContainer: "wav",
          codec: "h264",
          quality: "high",
          resolution: { width: 128, height: 96 },
          subtitleMode: "off",
          smartCopy: false,
        },
      });
      capturedMonitorJobs.set(job.id, job);
      return { id: job.id, snapshot: structuredClone(job.snapshot) };
    },
    renderCaptured: async (id: string, control?: string) => {
      const job = capturedMonitorJobs.get(id);
      if (!job) throw new Error("Captured local job is missing");
      if (control === "mutate-capture") job.snapshot.masterGainEnvelope![0]!.gainDb = 12;
      const s = job.snapshot;
      const composition = convertTimelineToComposition(
        s.tracks,
        s.items,
        s.transitions,
        s.fps,
        s.width,
        s.height,
        job.inPoint,
        job.outPoint,
        s.keyframes,
        s.backgroundColor,
        s.busAudioEq,
        s.masterBusDb,
        s.masterBusMuted,
        s.masterGainEnvelope,
      );
      if (control === "monitor-leak") {
        const device = usePlaybackStore.getState();
        composition.masterBusMuted = device.muted;
        composition.masterGainEnvelope = composition.masterGainEnvelope!.map((point) => ({
          ...point,
          gainDb: point.gainDb + 20 * Math.log10(device.volume),
        }));
      }
      const full = await processAudio(composition);
      if (!full) throw new Error("Synthetic source produced no PCM");
      const windows: { samples: Float32Array[]; sampleRate: number; channels: number }[] = [];
      for await (const window of processAudioWindows(composition)) windows.push(window);
      const planes = full.samples.map((_, channel) => {
        const plane = new Float32Array(
          windows.reduce((length, window) => length + window.samples[channel]!.length, 0),
        );
        let offset = 0;
        for (const window of windows) {
          plane.set(window.samples[channel]!, offset);
          offset += window.samples[channel]!.length;
        }
        return plane;
      });
      const digest = async (samples: Float32Array[]) => {
        const bytes = new Uint8Array(
          samples.reduce((length, plane) => length + plane.byteLength, 0),
        );
        let offset = 0;
        for (const plane of samples) {
          bytes.set(new Uint8Array(plane.buffer, plane.byteOffset, plane.byteLength), offset);
          offset += plane.byteLength;
        }
        return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
      };
      return {
        snapshot: structuredClone(s),
        channels: full.samples.length,
        frames: full.samples[0]!.length,
        sampleRate: full.sampleRate,
        probes: full.samples.map((plane) => [plane[24000], plane[72000]]),
        fullDigest: await digest(full.samples),
        windowDigest: await digest(planes),
        allZero:
          full.samples.every((plane) => plane.every((value) => value === 0)) &&
          planes.every((plane) => plane.every((value) => value === 0)),
        passthrough: getAudioPacketPassthroughPlan(composition) !== null,
      };
    },
    setProjectMute: (masterBusMuted: boolean) =>
      usePlaybackStore.getState().setMasterAudio({ masterBusMuted }),
    save: async () => {
      if (!monitorProjectId) throw new Error("Monitor project is not open");
      await saveTimeline(monitorProjectId);
      const { volume, muted } = usePlaybackStore.getState();
      return {
        device: { volume, muted },
        storage: JSON.parse(localStorage.getItem("playback-storage")!),
        timeline: (await getProject(monitorProjectId))!.timeline,
      };
    },
    dispose: async () => {
      masterObservation?.dispose();
      masterObservation = undefined;
      flushSync(() => root.render(null));
      capturedMonitorJobs.clear();
      const context = peekSharedPreviewAudioContext();
      if (context) await context.close();
      setWorkspaceRoot(null);
      useProjectStore.getState().setCurrentProject(null);
    },
  },
});
Object.assign(window, {
  fl100Editor: {
    touchReady: () => timelineTouchReady,
    // Negative controls retire the real route or corrupt only an existing retained snapshot.
    disableTouchForControl: () => {
      if (!disposeTimelineTouchForControl) throw new Error("Touch hook is not installed");
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
      setWorkspaceRoot(await root.getDirectoryHandle(projectId, { create: true }));
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
        description: "Linked A/V graph; no media decoding or host/API qualification",
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
      setWorkspaceRoot(await root.getDirectoryHandle(projectId, { create: true }));
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
        description: "30fps source-range oracle; no media decoding or host/API qualification",
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
    // Read-only Roll observations: no tool choice, graph mutation or history action.
    rollPreview: () => {
      const preview = useRollingEditPreviewStore.getState();
      return structuredClone({
        trimmedItemId: preview.trimmedItemId,
        neighborItemId: preview.neighborItemId,
        handle: preview.handle,
        neighborDelta: preview.neighborDelta,
        linkedUpdates: useLinkedEditPreviewStore.getState().updatesById,
      });
    },
    historySnapshot: () => {
      const history = useTimelineCommandStore.getState();
      return structuredClone({
        undo: history.undoStack,
        redo: history.redoStack,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        dirty: useTimelineSettingsStore.getState().isDirty,
      });
    },
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
      await (await navigator.storage.getDirectory()).removeEntry(projectId, { recursive: true });
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
    setPlayhead: (frame: number) => usePlaybackStore.getState().setCurrentFrame(frame),
    prepareAutoKey: () => {
      const keys = useKeyframesStore.getState().keyframes;
      useKeyframesStore.getState().setKeyframes(
        keys.map((entry) => ({
          ...entry,
          properties: [
            {
              property: "opacity",
              keyframes: [{ id: "opacity-k0", frame: 0, value: 1, easing: "linear" }],
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
    moveParent: (id: string, x: number) => useItemsStore.getState()._updateItemTransform(id, { x }),
    selectLayers: () => useSelectionStore.getState().selectItems(["hero", "null"]),
  },
});
mountEditorControls("compose", true);
