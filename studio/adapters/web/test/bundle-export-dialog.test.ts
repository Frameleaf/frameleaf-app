// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { call, post } from '../src/host-port'
import { BundleExportDialog } from '../src/shims/bundle-export-dialog'

vi.mock('../src/host-port', () => ({ call: vi.fn(), post: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLElement
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(call).mockResolvedValue([])
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
const show = async (open: boolean, onBeforeExport?: () => Promise<void>, onClose = vi.fn()) => {
  await act(async () =>
    root.render(
      createElement(BundleExportDialog, {
        open,
        onBeforeExport,
        onClose,
        projectId: 'saved-project',
      }),
    ),
  )
  return onClose
}

describe('host-backed project bundle save barrier', () => {
  it('does nothing while closed', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const close = await show(false, save)
    expect(save).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('retains export without an optional pre-save callback', async () => {
    await show(true)
    expect(call).toHaveBeenCalledOnce()
    expect(post).not.toHaveBeenCalled()
  })

  it.each([new Error('Project save failed'), 'Project save failed'])(
    'reports a refused pre-export save without submitting a stale bundle: %s',
    async (error) => {
      const close = await show(true, vi.fn().mockRejectedValue(error))
      expect(close).toHaveBeenCalledOnce()
      expect(call).not.toHaveBeenCalled()
      expect(post).toHaveBeenCalledExactlyOnceWith({
        type: 'notify',
        message: 'Project save failed',
        tone: 'error',
      })
    },
  )

  it('permits reopening after refusal and exports exactly once only after the retried save completes', async () => {
    let revision = 4
    let stored = {
      themeId: 'old',
      textOverrides: { '0': 'Old' },
      colorOverrides: { c0: '#000000' },
      slotOverrides: { scalar: 1, vector: [0, 0] },
    }
    const captured: unknown[] = []
    vi.mocked(call).mockImplementation(async () => {
      captured.push({ revision, item: structuredClone(stored) })
      return []
    })
    let finishSave!: () => void
    const pending = new Promise<void>((resolve) => {
      finishSave = resolve
    })
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('Project save failed'))
      .mockImplementationOnce(async () => {
        await pending
        revision = 5
        stored = {
          themeId: 'winter',
          textOverrides: { '0': 'Edited' },
          colorOverrides: { c0: '#ff8000' },
          slotOverrides: { scalar: 25, vector: [10, -20] },
        }
      })
    const close = vi.fn()
    await show(true, save, close)
    expect(call).not.toHaveBeenCalled()
    await show(false, save, close)
    await show(true, save, close)
    expect(call).not.toHaveBeenCalled()
    await act(async () => {
      finishSave()
      await pending
    })
    expect(save).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenCalledExactlyOnceWith('submitCommands', [
      {
        id: 'project.exportBundle',
        payload: {},
        revision: 0,
        idempotencyKey: expect.any(String),
        issuedAt: expect.any(Number),
      },
    ])
    expect(captured).toEqual([
      {
        revision: 5,
        item: {
          themeId: 'winter',
          textOverrides: { '0': 'Edited' },
          colorOverrides: { c0: '#ff8000' },
          slotOverrides: { scalar: 25, vector: [10, -20] },
        },
      },
    ])
    expect(post).toHaveBeenCalledOnce()
  })
})
