import { describe, expect, it, vi } from 'vite-plus/test'
import {
  exists,
  readJson,
  removeEntry,
  writeBlob,
  writeJsonAtomic,
} from '@/infrastructure/storage/workspace-fs/fs-primitives'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { createProject, getProject, updateProject } from '@/infrastructure/storage'
import { createProjectObject } from '@/features/projects/utils/project-helpers'
import { VirtualWorkspace } from '../src/virtual-workspace'
import { installBrowserShims } from '../src/browser-shims'

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

// Folder handles for imported bundles live in IndexedDB, which jsdom does not have; none are used here.
vi.mock('@/infrastructure/storage/handles-db', () => ({
  getHandle: vi.fn(async () => undefined),
  saveHandle: vi.fn(async () => undefined),
  deleteHandle: vi.fn(async () => undefined),
}))

/**
 * FL-88: Freecut's real storage layer on the host-backed workspace, with no File System Access API.
 */
describe('virtual workspace', () => {
  it('seeds root and nested files without notifying engine write listeners', async () => {
    const workspace = new VirtualWorkspace()
    const writes = vi.fn()
    workspace.onWrite(writes)
    workspace.putFile(['clip.txt'], 'root')
    workspace.putFile(['media', 'm', 'clip.txt'], 'nested')
    expect(await workspace.readText(['clip.txt'])).toBe('root')
    expect(await (await workspace.readFile(['media', 'm', 'clip.txt']))?.text()).toBe('nested')
    expect(writes).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'empty path', path: [], message: 'Empty workspace path' },
    {
      label: 'sparse terminal',
      path: Array<string>(1),
      message: 'Invalid workspace entry name: undefined',
    },
    ...['', '.', '..', '/', '\\'].map((name) => ({
      label: `invalid terminal ${JSON.stringify(name)}`,
      path: ['media', name],
      message: `Invalid workspace entry name: ${name}`,
    })),
  ])('preserves invalid path behavior for $label', async ({ path, message }) => {
    const workspace = new VirtualWorkspace()
    const load = vi.fn(async () => new Blob(['remote']))
    expect(() => workspace.putFile(path, 'seed')).toThrow(new TypeError(message))
    expect(() => workspace.putLazyFile(path, load)).toThrow(new TypeError(message))
    expect(await workspace.readText(path)).toBeNull()
    expect(await workspace.readFile(path)).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })

  it('serves Freecut’s own primitives: atomic JSON, blobs, listing and removal', async () => {
    const workspace = new VirtualWorkspace()
    const root = workspace.handle()
    await writeJsonAtomic(root, ['projects', 'p', 'project.json'], { id: 'p', n: 1 })
    await writeJsonAtomic(root, ['projects', 'p', 'project.json'], { id: 'p', n: 2 })
    expect(await readJson(root, ['projects', 'p', 'project.json'])).toEqual({ id: 'p', n: 2 })
    // The tmp file of the atomic write is gone.
    expect(await exists(root, ['projects', 'p', 'project.json.tmp'])).toBe(false)

    await writeBlob(root, ['media', 'm', 'a.bin'], new Uint8Array([1, 2, 3]))
    expect(await exists(root, ['media', 'm', 'a.bin'])).toBe(true)
    await removeEntry(root, ['media', 'm'], { recursive: true })
    expect(await exists(root, ['media', 'm', 'a.bin'])).toBe(false)
  })

  it('reports the engine’s project writes, which the adapter forwards as drafts', async () => {
    const workspace = new VirtualWorkspace()
    setWorkspaceRoot(workspace.handle())
    const writes: string[] = []
    workspace.onWrite((path) => writes.push(path.join('/')))
    const project = createProjectObject(
      { name: 'Surf', width: 1920, height: 1080, fps: 30 },
      'fl-p',
    )
    await createProject(project)
    await updateProject('fl-p', { name: 'Surf edit' })
    expect(writes).toContain('projects/fl-p/project.json')
    expect((await getProject('fl-p'))?.name).toBe('Surf edit')
    setWorkspaceRoot(null)
  })

  it('moves a file into the directory it is given, not beside itself', async () => {
    const workspace = new VirtualWorkspace()
    const root = workspace.handle()
    await writeBlob(root, ['a', 'clip.bin'], new Uint8Array([7]))
    const from = await root.getDirectoryHandle('a')
    const to = await root.getDirectoryHandle('b', { create: true })
    const file = (await from.getFileHandle('clip.bin')) as FileSystemFileHandle & {
      move(parent: FileSystemDirectoryHandle, name: string): Promise<void>
    }
    const writes: string[] = []
    workspace.onWrite((path) => writes.push(path.join('/')))

    await file.move(to, 'moved.bin')

    expect(await exists(root, ['a', 'clip.bin'])).toBe(false)
    expect(await exists(root, ['a', 'moved.bin'])).toBe(false)
    expect(await exists(root, ['b', 'moved.bin'])).toBe(true)
    expect(writes).toEqual(['b/moved.bin'])
  })

  it('fetches a lazy file only when it is read, and a later write wins', async () => {
    const workspace = new VirtualWorkspace()
    const load = vi.fn(async () => new Blob(['remote']))
    workspace.putLazyFile(['media', 'a', 'clip.mp4'], load, 'video/mp4')
    expect(load).not.toHaveBeenCalled()
    expect(await workspace.readText(['media', 'a', 'clip.mp4'])).toBe('remote')
    expect(load).toHaveBeenCalledTimes(1)
    expect(await workspace.readText(['media', 'a', 'clip.mp4'])).toBe('remote')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('refuses every operation after dispose, as a revoked folder would', async () => {
    const workspace = new VirtualWorkspace()
    const root = workspace.handle()
    await writeJsonAtomic(root, ['index.json'], {})
    workspace.dispose()
    await expect(root.getDirectoryHandle('projects', { create: true })).rejects.toMatchObject({
      name: 'NotAllowedError',
    })
    expect(await workspace.readText(['index.json'])).toBeNull()
    expect(() => workspace.putFile([], 'seed')).toThrow(
      new DOMException('The Studio workspace was released', 'NotAllowedError'),
    )
    expect(() => workspace.putLazyFile(Array<string>(1), vi.fn())).toThrow(
      new DOMException('The Studio workspace was released', 'NotAllowedError'),
    )
    expect(await workspace.readFile([])).toBeNull()
  })

  it('fills the idle-callback gap Safari leaves', async () => {
    const scope: Record<string, unknown> = {}
    installBrowserShims(scope as typeof globalThis)
    const ran = await new Promise<boolean>((resolve) =>
      (scope.requestIdleCallback as (callback: IdleRequestCallback) => number)((deadline) =>
        resolve(deadline.timeRemaining() >= 0),
      ),
    )
    expect(ran).toBe(true)
  })
})
