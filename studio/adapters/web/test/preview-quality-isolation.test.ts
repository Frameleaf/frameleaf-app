import { createElement, useRef, useState } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Project } from '@/types/project'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { createProject, getProject } from '@/infrastructure/storage'
import { CURRENT_SCHEMA_VERSION } from '@/shared/projects/migrations/types'
import { loadTimeline, saveTimeline } from '@/features/timeline/stores/timeline-persistence'
import { usePlaybackStore, type PreviewQuality } from '@/shared/state/playback'
import type { StudioHostContext } from '@frameleaf/host/host-contract'
import { VirtualWorkspace } from '../src/virtual-workspace'
import { RemotePreview } from '../src/remote-preview'
import { ExportDialog } from '../src/shims/export-dialog'
import { post } from '../src/host-port'
import { usePreviewPlaybackController } from '@/features/preview/hooks/use-preview-playback-controller'
import {
  usePreviewCompositionBaseModel,
  usePreviewCompositionModel,
} from '@/features/preview/hooks/use-preview-composition-model'
import { usePreviewRuntimeRefs } from '@/features/preview/hooks/use-preview-runtime-refs'
import { usePreviewDiagnostics } from '@/features/preview/hooks/use-preview-diagnostics'
import {
  useItemsStore,
  useTimelineStore,
  useTransitionsStore,
} from '@/features/preview/deps/timeline-store'

vi.mock('../src/host-port', () => ({ post: vi.fn() }))

const colorManagement = {
  workingRange: 'hdr',
  referenceWhiteNits: 203,
  masteringPeakNits: 1000,
  sdrMonitoring: 'bt2390',
} as const

function useAdaptiveComposition() {
  const [adaptiveQualityCap, setAdaptiveQualityCap] = useState<PreviewQuality>(1)
  const refs = usePreviewRuntimeRefs()
  const renderSourceRef = useRef<'player'>('player')
  const { previewPerfRef } = usePreviewDiagnostics({ renderSourceRef })
  const ignorePlayerUpdatesRef = useRef(false)
  const itemsState = useItemsStore.getState()
  const keyframes = useTimelineStore.getState().keyframes
  const { combinedTracks } = usePreviewCompositionBaseModel({
    tracks: itemsState.tracks,
    itemsByTrackId: itemsState.itemsByTrackId,
    mediaById: {},
  })
  const composition = usePreviewCompositionModel({
    combinedTracks,
    fps: 30,
    items: itemsState.items,
    keyframes,
    transitions: useTransitionsStore.getState().transitions,
    resolvedUrls: new Map(),
    useProxy: false,
    proxyReadyCount: 0,
    blobUrlVersion: 0,
    project: { width: 1920, height: 1080, colorManagement },
    playerSize: { width: 1280, height: 720 },
    adaptiveQualityCap,
  })
  const controller = usePreviewPlaybackController({
    fps: 30,
    combinedTracks,
    keyframes,
    forceFastScrubOverlay: false,
    domTextScrubOverlayEnabled: false,
    previewPerfRef,
    isGizmoInteractingRef: refs.isGizmoInteractingRef,
    preferPlayerForDomGizmoRef: refs.preferPlayerForDomGizmoRef,
    preferPlayerForStyledTextScrubRef: refs.preferPlayerForStyledTextScrubRef,
    adaptiveQualityStateRef: refs.adaptiveQualityStateRef,
    adaptiveFrameSampleRef: refs.adaptiveFrameSampleRef,
    ignorePlayerUpdatesRef,
    resolvePendingSeekLatency: () => {},
    setAdaptiveQualityCap,
  })
  return { ...composition, ...controller, adaptiveQualityCap }
}

// jsdom's Blob predates `text()` and `arrayBuffer()`; browsers have both.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(this)
    })
  }
}
if (!Blob.prototype.text) {
  Blob.prototype.text = async function (this: Blob) {
    return new TextDecoder().decode(await this.arrayBuffer())
  }
}

vi.mock('@/infrastructure/storage/handles-db', () => ({
  getHandle: vi.fn(async () => undefined),
  saveHandle: vi.fn(async () => undefined),
  deleteHandle: vi.fn(async () => undefined),
}))

/**
 * FL-98: adaptive preview quality changes previews only. The editor's preview quality (the
 * person's setting, which Freecut's adaptive cap lowers further under load) lives in the playback
 * store; the stored graph (which the host exports and renders from) and the host's exact
 * server frames never carry it.
 */

