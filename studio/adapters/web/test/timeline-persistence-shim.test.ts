import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { saveTimelineWithDeps } from '../src/shims/timeline-persistence'

/**
 * `saveTimelineWithDeps` (FL-89, FL-174, FL-187) is `saveTimeline` with its engine save, its content
 * read and its gate taken as arguments, driven here against fakes instead of `@/features/timeline/…`.
 *
 * `vite.config.mjs`'s `frameleaf-gate-timeline-persistence` plugin sends every import of
 * `@/features/timeline/stores/timeline-persistence` whose importer is not this shim's own file to the
 * shim instead of the engine's module underneath it — including the resolution `vi.mock` does for
 * that specifier from a test file. Mocking that specifier here would therefore replace the shim
 * itself with the mock, not the engine calls the shim makes, and every assertion about the shim's own
 * gate logic would pass or fail for the wrong reason. `saveTimelineWithDeps` exists so this file never
 * needs to mock that specifier at all.
 */

let content = 'r0'
const contentOf = () => content
const save = vi.fn(async () => undefined)
const markDirty = vi.fn()

const run = (projectId: string, mayStartSave: (projectId: string) => boolean) =>
  saveTimelineWithDeps(projectId, { save, contentOf, mayStartSave, markDirty })

describe('saveTimelineWithDeps gate (FL-187)', () => {
  beforeEach(() => {
    content = 'r0'
    save.mockClear()
    save.mockImplementation(async () => undefined)
    markDirty.mockClear()
  })

  it('never asks the engine to save once the gate refuses the mount up front', async () => {
    await run('p-m0', () => false)
    expect(save).not.toHaveBeenCalled()
    expect(markDirty).not.toHaveBeenCalled()
  })

  it('marks the timeline dirty again the moment the save’s own mount is gone, before comparing content', async () => {
    let allowed = true
    save.mockImplementation(async () => {
      // A remount replaces the mount while the engine's own write is still in flight (FL-187): by
      // the time it resolves, Freecut has already marked the (shared) timeline clean for it, and
      // this document's gate would refuse the very save it just started.
      allowed = false
    })
    await run('p-m0', () => allowed)
    expect(save).toHaveBeenCalledWith('p-m0')
    // The correction runs even though the content did not change, which is the case the content
    // comparison alone would miss: nothing here tells the person a save succeeded for a mount that
    // is no longer current.
    expect(markDirty).toHaveBeenCalledTimes(1)
  })

  it('still marks dirty when the content changed under a save that otherwise stayed valid', async () => {
    save.mockImplementation(async () => {
      content = 'r1' // an edit landed in the stores while the engine wrote (FL-174)
    })
    await run('p-m0', () => true)
    expect(markDirty).toHaveBeenCalledTimes(1)
  })

  it('leaves the timeline alone when the save both stayed valid and nothing changed', async () => {
    await run('p-m0', () => true)
    expect(markDirty).not.toHaveBeenCalled()
  })
})
