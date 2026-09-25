/**
 * A host-backed workspace for Freecut's storage layer (FL-88, FL-96).
 *
 * Freecut keeps everything in a folder the person picks with the File System Access API
 * (`infrastructure/storage/workspace-fs`, gated by `features/workspace-gate`). Frameleaf cannot use
 * that: Safari and Firefox have no directory picker, and the project already lives in Frameleaf's
 * own revisioned storage. So the adapter hands `setWorkspaceRoot` this in-memory implementation of
 * the handle surface `fs-primitives.ts` uses — `getDirectoryHandle`, `getFileHandle`, `getFile`,
 * `createWritable`, `removeEntry`, `values`/`entries`/`keys` and `move` — and nothing in the
 * vendored engine changes.
 *
 * - It needs no browser storage API at all, so the editor works the same in every browser.
 * - Writes are observable. The adapter watches `projects/{id}/project.json` and forwards the
 *   engine's autosave to the host as a draft, which the host stores as a revision (FL-89).
 * - Library media is never copied in. A media source may be a *lazy* file whose bytes are fetched
 *   from an URL the host already authorized, only if something reads them.
 * - Everything lives in the frame's memory and goes with it, which is what `dispose` relies on.
 */

type Node = DirectoryNode | FileNode

interface DirectoryNode {
  kind: 'directory'
  name: string
  children: Map<string, Node>
}

interface FileNode {
  kind: 'file'
  name: string
  /** Bytes, or a loader for a lazy remote file that has not been read yet. */
  data: Blob | null
  load: (() => Promise<Blob>) | null
  type: string
  lastModified: number
}

export type WorkspaceWriteListener = (path: readonly string[], file: File) => void

const notFound = (name: string) => new DOMException(`${name} was not found`, 'NotFoundError')
const typeMismatch = (name: string) =>
  new DOMException(`${name} is not the expected kind`, 'TypeMismatchError')

const assertName = (name: string) => {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new TypeError(`Invalid workspace entry name: ${name}`)
  }
}

const mimeFor = (name: string): string => {
  if (name.endsWith('.json')) return 'application/json'
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.webp')) return 'image/webp'
  return ''
}

type WriteChunk =
  | Blob
  | BufferSource
  | string
  | { type: 'write'; position?: number; data: Blob | BufferSource | string }
  | { type: 'seek'; position: number }
  | { type: 'truncate'; size: number }

async function toBytes(data: Blob | BufferSource | string): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0))
  const view = data as ArrayBufferView
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
}

export class VirtualWorkspace {
  readonly root: DirectoryNode = {
    kind: 'directory',
    name: 'frameleaf-studio',
    children: new Map(),
  }
  private readonly listeners = new Set<WorkspaceWriteListener>()
  private disposed = false

  onWrite(listener: WorkspaceWriteListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The handle Freecut's storage layer is given. */
  handle(): FileSystemDirectoryHandle {
    return this.directoryHandle(this.root, [])
  }

  /** Put a file whose bytes are fetched only when first read. */
  putLazyFile(path: readonly string[], load: () => Promise<Blob>, type = ''): void {
    const { parent, name } = this.parentOf(path, true)
    parent.children.set(name, {
      kind: 'file',
      name,
      data: null,
      load,
      type,
      lastModified: Date.now(),
    })
  }

  /** Put bytes directly, without notifying write listeners (seeding, not an engine write). */
  putFile(path: readonly string[], data: Blob | string): void {
    const { parent, name } = this.parentOf(path, true)
    const blob = typeof data === 'string' ? new Blob([data], { type: mimeFor(name) }) : data
    parent.children.set(name, {
      kind: 'file',
      name,
      data: blob,
      load: null,
      type: blob.type,
      lastModified: Date.now(),
    })
  }

  async readText(path: readonly string[]): Promise<string | null> {
    try {
      const { parent, name } = this.parentOf(path, false)
      const node = parent.children.get(name)
      if (!node || node.kind !== 'file') return null
      return await (await this.materialize(node)).text()
    } catch {
      return null
    }
  }

  /** Drop every node and listener; later handle calls fail as a revoked permission would. */
  dispose(): void {
    this.disposed = true
    this.root.children.clear()
    this.listeners.clear()
  }

  private assertLive() {
    if (this.disposed) {
      throw new DOMException('The Studio workspace was released', 'NotAllowedError')
    }
  }

  private parentOf(
    path: readonly string[],
    create: boolean,
  ): { parent: DirectoryNode; name: string } {
    if (path.length === 0) throw new TypeError('Empty workspace path')
    let directory = this.root
    for (const segment of path.slice(0, -1)) {
      assertName(segment)
      let next = directory.children.get(segment)
      if (!next) {
        if (!create) throw notFound(segment)
        next = { kind: 'directory', name: segment, children: new Map() }
        directory.children.set(segment, next)
      }
      if (next.kind !== 'directory') throw typeMismatch(segment)
      directory = next
    }
    const name = path[path.length - 1]
    assertName(name)
    return { parent: directory, name }
  }

  private async materialize(node: FileNode): Promise<Blob> {
    if (node.data) return node.data
    if (!node.load) return new Blob([], { type: node.type })
    const blob = await node.load()
    // A write that landed while the fetch was in flight wins over the remote bytes.
    if (!node.data) {
      node.data = blob
      node.load = null
    }
    return node.data
  }

  private emit(path: readonly string[], file: File) {
    for (const listener of this.listeners) {
      try {
        listener(path, file)
      } catch {
        // A listener's failure must not fail the engine's write.
      }
    }
  }

  private directoryHandle(node: DirectoryNode, path: readonly string[]): FileSystemDirectoryHandle {
    const workspace = this
    const handle = {
      kind: 'directory' as const,
      name: node.name,
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        workspace.assertLive()
        assertName(name)
        let child = node.children.get(name)
        if (!child) {
          if (!options?.create) throw notFound(name)
          child = { kind: 'directory', name, children: new Map() }
          node.children.set(name, child)
        }
        if (child.kind !== 'directory') throw typeMismatch(name)
        return workspace.directoryHandle(child, [...path, name])
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        workspace.assertLive()
        assertName(name)
        let child = node.children.get(name)
        if (!child) {
          if (!options?.create) throw notFound(name)
          child = {
            kind: 'file',
            name,
            data: new Blob([], { type: mimeFor(name) }),
            load: null,
            type: mimeFor(name),
            lastModified: Date.now(),
          }
          node.children.set(name, child)
        }
        if (child.kind !== 'file') throw typeMismatch(name)
        return workspace.fileHandle(child, node, [...path, name])
      },
      async removeEntry(name: string, options?: { recursive?: boolean }) {
        workspace.assertLive()
        const child = node.children.get(name)
        if (!child) throw notFound(name)
        if (child.kind === 'directory' && child.children.size > 0 && !options?.recursive) {
          throw new DOMException(`${name} is not empty`, 'InvalidModificationError')
        }
        node.children.delete(name)
      },
      async resolve() {
        return null
      },
      async isSameEntry(other: unknown) {
        return other === handle
      },
      async queryPermission() {
        return workspace.disposed ? 'denied' : 'granted'
      },
      async requestPermission() {
        return workspace.disposed ? 'denied' : 'granted'
      },
      async *entries() {
        workspace.assertLive()
        for (const [name, child] of [...node.children.entries()]) {
          yield [
            name,
            child.kind === 'directory'
              ? workspace.directoryHandle(child, [...path, name])
              : workspace.fileHandle(child, node, [...path, name]),
          ] as const
        }
      },
      async *values() {
        for await (const [, value] of handle.entries()) yield value
      },
      async *keys() {
        for await (const [name] of handle.entries()) yield name
      },
      [Symbol.asyncIterator]() {
        return handle.entries()
      },
    }
    return handle as unknown as FileSystemDirectoryHandle
  }