const graph = (id: string): Project =>
  ({
    id,
    name: 'Quality',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    duration: 0,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    metadata: { width: 1920, height: 1080, fps: 30, colorManagement },
    timeline: {
      tracks: [
        {
          id: 'v1',
          name: 'V1',
          kind: 'video',
          height: 60,
          locked: false,
          visible: true,
          muted: false,
          solo: false,
          order: 0,
          items: [],
        },
      ],
      items: [
        {
          id: 'title',
          trackId: 'v1',
          type: 'text',
          from: 0,
          durationInFrames: 60,
          label: 'Title',
          text: 'Title',
          color: '#ffffff',
          transform: {
            x: 100,
            y: 40,
            width: 320,
            height: 180,
            anchorX: 160,
            anchorY: 90,
            rotation: 15,
            opacity: 0.8,
          },
          crop: { left: 0.1, right: 0.2, top: 0.05, bottom: 0.1 },
        },
      ],
      transitions: [],
      keyframes: [
        {
          itemId: 'title',
          properties: [
            {
              property: 'x',
              keyframes: [
                { id: 'x0', frame: 0, value: 100, easing: 'linear' },
                { id: 'x60', frame: 60, value: 220, easing: 'linear' },
              ],
            },
          ],
        },
      ],
      masterBusDb: -6,
      masterBusMuted: false,
      masterGainEnvelope: [
        { id: 'start', frame: 0, gainDb: -3 },
        { id: 'end', frame: 60, gainDb: -9 },
      ],
      currentFrame: 12,
      zoomLevel: 1,
      scrollPosition: 0,
    },
  }) as unknown as Project

/** The stored document without the fields a save always restamps. */
const stored = async (id: string) => {
  const { updatedAt: _updatedAt, ...rest } = (await getProject(id)) as Project
  return JSON.stringify(rest)
}

describe('adaptive preview quality changes previews only (FL-98)', () => {
  let workspace: VirtualWorkspace

  beforeEach(() => {
    workspace = new VirtualWorkspace()
    setWorkspaceRoot(workspace.handle())
    usePlaybackStore.getState().setPreviewQuality(1)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    usePlaybackStore.getState().setPreviewQuality(1)
    setWorkspaceRoot(null)
    workspace.dispose()
  })

  it('saves identical graph, master audio, color and export intent after a real adaptive downgrade', async () => {
    await createProject(graph('fl-adaptive'))
    await loadTimeline('fl-adaptive')
    await saveTimeline('fl-adaptive')
    const before = await stored('fl-adaptive')
    const exportBefore = render(createElement(ExportDialog, { open: true, onClose: () => {} }))
    const requestBefore = vi.mocked(post).mock.calls.at(-1)?.[0]
    exportBefore.unmount()
    const { result } = renderHook(useAdaptiveComposition)
    const inputBefore = result.current.inputProps
    const keyframesBefore = result.current.fastScrubScaledKeyframes
    let now = 2000
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      act(() => usePlaybackStore.getState().play())
      for (let frame = 1; frame <= 12; frame += 1) {
        now += 100
        act(() => result.current.handleFrameChange(frame))
      }
      expect(result.current.adaptiveQualityCap).toBe(0.5)
      expect(result.current.renderSize).toEqual({ width: 960, height: 540 })
      expect(result.current.playerRenderSize).toEqual({ width: 1920, height: 1080 })
      expect(result.current.inputProps).toEqual(inputBefore)
      expect(result.current.fastScrubScaledKeyframes).toEqual(keyframesBefore)
      await saveTimeline('fl-adaptive')
      expect(await stored('fl-adaptive')).toBe(before)
      render(createElement(ExportDialog, { open: true, onClose: () => {} }))
      expect(vi.mocked(post).mock.calls.at(-1)?.[0]).toEqual(requestBefore)
      expect(requestBefore).toEqual({ type: 'request-export', kind: 'video' })
    } finally {
      clock.mockRestore()
    }
  })

  it('stores the same graph at every preview quality', async () => {
    await createProject(graph('fl-quality'))
    await loadTimeline('fl-quality')
    await saveTimeline('fl-quality')
    const full = await stored('fl-quality')

    for (const quality of [0.5, 0.33, 0.25] as const) {
      usePlaybackStore.getState().setPreviewQuality(quality)
      await saveTimeline('fl-quality')
      expect(await stored('fl-quality')).toBe(full)
    }
    expect(full).not.toMatch(/previewQuality|qualityCap/)
  })

  it('asks the host for standard exact frames whatever the preview quality', async () => {
    vi.useFakeTimers()
    usePlaybackStore.setState({ isPlaying: false, currentFrame: 15 })
    usePlaybackStore.getState().setPreviewQuality(0.25)
    const call = vi.fn(async () => undefined as never)
    const context = {
      serverPreviewOpen: true,
      capabilities: { renderWorker: true },
      project: { revision: 7 },
      preview: { phase: 'idle' },
      strings: {},
    } as unknown as StudioHostContext
    render(createElement(RemotePreview, { context, call }))
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    const [, envelopes] = call.mock.calls.at(-1) as unknown as [
      string,
      Array<{ id: string; payload: { quality: string } }>,
    ]
    expect(envelopes[0]).toMatchObject({ id: 'preview.request', payload: { quality: 'standard' } })
  })
})
