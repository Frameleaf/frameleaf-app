import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { webcrypto } from 'node:crypto'
import { createMedia, getMedia, readMediaSource } from '@/infrastructure/storage'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { writeMediaSource } from '@/infrastructure/storage/workspace-fs/media-source'
import { useMediaLibraryStore } from '@/features/media-library/stores/media-library-store'
import { registerMediaFileRelink } from '@/features/media-library/stores/media-relinking-actions'
import type { Project } from '@/types/project'
import type { StudioProjectImportRef } from '@frameleaf/host/host-contract'
import {
  createMediaFileRelinker,
  selectRelinkFile,
  type RelinkCapture,
} from '../src/media-file-relink'
import { projectImportRecord } from '../src/library-media'
import { VirtualWorkspace } from '../src/virtual-workspace'
import { hideFileSystemPickers } from '../src/browser-shims'

vi.mock('@/infrastructure/storage/handles-db', () => ({
  getHandle: vi.fn(async () => undefined),
  saveHandle: vi.fn(async () => undefined),
  deleteHandle: vi.fn(async () => undefined),
}))
if (!Blob.prototype.arrayBuffer)
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(this)
    })
  }
if (!Blob.prototype.text)
  Blob.prototype.text = async function () {
    return new TextDecoder().decode(await this.arrayBuffer())
  }
const A = 'b7c1d2e3-0000-4000-8000-000000000001'
const file = (bytes: string) =>
  new File([bytes], 'same.wav', { type: 'audio/wav', lastModified: 123 })
