/**
 * Studio's Restore tab (FL-1822), answered by Frameleaf's Restore panel (FL-115, FL-162).
 *
 * Restoration runs on the server and is previewed, compared and saved in the host's own panel, so
 * this module stands in for `@/features/editor/restore-service` in the adapter build
 * (`vite.config.mjs`): the editor's Restore tab asks the host to open that panel.
 */
import { usePlaybackStore } from '@/shared/state/playback'
import { post } from '../host-port'

export const restoreAvailable: boolean = true

export function requestRestore(): void {
  usePlaybackStore.getState().pause()
  post({ type: 'request-restore' })
}
