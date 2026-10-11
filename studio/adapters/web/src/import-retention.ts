import type {
  ProcessingProvenanceInput,
  StudioProjectImportRef,
  StudioProjectImportUpload,
} from '@frameleaf/host/host-contract'
import { writeBlob } from '@/infrastructure/storage/workspace-fs/fs-primitives'
import type { LocalImportWatch } from './project-imports'
import type { VirtualWorkspace } from './virtual-workspace'

export type CompletionUpload = StudioProjectImportUpload & {
  publicationId: string
  processingProvenance: ProcessingProvenanceInput
}

export interface CompletionRetention {
  hold(id: string): Promise<void>
  complete(upload: CompletionUpload): Promise<StudioProjectImportRef>
  cancel(id: string): void
  dispose(): void
}

/** Ephemeral suppression only; the host owns registration, receipts and durable recovery. */
export function createCompletionRetention(options: {
  workspace: VirtualWorkspace
  watch: Pick<LocalImportWatch, 'hold'>
  current: () => boolean
  upload: (upload: CompletionUpload) => Promise<StudioProjectImportRef>
  kept: (id: string) => void
}): CompletionRetention {
  const held = new Set<string>()
  const cancelled = new Set<string>()
  const submitted = new Set<string>()
  let disposed = false
  const assertCurrent = () => {
    if (disposed || !options.current()) throw new Error('origin_retired')
  }
  return {
    async hold(id) {
      assertCurrent()
      id = id.toLowerCase()
      if (held.has(id)) throw new Error('completion_already_held')
      options.watch.hold(id)
      held.add(id)
      await writeBlob(
        options.workspace.handle(),
        ['media', id, 'retention.json'],
        new TextEncoder().encode('{"version":1,"state":"held"}'),
      )
      assertCurrent()
    },
    async complete(upload) {
      assertCurrent()
      const id = upload.id.toLowerCase()
      if (!held.has(id) || cancelled.has(id)) throw new Error('completion_not_admitted')
      if (submitted.has(id)) throw new Error('completion_already_submitted')
      submitted.add(id)
      // A timeout is unknown. Never automatically resend or release the generic watcher.
      const imported = await options.upload(upload)
      if (!disposed && options.current() && !cancelled.has(id)) options.kept(id)
      return imported
    },
    cancel(id) {
      cancelled.add(id.toLowerCase())
    },
    dispose() {
      disposed = true
      held.clear()
      cancelled.clear()
      submitted.clear()
    },
  }
}
