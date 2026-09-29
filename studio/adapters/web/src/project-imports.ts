/**
 * Files imported or recorded inside the editor are kept with the project (FL-103, FL-105).
 *
 * Freecut keeps an imported file, a microphone take or a generated voice or music file in its
 * workspace as `media/{id}/{fileName}`, beside `metadata.json` and a thumbnail. In Frameleaf that
 * workspace lives in the frame's memory, so without this the file would be gone at the next load.
 * Every new source file under an id the host did not give is sent to the host, which keeps it with
 * the stored project under the same id; the clips that place it by that id resolve on the server
 * (as a declared project import) and on the next load (the host offers it back).
 *
 * Library, restored and generated media, and files the host already keeps, are never sent: they are
 * `known` to the bin. A file the server refuses (a script in an SVG, a type it cannot place) stays in
 * this editor for now and the person is told it will not be kept.
 */
import type { StudioProjectImportRef, StudioProjectImportUpload } from '@frameleaf/host/host-contract'
import type { LibraryMediaSeeder } from './library-media'
import type { VirtualWorkspace } from './virtual-workspace'

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
/** Workspace files beside a media source that are not the source itself. */
const SIDE_FILES = new Set(['metadata.json', 'thumbnail.jpg'])

/** The media id of a source file write, or null when the write is anything else. */
export const importedSourceId = (path: readonly string[]): string | null =>
  path.length === 3 && path[0] === 'media' && UUID.test(path[1]!) && !SIDE_FILES.has(path[2]!)
    ? path[1]!
    : null

export interface LocalImportWatch {
  /** Stop watching. */
  stop(): void
  /**
   * Send every file this document holds that is not kept yet: the ones imported before the project
   * was first saved, or while the host could not take them. Quiet: a refusal was already reported.
   */
  retry(): Promise<void>
}

export function watchLocalImports(options: {
  workspace: VirtualWorkspace
  media: Pick<LibraryMediaSeeder, 'known' | 'kept'>
  upload: (upload: StudioProjectImportUpload) => Promise<StudioProjectImportRef>
  /** Tell the person a file will not be kept, with the server's reason. */
  refused: (fileName: string, reason: string) => void
}): LocalImportWatch {
  const { workspace, media, upload, refused } = options
  const sending = new Set<string>()
  /** Refused by the host once; a retry sends it again but does not report it twice. */
  const reported = new Set<string>()
  const send = (id: string, fileName: string, file: File) => {
    if (media.known(id) || sending.has(id)) return Promise.resolve()
    sending.add(id)
    return upload({ id: id.toLowerCase(), fileName, file })
      .then(() => {
        media.kept(id)
        reported.delete(id)
      })
      .catch((error: unknown) => {
        if (reported.has(id)) return
        reported.add(id)
        refused(fileName, error instanceof Error ? error.message : String(error))
      })
      .finally(() => sending.delete(id))
  }
  const stop = workspace.onWrite((path, file) => {
    const id = importedSourceId(path)
    if (id) void send(id, file.name || path[2]!, file)
  })
  return {
    stop,
    async retry() {
      for (const entry of workspace.list(['media'])) {
        if (entry.kind !== 'directory' || media.known(entry.name) || sending.has(entry.name)) continue
        const source = workspace
          .list(['media', entry.name])
          .find((child) => child.kind === 'file' && importedSourceId(['media', entry.name, child.name]))
        if (!source) continue
        const file = await workspace.readFile(['media', entry.name, source.name])
        if (file) await send(entry.name, source.name, file)
      }
    },
  }
}