  private fileHandle(
    node: FileNode,
    parent: DirectoryNode,
    path: readonly string[],
  ): FileSystemFileHandle {
    const workspace = this
    let location = path
    const owner = parent
    const handle = {
      kind: 'file' as const,
      get name() {
        return node.name
      },
      async getFile() {
        workspace.assertLive()
        const blob = await workspace.materialize(node)
        return new File([blob], node.name, {
          type: blob.type || node.type,
          lastModified: node.lastModified,
        })
      },
      async createWritable(options?: { keepExistingData?: boolean }) {
        workspace.assertLive()
        let bytes = options?.keepExistingData
          ? new Uint8Array(await (await workspace.materialize(node)).arrayBuffer())
          : new Uint8Array(0)
        let position = 0
        let closed = false
        const writeAt = (chunk: Uint8Array, at: number) => {
          const end = at + chunk.byteLength
          if (end > bytes.byteLength) {
            const grown = new Uint8Array(end)
            grown.set(bytes)
            bytes = grown
          }
          bytes.set(chunk, at)
          position = end
        }
        return {
          async write(chunk: WriteChunk) {
            if (closed) throw new TypeError('The writable is closed')
            if (chunk && typeof chunk === 'object' && 'type' in chunk && !(chunk instanceof Blob)) {
              if (chunk.type === 'seek') {
                position = chunk.position
                return
              }
              if (chunk.type === 'truncate') {
                bytes = bytes.slice(0, chunk.size)
                if (bytes.byteLength < chunk.size) {
                  const grown = new Uint8Array(chunk.size)
                  grown.set(bytes)
                  bytes = grown
                }
                position = Math.min(position, chunk.size)
                return
              }
              writeAt(await toBytes(chunk.data), chunk.position ?? position)
              return
            }
            writeAt(await toBytes(chunk as Blob | BufferSource | string), position)
          },
          async seek(at: number) {
            position = at
          },
          async truncate(size: number) {
            bytes = bytes.slice(0, size)
          },
          async abort() {
            closed = true
          },
          async close() {
            if (closed) return
            closed = true
            workspace.assertLive()
            const blob = new Blob([bytes], { type: node.type || mimeFor(node.name) })
            node.data = blob
            node.load = null
            node.lastModified = Date.now()
            workspace.emit(location, new File([blob], node.name, { type: blob.type }))
          },
        }
      },
      async move(target: FileSystemDirectoryHandle | string, newName?: string) {
        workspace.assertLive()
        // Only moves within the same directory are needed (writeJsonAtomic's tmp → target rename).
        const name = typeof target === 'string' ? target : (newName ?? node.name)
        assertName(name)
        owner.children.delete(node.name)
        node.name = name
        owner.children.set(name, node)
        location = [...location.slice(0, -1), name]
        if (node.data) {
          workspace.emit(location, new File([node.data], name, { type: node.data.type }))
        }
      },
      async isSameEntry(other: unknown) {
        return other === handle
      },
      async queryPermission() {
        return workspace.disposed ? 'denied' : 'granted'
      },
      async requestPermission() {
        return workspace.disposed ? 'denied' : 'granted'
      },
    }
    return handle as unknown as FileSystemFileHandle
  }
}
