import { expect, it, vi } from 'vite-plus/test'
import { createProjectObject } from '@/features/projects/utils/project-helpers'
import {
  hydrateTimelineStoresFromProject,
  buildTimelineFromStores,
} from '@/features/timeline/stores/timeline-persistence'
import { blobUrlManager } from '@/infrastructure/browser/blob-url-manager'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { createProject, getProject } from '@/infrastructure/storage'
import { projectJsonPath } from '@/infrastructure/storage/workspace-fs/paths'
import type { Project } from '@/types/project'
import {
  generatedMediaAlias,
  hydrateGeneratedMedia,
  storeGeneratedMedia,
  type StudioGeneratedMedia,
} from '@frameleaf/host/generated-media'
import { VirtualWorkspace } from '../src/virtual-workspace'
import { createLibraryMediaSeeder, initialMediaRecord } from '../src/library-media'
import { applyCanonicalCommands } from '../src/canonical-commands'

vi.mock('@/infrastructure/storage/handles-db', () => ({
  getHandle: vi.fn(async () => undefined),
  saveHandle: vi.fn(async () => undefined),
  deleteHandle: vi.fn(async () => undefined),
}))

const generatedId = 'reverse-0195e2a0-0000-7000-8000-000000000012'
const url = '/api/media-operations/0195e2a0-0000-7000-8000-000000000012/reverse-preview'
const admitted: StudioGeneratedMedia = {
  generatedId,
  id: generatedMediaAlias(generatedId),
  checksum: 'ab'.repeat(32),
  kind: 'video',
  name: 'reverse.mp4',
  duration: { num: 10, den: 1 },
  frameRate: { num: 30, den: 1 },
  width: 32,
  height: 32,
  mimeType: 'video/mp4',
  isOffline: false,
  thumbnailUrl: '',
  previewUrl: url,
  playbackUrl: url,
}

// jsdom's Blob lacks the modern methods the engine workspace uses.
if (!Blob.prototype.text)
  Blob.prototype.text = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsText(this)
    })
  }

it('loads the applied generated clip, binds its preview, saves/reopens through real engine stores and refuses a late read after revocation', async () => {
  const workspace = new VirtualWorkspace()
  setWorkspaceRoot(workspace.handle())
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Blob(['preview']), { status: 200 })),
  )
  const seeder = createLibraryMediaSeeder({
    workspace,
    projectId: () => 'generated-test',
    onChange: () => {},
  })
  const base = createProjectObject(
    { name: 'Reverse', width: 32, height: 32, fps: 30 },
    'generated-test',
  )
  const clip = {
    id: 'clip',
    type: 'video',
    generatedId,
    trackId: 'v1',
    label: 'Reverse',
    from: 10,
    durationInFrames: 30,
    sourceStart: 60,
    sourceEnd: 90,
    sourceDuration: 300,
    sourceFps: 30,
    trimStart: 60,
    trimEnd: 210,
    offset: 60,
    isReversed: false,
    transform: { opacity: 0.5 },
    effects: [],
  }
  const stored = {
    ...base,
    timeline: {
      tracks: [
        {
          id: 'v1',
          name: 'V1',
          kind: 'video',
          height: 80,
          locked: false,
          visible: true,
          muted: false,
          solo: false,
          order: 0,
        },
      ],
      items: [clip],
      transitions: [],
      keyframes: [],
    },
  } as unknown as Project
  try {
    await seeder.seed([admitted])
    expect(blobUrlManager.get(admitted.id)).toBe(url)
    const hydrated = hydrateGeneratedMedia(stored, [admitted]) as Project
    await createProject(hydrated)
    await hydrateTimelineStoresFromProject(hydrated)
    const timeline = buildTimelineFromStores()
    const saved = storeGeneratedMedia({ ...stored, timeline }) as Project
    expect(saved.timeline?.items[0]).toMatchObject(clip)
    expect(saved.timeline?.items[0]).not.toHaveProperty('mediaId')
    expect(saved.timeline?.items[0]).not.toHaveProperty('src')
    workspace.putFile(projectJsonPath(base.id), JSON.stringify(saved))
    const reopened = await getProject(base.id)
    const next = hydrateGeneratedMedia(reopened, [admitted]) as Project
    const outcome = await applyCanonicalCommands(
      next,
      [
        {
          id: 'clip.update',
          payload: { clipId: 'clip', patch: { name: 'Edited reverse' } },
          revision: 1,
          idempotencyKey: 'mute',
          issuedAt: 1,
        },
      ],
      [initialMediaRecord(admitted, 0)],
    )
    if (outcome.status !== 'applied') throw new Error(outcome.detail)
    expect(outcome.status).toBe('applied')
    const afterCommand = storeGeneratedMedia(outcome.project) as Project
    expect(afterCommand.timeline?.items[0]).toMatchObject({ ...clip, label: 'Edited reverse' })
    expect(JSON.stringify(afterCommand)).not.toContain('studio-generated:')
    expect(JSON.stringify(afterCommand)).not.toContain('/reverse-preview')

    let finish!: (blob: Blob) => void
    workspace.putLazyFile(
      ['late.mp4'],
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const handle = await workspace.handle().getFileHandle('late.mp4')
    const pending = handle.getFile()
    const rejected = expect(pending).rejects.toThrow('released')
    seeder.dispose()
    workspace.dispose()
    finish(new Blob(['late private bytes']))
    await rejected
    await expect(handle.getFile()).rejects.toThrow('released')
    expect(blobUrlManager.get(admitted.id)).toBeNull()
  } finally {
    seeder.dispose()
    workspace.dispose()
    setWorkspaceRoot(null)
    vi.unstubAllGlobals()
  }
})
