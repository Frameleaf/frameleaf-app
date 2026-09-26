import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { setPersistenceGate } from '../src/persistence-gate'
import { saveTimeline } from '../src/shims/timeline-persistence'

/**
 * `saveTimeline` (FL-89, FL-174, FL-187) wraps Freecut's own engine save; both Ctrl+S and its
 * interval autosave call the exported name through the build's alias, so the wrapper is the one
 * place that can tell whether a save this document started still belongs to the mount it started
 * for, once the engine's own write has finished.
 */

const mocks = vi.hoisted(() => ({
  content: 'r0',
  engineSaveTimeline: vi.fn(async () => undefined),
  markDirty: vi.fn(),
  markClean: vi.fn(),
}))

vi.mock('@/features/timeline/stores/timeline-persistence', () => ({
  buildTimelineFromStores: () => ({
    currentFrame: 0,
    zoomLevel: 1,
    scrollPosition: 0,
    content: mocks.content,
  }),
  loadTimeline: vi.fn(),
  saveTimeline: (...args: unknown[]) => mocks.engineSaveTimeline(...args),
}))

vi.mock('@/features/timeline/stores/timeline-settings-store', () => ({
  useTimelineSettingsStore: {
    getState: () => ({ markDirty: mocks.markDirty, markClean: mocks.markClean }),
  },
}))

describe('saveTimeline gate (FL-187)', () => {
  beforeEach(() => {
    mocks.content = 'r0'
    mocks.engineSaveTimeline.mockClear()
    mocks.engineSaveTimeline.mockImplementation(async () => undefined)
    mocks.markDirty.mockClear()
    mocks.markClean.mockClear()
  })

  it('never asks the engine to save once the gate refuses the mount up front', async () => {
    setPersistenceGate({ mayStartSave: () => false, loadFinished: () => undefined })
    await saveTimeline('p-m0')
    expect(mocks.engineSaveTimeline).not.toHaveBeenCalled()
    expect(mocks.markDirty).not.toHaveBeenCalled()
  })

  it('marks the timeline dirty again the moment the save’s own mount is gone, before comparing content', async () => {
    let allowed = true
    setPersistenceGate({ mayStartSave: () => allowed, loadFinished: () => undefined })
    mocks.engineSaveTimeline.mockImplementation(async () => {
      // A remount replaces the mount while the engine's own write is still in flight (FL-187): by
      // the time it resolves, Freecut has already marked the (shared) timeline clean for it, and
      // this document's gate would refuse the very save it just started.
      allowed = false
    })
    await saveTimeline('p-m0')
    expect(mocks.engineSaveTimeline).toHaveBeenCalledWith('p-m0')
    // The correction runs even though the content did not change, which is the case the content
    // comparison alone would miss: nothing here tells the person a save succeeded for a mount that
    // is no longer current.
    expect(mocks.markDirty).toHaveBeenCalledTimes(1)
  })

  it('still marks dirty when the content changed under a save that otherwise stayed valid', async () => {
    setPersistenceGate({ mayStartSave: () => true, loadFinished: () => undefined })
    mocks.engineSaveTimeline.mockImplementation(async () => {
      mocks.content = 'r1' // an edit landed in the stores while the engine wrote (FL-174)
    })
    await saveTimeline('p-m0')
    expect(mocks.markDirty).toHaveBeenCalledTimes(1)
  })

  it('leaves the timeline alone when the save both stayed valid and nothing changed', async () => {
    setPersistenceGate({ mayStartSave: () => true, loadFinished: () => undefined })
    await saveTimeline('p-m0')
    expect(mocks.markDirty).not.toHaveBeenCalled()
  })
})