const hash = async (file: File) =>
  Array.from(
    new Uint8Array(await webcrypto.subtle.digest('SHA-256', await file.arrayBuffer())),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
let workspace: VirtualWorkspace
beforeEach(() => {
  workspace = new VirtualWorkspace()
  setWorkspaceRoot(workspace.handle())
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => {
  workspace.dispose()
  setWorkspaceRoot(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const setup = async (selected: File | undefined = file('BBBB')) => {
  const original = file('AAAA')
  const ref: StudioProjectImportRef = {
    id: A,
    name: original.name,
    kind: 'audio',
    sizeBytes: original.size,
    mimeType: original.type,
    checksum: await hash(original),
    url: '/owned/a',
  }
  const record = { ...projectImportRecord(ref, 0), duration: 8 }
  await createMedia(record)
  await writeMediaSource(A, original, original.name, { strict: true })
  let current = true
  let savedGraph: Project | undefined
  let publishedGraph: Project | undefined
  const order: string[] = []
  const capture: RelinkCapture = {
    scope: { projectId: 'project', userId: 'owner', graphVersion: 0 },
    revision: 3,
    signal: new AbortController().signal,
    current: () => current,
    graph: {
      id: 'project',
      metadata: { fps: 30 },
      timeline: {
        items: [
          {
            id: 'clip',
            type: 'audio',
            trackId: 'a1',
            mediaId: A,
            from: 10,
            durationInFrames: 30,
            sourceStart: 15,
            sourceEnd: 45,
            sourceFps: 30,
            linkedGroupId: 'linked',
            reverseConformKey: ref.checksum,
            waveformData: [1],
          },
        ],
        compositions: [],
        tracks: [],
      },
    } as unknown as Project,
  }
  const upload = vi.fn(async (value) => {
    order.push('admitted')
    return { ...ref, id: value.id, name: value.fileName, checksum: await hash(value.file) }
  })
  const commit = vi.fn(async (graph: Project) => {
    order.push('saved')
    savedGraph = graph
    return { status: 'saved' as const, revision: 4 }
  })
  const guard = vi.fn()
  const publish = vi.fn(async (graph: Project) => {
    order.push('published')
    publishedGraph = graph
  })
  const relink = createMediaFileRelinker({
    workspace,
    capture: () => capture,
    imports: () => [ref],
    select: async () => selected,
    upload,
    probe: async () => ({ duration: 8, audioCodec: 'pcm' }),
    commit,
    lock: () => () => order.push('unlocked'),
    publish,
    guard,
  })
  return {
    ref,
    record,
    publish,
    guard,
    upload,
    commit,
    relink,
    capture,
    order,
    stale: () => {
      current = false
    },
    graph: () => savedGraph,
    published: () => publishedGraph,
  }
}

describe('actual relink source, store and host boundary', () => {
  it('uses a new admitted identity for equal name/size/mtime with different SHA, before graph success', async () => {
    const f = await setup()
    const sharedA = ['content', 'proxies', f.ref.checksum!, 'proxy.mp4']
    workspace.putFile(sharedA, 'cached A shared by another reader')
    await expect(f.relink(A)).resolves.toBe(true)
    expect(await workspace.readText(sharedA)).toBe('cached A shared by another reader')
    const id = f.graph()!.timeline!.items[0]!.mediaId!
    expect(id).not.toBe(A)
    expect((await getMedia(id))!.contentHash).not.toBe(f.ref.checksum)
    expect(workspace.list(['content', 'proxies'])).toEqual([
      { name: f.ref.checksum, kind: 'directory' },
    ])
    expect(f.order).toEqual(['admitted', 'saved', 'published', 'unlocked'])
    expect(await getMedia(id)).toMatchObject({
      id,
      contentHash: await hash(file('BBBB')),
      duration: 8,
    })
    expect(await (await readMediaSource(id))!.text()).toBe('BBBB')
    expect(await (await readMediaSource(A))!.text()).toBe('AAAA')
    expect(f.graph()!.timeline!.items[0]).toMatchObject({
      from: 10,
      sourceStart: 15,
      sourceEnd: 45,
      linkedGroupId: 'linked',
    })
    expect(f.graph()!.timeline!.items[0]!.reverseConformKey).toBeUndefined()
  })

  it('restores identical bytes under the immutable admitted identity and keeps metadata', async () => {
    const f = await setup(file('AAAA'))
    await expect(f.relink(A)).resolves.toBe(true)
    expect(f.upload.mock.calls[0]![0].id).toBe(A)
    expect(f.graph()).toEqual(f.capture.graph)
    expect(await getMedia(A)).toEqual(f.record)
    expect(workspace.list(['media', A, 'cache'])).toHaveLength(0)
  })

  it('cancellation and upload refusal cannot publish a graph', async () => {
    const f = await setup(undefined)
    // Explicit undefined is the selected-file cancellation result.
    const cancel = createMediaFileRelinker({
      workspace,
      capture: () => f.capture,
      imports: () => [f.ref],
      select: async () => undefined,
      upload: f.upload,
      commit: f.commit,
      lock: () => () => {},
      publish: vi.fn(),
    })
    await expect(cancel(A)).resolves.toBe(false)
    expect(f.upload).not.toHaveBeenCalled()
    f.upload.mockRejectedValueOnce(new Error('server refused bytes'))
    const unregister = registerMediaFileRelink(f.relink)
    const notify = vi.fn()
    const previous = useMediaLibraryStore.getState().showNotification
    useMediaLibraryStore.setState({ showNotification: notify })
    await expect(useMediaLibraryStore.getState().relinkMedia(A)).resolves.toBe(false)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'server refused bytes' }),
    )
    expect(f.commit).not.toHaveBeenCalled()
    useMediaLibraryStore.setState({ showNotification: previous })
    unregister()
  })

  it('refused save restores same-byte source backup and never reports success', async () => {
    const f = await setup(file('AAAA'))
    f.commit.mockResolvedValueOnce({ status: 'rejected', reason: 'lease lost' } as never)
    await expect(f.relink(A)).rejects.toThrow('lease lost')
    expect(f.published()).toBeUndefined()
    expect(await (await readMediaSource(A))!.text()).toBe('AAAA')
    expect(await getMedia(A)).toEqual(f.record)
    expect(workspace.list(['media', A, 'cache'])).toHaveLength(0)
  })

  it('a captured origin retired during upload cannot save or publish the replacement', async () => {
    const f = await setup()
    const upload = f.upload.getMockImplementation()!
    f.upload.mockImplementationOnce(async (value) => {
      const admitted = await upload(value)
      f.stale()
      return admitted
    })
    await expect(f.relink(A)).rejects.toThrow('editor changed')
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.published()).toBeUndefined()
    expect(await (await readMediaSource(A))!.text()).toBe('AAAA')
  })

  it('guards publication failure after an acknowledged save without claiming remote rollback', async () => {
    const f = await setup()
    f.publish.mockRejectedValueOnce(new Error('local hydrate failed'))
    await expect(f.relink(A)).rejects.toThrow('replacement was saved')
    expect(f.guard).toHaveBeenCalledWith(f.capture)
    expect(await (await readMediaSource(A))!.text()).toBe('AAAA')
    expect(f.order).toContain('saved')
    expect(f.order).toContain('unlocked')
  })

  it('an aborted selection scope cannot publish after the same origin becomes current again', async () => {
    const f = await setup()
    const retired = new AbortController()
    f.capture.signal = retired.signal
    const upload = f.upload.getMockImplementation()!
    f.upload.mockImplementationOnce(async (value) => {
      const admitted = await upload(value)
      retired.abort()
      return admitted
    })
    await expect(f.relink(A)).rejects.toThrow('editor changed')
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()
  })

  it('selects a portable File while production filesystem APIs are hidden and cancellation is a no-op', async () => {
    hideFileSystemPickers()
    const selected = file('BBBB')
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      expect(this.accept).toContain('.wav')
      Object.defineProperty(this, 'files', { value: [selected] })
      this.dispatchEvent(new Event('change'))
    })
    await expect(selectRelinkFile(new AbortController().signal)).resolves.toBe(selected)
    expect(window.showOpenFilePicker).toBeUndefined()
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      this.dispatchEvent(new Event('cancel'))
    })
    await expect(selectRelinkFile(new AbortController().signal)).resolves.toBeUndefined()
  })
})
