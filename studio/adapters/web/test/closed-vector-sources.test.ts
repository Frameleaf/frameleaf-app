import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { createClosedVectorSources } from '../src/closed-vector-sources'
import { VirtualWorkspace } from '../src/virtual-workspace'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { createMedia, getMedia, readMediaSource } from '@/infrastructure/storage'
import { mediaDir } from '@/infrastructure/storage/workspace-fs/paths'
import { blobUrlManager } from '@/infrastructure/browser/blob-url-manager'
import { getObjectUrlBlob } from '@/infrastructure/browser/object-url-registry'
import { resolveMediaUrl } from '@/features/media-library/utils/media-resolver'
import {
  resolveScopedMedia,
  peekScopedMedia,
} from '@/features/media-library/utils/scoped-media-resolution'
import type { MediaMetadata } from '@/types/storage'

vi.mock('@/infrastructure/storage/handles-db', () => ({
  getHandle: async () => undefined,
  saveHandle: async () => undefined,
  deleteHandle: async () => undefined,
}))
// Worker/probing services cannot run in jsdom. The storage-facing facade performs real workspace
// metadata/source reads; no scripted storage answers or mock URL cache replaces the resolver.
vi.mock('@/features/media-library/services/media-library-service', async () => {
  const storage = await import('@/infrastructure/storage')
  const { FileAccessError } = await import('@/features/media-library/services/file-access')
  return {
    FileAccessError,
    mediaLibraryService: {
      getMedia: storage.getMedia,
      getMediaFile: (media: MediaMetadata) => storage.readMediaSource(media.id),
    },
  }
})
const id = '11111111-1111-4111-8111-111111111111'
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const read = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reject
    reader.readAsText(blob)
  })
// The existing adapter fixture uses these browser methods, absent from jsdom's Blob.
if (!Blob.prototype.text)
  Blob.prototype.text = function () {
    return read(this)
  }
if (!Blob.prototype.arrayBuffer)
  Blob.prototype.arrayBuffer = function () {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = reject
      reader.readAsArrayBuffer(this)
    })
  }

