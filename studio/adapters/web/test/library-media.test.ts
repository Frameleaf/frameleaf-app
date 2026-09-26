import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { MediaMetadata } from '@/types/storage'
import type { TimelineItem } from '@/types/timeline'
import type { Project } from '@/types/project'
import {
  associateMediaWithProject,
  createMedia,
  createProject,
  getMediaForProject,
  getProject,
  getProjectMediaIds,
} from '@/infrastructure/storage'
import { projectJsonPath } from '@/infrastructure/storage/workspace-fs/paths'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { createProjectObject } from '@/features/projects/utils/project-helpers'
import { validateProjectMediaReferences } from '@/features/timeline/utils/media-validation'
import type { StudioAssetRef } from '@frameleaf/host/host-contract'
import { createLibraryMediaSeeder, followRetiredImports } from '../src/library-media'
import { VirtualWorkspace } from '../src/virtual-workspace'

// Folder handles for imported files live in IndexedDB, which jsdom does not have; none are used here.
vi.mock('@/infrastructure/storage/handles-db', () => ({
  getHandle: vi.fn(async () => undefined),
  saveHandle: vi.fn(async () => undefined),
  deleteHandle: vi.fn(async () => undefined),
}))

// Freecut's media library service answers `getMediaForProject` straight from storage
// (`media-library-service.ts`); the orphaned-clip check reads it through this loader. The rest of the
// service (workers, probing) is not needed to decide which clips are orphaned.
vi.mock('@/features/timeline/deps/media-library-service', async () => {
  const storage = await import('@/infrastructure/storage')
  return {
    importMediaLibraryService: async () => ({
      mediaLibraryService: { getMediaForProject: storage.getMediaForProject },
    }),
  }
})

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

const LIBRARY = '0198a1c2-0000-7000-8000-00000000000a'
const IMPORTED = 'b7c1d2e3-0000-4000-8000-000000000001'
const UNUSED = 'b7c1d2e3-0000-4000-8000-000000000002'
const LATE = 'b7c1d2e3-0000-4000-8000-000000000003'

const libraryAsset: StudioAssetRef = {
  id: LIBRARY,
  kind: 'image',
  name: 'summit.jpg',
  duration: null,
  thumbnailUrl: '/api/assets/a/thumbnail',
  previewUrl: '/api/assets/a/thumbnail?size=preview',
  playbackUrl: null,
  isOffline: false,
  width: 4000,
  height: 3000,
  mimeType: 'image/jpeg',
}

/** A file the person imported inside the editor, as Freecut's importer records it. */
const imported = (id: string, fileName: string): MediaMetadata => ({
  id,
  storageType: 'workspace',
  fileName,
  fileSize: 1024,
  mimeType: 'video/mp4',
  duration: 4,
  width: 1920,
  height: 1080,
  fps: 30,
  codec: 'avc1.64002a',
  bitrate: 1,
  tags: [],
  createdAt: 0,
  updatedAt: 0,
})

const clip = (id: string, mediaId: string, type: 'video' | 'image', from: number) =>
  ({
    id,
    type,
    trackId: 'track-v1',
    mediaId,
    label: id,
    from,
    durationInFrames: 60,
  }) as unknown as TimelineItem

const clips = [
  clip('clip-library', LIBRARY, 'image', 0),
  clip('clip-imported', IMPORTED, 'video', 60),
]

const graphWith = (id: string): Project => {
  const project = createProjectObject({ name: 'Surf', width: 1920, height: 1080, fps: 30 }, id)
  return {
    ...project,
    timeline: { tracks: [], items: clips, transitions: [], keyframes: [] },
  } as unknown as Project
}

/** Let the write listener's relinking finish. */
const eventually = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return false
}

/**
 * FL-174: media the person imports inside the editor (not from the library) follows the editor from
 * one mount to the next. Each remount reads the host's graph under a new Freecut project id
 * (`<id>-m<n>`); without its links, the bin loses the import and Freecut's orphaned-clip check at load
 * is left to guess.
 */
