import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Project } from '@/types/project'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { createProject, getProject } from '@/infrastructure/storage'
import { CURRENT_SCHEMA_VERSION } from '@/shared/projects/migrations/types'
import { loadTimeline, saveTimeline } from '@/features/timeline/stores/timeline-persistence'
import { usePlaybackStore } from '@/shared/state/playback'
import type { StudioHostContext } from '@frameleaf/host/host-contract'
import { VirtualWorkspace } from '../src/virtual-workspace'
import { RemotePreview } from '../src/remote-preview'

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
    metadata: { width: 1920, height: 1080, fps: 30 },
    timeline: {
      tracks: [{ id: 'v1', name: 'V1', kind: 'video', height: 60, locked: false, visible: true, muted: false, solo: false, order: 0, items: [] }],
      items: [
        { id: 'title', trackId: 'v1', type: 'text', from: 0, durationInFrames: 60, label: 'Title', text: 'Title', color: '#ffffff' },
      ],
      transitions: [],
      keyframes: [],
      currentFrame: 0,
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
    const [, envelopes] = call.mock.calls.at(-1) as unknown as [string, Array<{ id: string; payload: { quality: string } }>]
    expect(envelopes[0]).toMatchObject({ id: 'preview.request', payload: { quality: 'standard' } })
  })
})
