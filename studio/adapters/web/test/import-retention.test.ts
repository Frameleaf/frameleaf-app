import { describe, expect, it, vi } from 'vite-plus/test'
import type { StudioProjectImportRef } from '@frameleaf/host/host-contract'
import { createCompletionRetention, type CompletionUpload } from '../src/import-retention'
import { VirtualWorkspace } from '../src/virtual-workspace'

const id = 'b7c1d2e3-0000-4000-8000-000000000001'
const upload: CompletionUpload = {
  id,
  publicationId: 'b7c1d2e3-0000-4000-8000-000000000002',
  fileName: 'upscaled.mp4',
  file: new Blob(['bytes']),
  processingProvenance: {
    version: 1,
    family: 'anime4k',
    evidence: 'client-reported',
    variant: 'animation',
    source: { namespace: 'freecut-media', id: 'source-1', projectId: '0198a1c2-0000-7000-8000-00000000000a' },
    input: { width: 640, height: 360 },
    output: { width: 1280, height: 720, fps: 30000 / 1001, frameCount: 30, codec: 'avc' },
  },
}
const imported: StudioProjectImportRef = {
  id,
  kind: 'video',
  name: upload.fileName,
  mimeType: 'video/mp4',
  sizeBytes: 5,
  url: '/file',
}
const setup = () => {
  const workspace = new VirtualWorkspace()
  const hold = vi.fn()
  const send = vi.fn(async (_upload: CompletionUpload) => imported)
  const kept = vi.fn()
  let current = true
  const retention = createCompletionRetention({
    workspace,
    watch: { hold },
    current: () => current,
    upload: send,
    kept,
  })
  return {
    workspace,
    retention,
    hold,
    send,
    kept,
    retire: () => {
      current = false
    },
  }
}

describe('explicit completion retention', () => {
  it('holds memory and marker before submission and preserves exact worker facts without model binding', async () => {
    const state = setup()
    await state.retention.hold(id)
    expect(state.hold).toHaveBeenCalledWith(id)
    expect(state.workspace.list(['media', id])).toContainEqual({ name: 'retention.json', kind: 'file' })
    expect(state.send).not.toHaveBeenCalled()
    expect(await state.retention.complete(upload)).toEqual(imported)
    expect(state.send).toHaveBeenCalledWith(upload)
    expect(state.send.mock.calls[0]?.[0]?.processingProvenance.output.fps).toBe(30000 / 1001)
    expect(upload.processingProvenance).not.toHaveProperty('modelBinding')
    expect(state.kept).toHaveBeenCalledWith(id)
    state.retention.dispose()
    state.workspace.dispose()
  })

  it.each(['cancel', 'retire', 'dispose'] as const)('refuses completion after %s', async (action: 'cancel' | 'retire' | 'dispose') => {
    const state = setup()
    await state.retention.hold(id)
    if (action === 'cancel') state.retention.cancel(id)
    if (action === 'retire') state.retire()
    if (action === 'dispose') state.retention.dispose()
    await expect(state.retention.complete(upload)).rejects.toThrow()
    expect(state.send).not.toHaveBeenCalled()
    state.workspace.dispose()
  })

  it('treats upload failure as unknown and never resends held bytes automatically', async () => {
    const state = setup()
    state.send.mockRejectedValueOnce(new Error('network_unknown'))
    await state.retention.hold(id)
    await expect(state.retention.complete(upload)).rejects.toThrow('network_unknown')
    await expect(state.retention.complete(upload)).rejects.toThrow('completion_already_submitted')
    expect(state.send).toHaveBeenCalledTimes(1)
    expect(state.kept).not.toHaveBeenCalled()
    expect(state.workspace.list(['media', id])).toContainEqual({ name: 'retention.json', kind: 'file' })
    state.workspace.dispose()
  })

  it('returns an original committed response without marking a retired session', async () => {
    const state = setup()
    let resolve!: (value: StudioProjectImportRef) => void
    state.send.mockImplementationOnce(
      () =>
        new Promise((accept) => {
          resolve = accept
        }),
    )
    await state.retention.hold(id)
    const completion = state.retention.complete(upload)
    state.retire()
    resolve(imported)
    expect(await completion).toEqual(imported)
    expect(state.kept).not.toHaveBeenCalled()
    state.workspace.dispose()
  })
})