describe('library media across editor remounts', () => {
  let workspace: VirtualWorkspace

  beforeEach(() => {
    workspace = new VirtualWorkspace()
    setWorkspaceRoot(workspace.handle())
    // Library thumbnails and previews are not served here; the bin falls back to placeholders.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setWorkspaceRoot(null)
    workspace.dispose()
  })

  it('keeps a locally imported clip on the new mount without an orphaned-clip prompt', async () => {
    let current = 'fl-p'
    const media = createLibraryMediaSeeder({
      workspace,
      projectId: () => current,
      onChange: () => undefined,
    })
    await media.seed([libraryAsset])
    await createProject(graphWith('fl-p'))
    // Freecut's importer: the record, then the link to the project the editor has open.
    await createMedia(imported(IMPORTED, 'wave.mp4'))
    await associateMediaWithProject('fl-p', IMPORTED)
    await createMedia(imported(UNUSED, 'b-roll.mp4'))
    await associateMediaWithProject('fl-p', UNUSED)

    // A remount (`remount` in editor-frame.tsx): the same graph under the new mount's id, then the links.
    current = 'fl-p-m1'
    workspace.putFile(
      projectJsonPath(current),
      JSON.stringify({ ...graphWith('fl-p'), id: current }, null, 2),
    )
    expect(await getProject(current)).toBeTruthy()
    await media.associate(current, 'fl-p')

    // Linked before the new instance loads: the bin keeps the import, used or not.
    expect(await getProjectMediaIds(current)).toEqual(
      expect.arrayContaining([LIBRARY, IMPORTED, UNUSED]),
    )
    expect((await getMediaForProject(current)).map((entry) => entry.id)).toEqual(
      expect.arrayContaining([LIBRARY, IMPORTED, UNUSED]),
    )
    // The check `loadTimeline` runs after a load: nothing is orphaned, so no prompt opens.
    expect(
      await validateProjectMediaReferences({
        rootItems: clips,
        compositions: [],
        projectId: current,
      }),
    ).toEqual([])

    // And again on the next remount, from the mount before it.
    current = 'fl-p-m2'
    workspace.putFile(
      projectJsonPath(current),
      JSON.stringify({ ...graphWith('fl-p'), id: current }, null, 2),
    )
    await media.associate(current, 'fl-p-m1')
    expect(await getProjectMediaIds(current)).toEqual(
      expect.arrayContaining([LIBRARY, IMPORTED, UNUSED]),
    )
    expect(
      await validateProjectMediaReferences({
        rootItems: clips,
        compositions: [],
        projectId: current,
      }),
    ).toEqual([])
    media.dispose()
  })

  it('carries an import the replaced instance finishes after the remount, and only that', async () => {
    const media = createLibraryMediaSeeder({
      workspace,
      projectId: () => 'fl-p-m1',
      onChange: () => undefined,
    })
    const associate = vi.spyOn(media, 'associate')
    const onError = vi.fn()
    const stop = followRetiredImports({
      workspace,
      media,
      retired: new Set(['fl-p']),
      current: () => 'fl-p-m1',
      onError,
    })

    // The old instance's import was still running: it links to the old mount's project.
    await createMedia(imported(LATE, 'late.mp4'))
    await associateMediaWithProject('fl-p', LATE)
    expect(await eventually(async () => (await getProjectMediaIds('fl-p-m1')).includes(LATE))).toBe(
      true,
    )
    expect(associate).toHaveBeenCalledWith('fl-p-m1', 'fl-p')

    // The current mount's own links are not replayed.
    associate.mockClear()
    await associateMediaWithProject('fl-p-m1', UNUSED)
    expect(associate).not.toHaveBeenCalled()

    stop()
    await associateMediaWithProject('fl-p', UNUSED)
    expect(associate).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    media.dispose()
  })
})
