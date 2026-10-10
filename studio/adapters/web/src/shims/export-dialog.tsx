/**
 * Freecut's Export, answered by Frameleaf's export path (FL-88, FL-104, FL-106).
 *
 * Freecut renders exports in the browser and saves them to the workspace folder. Frameleaf renders
 * on an admitted render worker, with the project's rights, sources and access checked on the server,
 * and follows the job in Activity. So this module stands in for
 * `@/features/export/components/export-dialog` in the adapter build (`vite.config.mjs`): the
 * editor's Export button and shortcut ask the host to open its own export dialog, and nothing is
 * rendered or saved inside the editor.
 */
import { useEffect } from 'react'
import { usePlaybackStore } from '@/shared/state/playback'
import { post } from '../host-port'

export interface ExportDialogProps {
  open: boolean
  onClose: () => void
  onOpenRenderQueue?: () => void
}

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  useEffect(() => {
    if (!open) return
    usePlaybackStore.getState().pause()
    post({ type: 'request-export', kind: 'video' })
    onClose()
  }, [open, onClose])
  return null
}
