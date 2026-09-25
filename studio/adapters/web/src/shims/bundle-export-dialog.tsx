/**
 * Freecut's project bundle export, answered by Frameleaf's portable bundles (FL-88, FL-91).
 *
 * Stands in for `@/features/project-bundle/components/bundle-export-dialog` in the adapter build.
 * The editor's "Export project" becomes the canonical `project.exportBundle` command, which the host
 * answers with its own dialog (whether to include copies of owned media) and a durable bundle job
 * written from the stored revision, followed in Activity. Nothing is zipped in the browser and no
 * file picker opens.
 */
import { useEffect } from 'react'
import { call } from '../host-port'

export interface BundleExportDialogProps {
  open: boolean
  onClose: () => void
  projectId: string
  onBeforeExport?: () => Promise<void>
  fileHandle?: FileSystemFileHandle
}

export function BundleExportDialog({ open, onClose, onBeforeExport }: BundleExportDialogProps) {
  useEffect(() => {
    if (!open) return
    onClose()
    void (async () => {
      // The editor saves first, so the bundle is written from what the person sees.
      await onBeforeExport?.().catch(() => undefined)
      await call('submitCommands', [
        {
          id: 'project.exportBundle',
          payload: {},
          revision: 0,
          idempotencyKey: crypto.randomUUID(),
          issuedAt: Date.now(),
        },
      ]).catch(() => undefined)
    })()
  }, [open, onClose, onBeforeExport])
  return null
}
