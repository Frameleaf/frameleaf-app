/**
 * Freecut's workspace-fs test double, answered by the adapter's host-backed workspace (FL-91).
 *
 * Freecut's own storage tests build their workspace with `./__tests__/in-memory-handle`. In the
 * adapter's test run every import of that module resolves here instead (see `vite.config.mjs`), so
 * those suites exercise {@link VirtualWorkspace}, the workspace the editor really runs on in
 * Frameleaf, rather than Freecut's mock.
 *
 * The exports keep the upstream module's names and signatures. Each `MemDir` and `MemFileHandle`
 * is a thin view of a virtual workspace handle: storage, blobs, writables, listing and removal are
 * all the workspace's. The view adds only what the upstream double lets a test ask for: a root
 * whose `move()` rejects the way some Chromium builds do, and a `MemFileHandle.prototype.move` a
 * test can spy on.
 */
import { VirtualWorkspace } from '../../src/virtual-workspace'

export type MoveFailure = 'NotSupportedError' | 'NoModificationAllowedError'

type Entry = MemDir | MemFileHandle

const wrap = (handle: FileSystemHandle, parent: MemDir): Entry =>
  handle.kind === 'directory'
    ? MemDir.view(handle as FileSystemDirectoryHandle, parent.moveFailure)
    : new MemFileHandle(handle as FileSystemFileHandle, parent)

export class MemDir {
  readonly kind = 'directory' as const
  readonly inner: FileSystemDirectoryHandle
  private readonly label: string

  /** A new, empty virtual workspace whose root is this directory. */
  constructor(
    name: string,
    public moveFailure: MoveFailure | null = null,
  ) {
    this.inner = new VirtualWorkspace().handle()
    this.label = name
  }

  /** A view of an existing directory of a virtual workspace. */
  static view(inner: FileSystemDirectoryHandle, moveFailure: MoveFailure | null): MemDir {
    const dir = Object.create(MemDir.prototype) as MemDir
    Object.assign(dir, { kind: 'directory', inner, label: inner.name, moveFailure })
    return dir
  }

  get name(): string {
    return this.label
  }

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<MemDir> {
    return MemDir.view(await this.inner.getDirectoryHandle(name, options), this.moveFailure)
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<MemFileHandle> {
    return new MemFileHandle(await this.inner.getFileHandle(name, options), this)
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    await this.inner.removeEntry(name, options)
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other instanceof MemDir && (await this.inner.isSameEntry(other.inner))
  }

  async *entries(): AsyncIterableIterator<[string, Entry]> {
    for await (const [name, handle] of (this.inner as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
      yield [name, wrap(handle, this)]
    }
  }

  async *values(): AsyncIterableIterator<Entry> {
    for await (const [, entry] of this.entries()) yield entry
  }

  async *keys(): AsyncIterableIterator<string> {
    for await (const [name] of this.entries()) yield name
  }

  [Symbol.asyncIterator]() {
    return this.entries()
  }
}

export class MemFileHandle {
  readonly kind = 'file' as const

  constructor(
    readonly inner: FileSystemFileHandle,
    private readonly parent: MemDir,
  ) {}

  get name(): string {
    return this.inner.name
  }

  getFile(): Promise<File> {
    return this.inner.getFile()
  }

  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream> {
    return this.inner.createWritable(options)
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other instanceof MemFileHandle && (await this.inner.isSameEntry(other.inner))
  }

  /** Always present, as in Chromium; rejects when the root was created with a `moveFailure`. */
  async move(newParent: MemDir, newName: string): Promise<void> {
    if (this.parent.moveFailure) {
      throw new DOMException(
        'The implementation did not support the requested type of object or operation.',
        this.parent.moveFailure,
      )
    }
    const target = newParent instanceof MemDir ? newParent.inner : newParent
    await (
      this.inner as unknown as {
        move(parent: FileSystemDirectoryHandle, name: string): Promise<void>
      }
    ).move(target, newName)
  }
}

export function createRoot(name = 'workspace', moveFailure: MoveFailure | null = null): MemDir {
  return new MemDir(name, moveFailure)
}

/** The view is the handle the storage layer is given; everything it does reaches the workspace. */
export function asHandle(dir: MemDir): FileSystemDirectoryHandle {
  return dir as unknown as FileSystemDirectoryHandle
}

/** Read a file's text from the workspace. Null if missing. */
export async function readFileText(root: MemDir, ...segments: string[]): Promise<string | null> {
  let dir = root
  for (const segment of segments.slice(0, -1)) {
    try {
      dir = await dir.getDirectoryHandle(segment)
    } catch {
      return null
    }
  }
  try {
    const file = await dir.getFileHandle(segments[segments.length - 1]!)
    return await (await file.getFile()).text()
  } catch {
    return null
  }
}
