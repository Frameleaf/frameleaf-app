import { describe, expect, it, vi } from 'vite-plus/test'
import { writeBlob } from '@/infrastructure/storage/workspace-fs/fs-primitives'
import { createMedia, getMedia } from '@/infrastructure/storage'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import type { StudioProjectImportRef, StudioProjectImportUpload } from '@frameleaf/host/host-contract'
import { importedSourceId, watchLocalImports } from '../src/project-imports'
import { createLibraryMediaSeeder, projectImportRecord } from '../src/library-media'
import { VirtualWorkspace } from '../src/virtual-workspace'

// Folder handles for imported files live in IndexedDB, which jsdom does not have; none are used here.
vi.mock('@/infrastructure/storage/handles-db', () => ({
  getHandle: vi.fn(async () => undefined),
  saveHandle: vi.fn(async () => undefined),
  deleteHandle: vi.fn(async () => undefined),
}))

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

/**
 * FL-103 / FL-105: files imported or recorded inside the editor are sent to the host to be kept with
 * the project, and files the host keeps come back into the bin under the media ids clips use.
 */

const TAKE = 'b7c1d2e3-0000-4000-8000-000000000001'
const SVG = 'b7c1d2e3-0000-4000-8000-000000000002'
const LIBRARY = '0198a1c2-0000-7000-8000-00000000000a'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const keptRef = (upload: StudioProjectImportUpload): StudioProjectImportRef => ({
  id: upload.id,
  kind: 'audio',
  name: upload.fileName,
  mimeType: 'audio/webm',
  sizeBytes: upload.file.size,
  url: `/api/studio/projects/p/imports/${upload.id}/file`,
})

describe('project imports in the editor (FL-103 / FL-105)', () => {
  it('recognises only a media source file under a media id', () => {
    expect(importedSourceId(['media', TAKE, 'Voiceover 1.webm'])).toBe(TAKE)
    expect(importedSourceId(['media', TAKE, 'metadata.json'])).toBeNull()
    expect(importedSourceId(['media', TAKE, 'thumbnail.jpg'])).toBeNull()
    expect(importedSourceId(['media', TAKE, 'cache', 'waveform.bin'])).toBeNull()
    expect(importedSourceId(['media', 'restored-x', 'a.mp4'])).toBeNull()
    expect(importedSourceId(['projects', TAKE, 'project.json'])).toBeNull()
  })

  it('sends each new source once, skips what the host gave, and reports a refusal once', async () => {
    const workspace = new VirtualWorkspace()
    const root = workspace.handle()
    const known = new Set([LIBRARY])
    const media = { known: (id: string) => known.has(id), kept: (id: string) => known.add(id) }
    const uploads: StudioProjectImportUpload[] = []
    const refused = vi.fn()
    const watch = watchLocalImports({
      workspace,
      media,
      upload: (upload) => {
        uploads.push(upload)
        return upload.id === SVG ? Promise.reject(new Error('An SVG with scripts cannot be imported')) : Promise.resolve(keptRef(upload))
      },
      refused,
    })

    await writeBlob(root, ['media', TAKE, 'Voiceover 1.webm'], new Uint8Array([1, 2, 3]))
    await writeBlob(root, ['media', TAKE, 'metadata.json'], new Uint8Array([123, 125]))
    await writeBlob(root, ['media', LIBRARY, 'summit.jpg'], new Uint8Array([4]))
    await writeBlob(root, ['media', SVG, 'logo.svg'], new Uint8Array([60]))
    await tick()

    expect(uploads.map((upload) => [upload.id, upload.fileName, upload.file.size])).toEqual([
      [TAKE, 'Voiceover 1.webm', 3],
      [SVG, 'logo.svg', 1],
    ])
    expect(known.has(TAKE)).toBe(true)
    expect(refused).toHaveBeenCalledTimes(1)
    expect(refused).toHaveBeenCalledWith('logo.svg', 'An SVG with scripts cannot be imported')

    // A kept file is not sent again when the engine rewrites it.
    await writeBlob(root, ['media', TAKE, 'Voiceover 1.webm'], new Uint8Array([1, 2, 3]))
    await tick()
    expect(uploads).toHaveLength(2)

    // A retry (the project was saved) sends what is still unkept, without reporting it again.
    await watch.retry()
    expect(uploads.map((upload) => upload.id)).toEqual([TAKE, SVG, SVG])
    expect(refused).toHaveBeenCalledTimes(1)

    watch.stop()
    await writeBlob(root, ['media', 'b7c1d2e3-0000-4000-8000-000000000009', 'late.wav'], new Uint8Array([1]))
    await tick()
    expect(uploads).toHaveLength(3)
  })

  it('offers a kept file back under its media id, without replacing one this document holds', async () => {
    const workspace = new VirtualWorkspace()
    setWorkspaceRoot(workspace.handle())
    try {
      const fetched: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          fetched.push(url)
          return new Response(new Uint8Array([7, 7]))
        }),
      )
      const seeder = createLibraryMediaSeeder({ workspace, projectId: () => 'fl-p', onChange: () => {} })
      // Already imported here: the editor's own record stays as Freecut made it.
      await createMedia({ ...projectImportRecord(keptRef({ id: SVG, fileName: 'x.svg', file: new Blob(['x']) }), 0), duration: 9 })

      const take: StudioProjectImportRef = {
        id: TAKE,
        kind: 'vector',
        name: 'Intro.json',
        mimeType: 'application/lottie+json',
        sizeBytes: 2,
        url: `/api/studio/projects/p/imports/${TAKE}/file`,
      }
      vi.mocked(fetch).mockImplementation(async (url) => {
        fetched.push(String(url))
        return new Response(JSON.stringify({ v: '5.7.4', w: 640, h: 360, fr: 30, ip: 0, op: 90, layers: [] }))
      })
      await seeder.seedImports([take, { ...take, id: SVG, name: 'x.svg', mimeType: 'image/svg+xml', kind: 'vector' }])

      expect(await getMedia(TAKE)).toMatchObject({
        id: TAKE,
        fileName: 'Intro.json',
        mimeType: 'application/lottie+json',
        fileSize: 2,
        width: 640,
        height: 360,
        fps: 30,
        duration: 3,
      })
      expect((await getMedia(SVG))?.duration).toBe(9)
      expect(seeder.known(TAKE)).toBe(true)
      expect(seeder.known(SVG)).toBe(true)
      // The kept bytes are fetched lazily, only when something reads them.
      const bytes = await workspace.readFile(['media', TAKE, 'Intro.json'])
      expect(bytes?.size).toBeGreaterThan(0)
      seeder.dispose()
    } finally {
      vi.unstubAllGlobals()
      setWorkspaceRoot(null)
    }
  })
})