describe('closed native vector ownership with real VirtualWorkspace and URL manager', () => {
  let workspace: VirtualWorkspace
  let owner: ReturnType<typeof createClosedVectorSources> | undefined
  let created: number
  beforeEach(async () => {
    workspace = new VirtualWorkspace()
    setWorkspaceRoot(workspace.handle())
    created = 0
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => `blob:owned-${++created}`),
        revokeObjectURL: vi.fn(),
      }),
    )
    await createMedia({
      id,
      storageType: 'workspace',
      fileName: 'original.json',
      fileSize: 8,
      mimeType: 'application/lottie+json',
      width: 2,
      height: 2,
      fps: 24,
      duration: 1,
      codec: 'lottie',
      bitrate: 0,
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    })
    workspace.putFile([...mediaDir(id), 'original.json'], 'ORIGINAL')
    workspace.putFile(
      ['projects', 'owned', 'project.json'],
      '{"history":["original"],"maps":{"opaque":true}}',
    )
  })
  afterEach(() => {
    owner?.dispose()
    owner?.unmount()
    owner = undefined
    blobUrlManager.releaseAll()
    setWorkspaceRoot(null)
    workspace.dispose()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  const source = () => ({ blob: new Blob(['CLOSED']), expiresAt: Date.now() + 5000 })

  it('overrides an original cache hit, retains one lease, and preserves file/metadata/graph bytes', async () => {
    const metadata = await getMedia(id)
    const graph = await workspace.readText(['projects', 'owned', 'project.json'])
    blobUrlManager.registerUrl(id, '/original-with-uncontrolled-child')
    owner = createClosedVectorSources()
    const load = vi.fn(async () => source())
    owner.reconcile({ key: 'user/project/revision/graph/parent/child', current: () => true, ids: new Set([id]), load })
    const url = await resolveMediaUrl(id)
    expect(url).toBe('blob:owned-1')
    expect(await resolveMediaUrl(id)).toBe(url)
    expect(load).toHaveBeenCalledTimes(1)
    expect(await read(getObjectUrlBlob(url)!)).toBe('CLOSED')
    expect(await read((await readMediaSource(id))!)).toBe('ORIGINAL')
    expect(await getMedia(id)).toEqual(metadata)
    expect(await workspace.readText(['projects', 'owned', 'project.json'])).toBe(graph)
    owner.dispose()
    expect(await resolveMediaUrl(id)).toBe('')
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('denies unknown vector IDs and withdrawn IDs without original fallback', async () => {
    owner = createClosedVectorSources()
    owner.reconcile({ key: 'first', current: () => true, ids: new Set([id]), load: async () => source() })
    await resolveMediaUrl(id)
    owner.reconcile({ key: 'removed', current: () => true, ids: new Set(), load: async () => source() })
    expect(await resolveMediaUrl(id)).toBe('')
    expect(await resolveScopedMedia('unknown', true)).toEqual({ handled: true, url: '' })
    expect(peekScopedMedia(id)).toEqual({ handled: true, url: '' })
  })

  it('real bin withdrawal retires a URL and pending work until the same association is restored', async () => {
    owner = createClosedVectorSources()
    const pending = deferred<ReturnType<typeof source>>()
    const load = vi
      .fn()
      .mockResolvedValueOnce(source())
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(source())
    owner.reconcile({ key: 'same-authorized-context', current: () => true, ids: new Set([id]), load })
    const first = await resolveMediaUrl(id)
    owner.availability(id, false)
    expect(await resolveMediaUrl(id)).toBe('')
    expect(getObjectUrlBlob(first)).toBeNull()
    owner.availability(id, true)
    const late = resolveMediaUrl(id)
    await Promise.resolve()
    owner.availability(id, false)
    pending.resolve(source())
    expect(await late).toBe('')
    expect(await resolveMediaUrl(id)).toBe('')
    owner.availability(id, true)
    expect(await resolveMediaUrl(id)).not.toBe(first)
    expect(await read((await readMediaSource(id))!)).toBe('ORIGINAL')
  })

  it('invalidating the actual manager rebuilds with a fresh allocation key, immune to an old release', async () => {
    const acquire = vi.spyOn(blobUrlManager, 'acquire')
    owner = createClosedVectorSources()
    owner.reconcile({ key: 'same', current: () => true, ids: new Set([id]), load: async () => source() })
    const first = await resolveMediaUrl(id)
    const oldKey = acquire.mock.calls[0]![0]
    blobUrlManager.invalidateAll()
    const second = await resolveMediaUrl(id)
    expect(second).not.toBe(first)
    expect(acquire.mock.calls[1]![0]).not.toBe(oldKey)
    blobUrlManager.release(oldKey)
    blobUrlManager.release(id)
    expect(await resolveMediaUrl(id)).toBe(second)
    owner.dispose()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('an old same-key completion/finally cannot publish or delete a replacement pending owner', async () => {
    const old = deferred<ReturnType<typeof source>>()
    const next = deferred<ReturnType<typeof source>>()
    const load = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    owner = createClosedVectorSources()
    owner.reconcile({ key: 'same', current: () => true, ids: new Set([id]), load })
    const before = resolveMediaUrl(id)
    await Promise.resolve()
    owner.invalidate()
    owner.reconcile({ key: 'same', current: () => true, ids: new Set([id]), load })
    const after = resolveMediaUrl(id)
    await Promise.resolve()
    old.resolve(source())
    expect(await before).toBe('')
    const parallel = resolveMediaUrl(id)
    next.resolve(source())
    expect(await after).toBe(await parallel)
    expect(load).toHaveBeenCalledTimes(2)
    expect(created).toBe(1)
  })

  it('a real pending original workspace read cannot publish after scope installation', async () => {
    const original = deferred<Blob>()
    const reached = deferred<void>()
    workspace.putLazyFile([...mediaDir(id), 'original.json'], () => {
      reached.resolve()
      return original.promise
    })
    const pending = resolveMediaUrl(id)
    await reached.promise
    owner = createClosedVectorSources()
    owner.reconcile({
      key: 'installed-during-read',
      current: () => true, ids: new Set([id]),
      load: async () => source(),
    })
    original.resolve(new Blob(['ORIGINAL']))
    const url = await pending
    expect(await read(getObjectUrlBlob(url)!)).toBe('CLOSED')
    expect(blobUrlManager.get(id)).toBeNull()
    expect(created).toBe(1)
  })

  it('expiry revokes the actual lease and refuses stale bytes, then permits a verified rebuild', async () => {
    vi.useFakeTimers()
    owner = createClosedVectorSources()
    const load = vi.fn(async () => source())
    owner.reconcile({ key: 'expires', current: () => true, ids: new Set([id]), load })
    const first = await resolveMediaUrl(id)
    await vi.advanceTimersByTimeAsync(5001)
    expect(peekScopedMedia(id)).toEqual({ handled: true, url: '' })
    expect(getObjectUrlBlob(first)).toBeNull()
    expect(await resolveMediaUrl(id)).not.toBe(first)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

for (const edge of ['account', 'project', 'revision', 'digest', 'lease', 'offline', 'source-epoch', 'reconcile', 'remount']) {
  it(`${edge} retires all old allocations and refuses pending old publication`, async () => {
    const owner = createClosedVectorSources()
    const old = deferred<{ blob: Blob; expiresAt: number }>()
    const created = vi.spyOn(blobUrlManager, 'acquire')
    try {
      owner.reconcile({ key: 'before', ids: new Set([id]), current: () => true, load: () => old.promise })
      const pending = resolveScopedMedia(id, true)
      await Promise.resolve()
      owner.reconcile({ key: edge, ids: new Set(), current: () => false, load: async () => { throw new Error('refused') } })
      old.resolve({ blob: new Blob(['stale']), expiresAt: Date.now() + 4000 })
      expect(await pending).toEqual({ handled: true, url: '' })
      expect(created).not.toHaveBeenCalled()
    } finally { owner.dispose(); owner.unmount(); created.mockRestore() }
  })
}
