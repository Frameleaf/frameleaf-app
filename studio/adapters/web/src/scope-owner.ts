import { usePreviewBridgeStore } from '@/shared/state/preview-bridge'
import { storeGeneratedMedia } from '@frameleaf/host/generated-media'
import { canonicalJson } from './canonical-commands'
import { acceptsWrite, type DraftSendState } from './draft-sync'

/** Compare edit pixels' graph inputs, excluding view state and generated resource URLs. */
export function scopeTimelineContent(timeline: unknown): string | null {
  if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) return null
  const { currentFrame: _frame, zoomLevel: _zoom, scrollPosition: _scroll, ...content } = timeline as Record<string, unknown>
  return canonicalJson(storeGeneratedMedia(content))
}

/** Publish only the timeline actually loaded by this mount, never the host's incoming graph. */
export function publishScopeOwner(
  state: DraftSendState,
  readEditContent: () => string,
  confirmedContent?: string | null,
): void {
  if (!acceptsWrite(state, state.mount)) {
    usePreviewBridgeStore.setState({ scopeOwner: null })
    return
  }
  const read = () => scopeTimelineContent(JSON.parse(readEditContent()))
  const baseline = confirmedContent === undefined ? read() : confirmedContent
  if (baseline === null) {
    usePreviewBridgeStore.setState({ scopeOwner: null })
    return
  }
  const mount = state.mount
  usePreviewBridgeStore.setState({ scopeOwner: {
    baseRevision: mount.revision, graphVersion: mount.graphVersion,
    mountGeneration: mount.generation, projectId: mount.projectId,
    hasLocalEdits: () => read() !== baseline,
  } })
}
