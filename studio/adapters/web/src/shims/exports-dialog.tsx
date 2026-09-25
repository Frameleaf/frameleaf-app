/**
 * Freecut's list of finished exports, answered by Activity (FL-88, FL-104).
 *
 * Stands in for `@/features/export/components/exports-dialog` in the adapter build: exports are
 * Frameleaf jobs, followed and downloaded in Activity, never files in the editor's workspace.
 */
import { useEffect } from 'react'
import { post } from '../host-port'

export interface ExportsDialogProps {
  open: boolean
  onClose: () => void
  projectId: string
}

export function ExportsDialog({ open, onClose }: ExportsDialogProps) {
  useEffect(() => {
    if (!open) return
    post({ type: 'navigate', target: { kind: 'activity' } })
    onClose()
  }, [open, onClose])
  return null
}
