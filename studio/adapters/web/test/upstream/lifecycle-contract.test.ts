import { describe, expect, it, vi } from 'vite-plus/test'
import type { Project } from '@/types/project'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { createProject, getProject, updateProject } from '@/infrastructure/storage'
import {
  isProjectTrashed,
  restoreProject,
  softDeleteProject,
} from '@/infrastructure/storage/workspace-fs/trash'
import { createProjectObject } from '@/features/projects/utils/project-helpers'
// Freecut's headless contract, exactly as its headless server enforces it.
import { capabilities, projectSaveRequestSchema } from '../../../../engine/headless/lib/contract.mjs'
import { VirtualWorkspace } from '../../src/virtual-workspace'

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

vi.mock('@/infrastructure/storage/handles-db', () => ({
  getHandle: vi.fn(async () => undefined),
  saveHandle: vi.fn(async () => undefined),
  deleteHandle: vi.fn(async () => undefined),
}))

/** What the adapter forwards to the host as a draft: the project document the engine last wrote. */
const forwarded = (workspace: VirtualWorkspace, projectId: string) => {
  const drafts: unknown[] = []
  workspace.onWrite((path, file) => {
    if (path.join('/') === `projects/${projectId}/project.json`) {
      void file.text().then((text) => drafts.push(JSON.parse(text)))
    }
  })
  return drafts
}

const satisfiesHeadlessContract = (project: unknown) =>
  projectSaveRequestSchema.safeParse({ project, force: true }) as {
    success: boolean
    error?: { issues: unknown[] }
  }

/**
 * FL-91: Freecut's portable headless lifecycle contract (`headless/lib/contract.mjs`, the
 * `extra.portable-headless` row) against the adapter's workspace. A project the engine keeps in the
 * virtual workspace, and hands the host as its graph, is a document the headless contract accepts,
 * through Freecut's own create, edit, trash and restore.
 */
describe('Freecut lifecycle contract on the virtual workspace', () => {
  it('keeps every project the engine writes, with its sequences, inside the headless contract', async () => {
    const workspace = new VirtualWorkspace()
    setWorkspaceRoot(workspace.handle())
    const drafts = forwarded(workspace, 'fl-life')

    await createProject(createProjectObject({ name: 'Lake', width: 1920, height: 1080, fps: 30 }, 'fl-life'))
    const timeline: NonNullable<Project['timeline']> = {
      tracks: [
        {
          id: 't1',
          name: 'V1',
          height: 60,
          locked: false,
          visible: true,
          muted: false,
          solo: false,
          order: 0,
        },
      ],
      items: [
        {
          id: 'clip-1',
          type: 'composition',
          trackId: 't1',
          from: 0,
          durationInFrames: 30,
          label: 'Intro',
          compositionId: 'seq-b',
        },
      ],
      topLevelSequenceIds: ['seq-b'],
      compositions: [
        {
          id: 'seq-b',
          name: 'B',
          editorKind: 'sequence',
          items: [],
          tracks: [],
          fps: 30,
          width: 1920,
          height: 1080,
          durationInFrames: 30,
        },
      ],
    }
    await updateProject('fl-life', { name: 'Lake edit', timeline })
    await vi.waitFor(() => expect(drafts.length).toBeGreaterThanOrEqual(2))

    for (const draft of drafts) {
      const checked = satisfiesHeadlessContract(draft)
      expect(checked.success, JSON.stringify(checked.error?.issues)).toBe(true)
    }
    const last = drafts.at(-1) as Project
    expect(last.name).toBe('Lake edit')
    expect(last.timeline?.compositions?.[0]?.id).toBe('seq-b')

    // Freecut's own trash: the document survives a soft delete and comes back unchanged.
    const before = await workspace.readText(['projects', 'fl-life', 'project.json'])
    await softDeleteProject('fl-life')
    expect(await isProjectTrashed('fl-life')).toBe(true)
    await restoreProject('fl-life')
    expect(await isProjectTrashed('fl-life')).toBe(false)
    expect(await workspace.readText(['projects', 'fl-life', 'project.json'])).toBe(before)
    expect(satisfiesHeadlessContract(await getProject('fl-life')).success).toBe(true)
    setWorkspaceRoot(null)
  })

  it('publishes the lifecycle limits the host relies on', () => {
    const { lifecycle } = capabilities() as {
      lifecycle: { deleteProject: boolean; writerMode: string; httpMediaUpload: boolean }
    }
    // Deleting and uploading go through Frameleaf (trash with retention, library upload), never the
    // engine; one writer at a time is what the host's lease enforces.
    expect(lifecycle.deleteProject).toBe(false)
    expect(lifecycle.httpMediaUpload).toBe(false)
    expect(lifecycle.writerMode).toBe('exclusive')
  })
})
