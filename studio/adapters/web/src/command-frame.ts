/**
 * The canonical command runtime (FL-92, `STU-205`).
 *
 * A second, hidden document the host starts next to (never inside) the editor. It owns its own copy
 * of Freecut's timeline stores, so applying a command to a stored graph never disturbs what the
 * person is editing, and `canonical-commands.ts` can fix `crypto.randomUUID` and the clock for an
 * envelope without anything else observing it. It loads the timeline modules only — no React, no
 * editor — and speaks one request: apply this batch to this graph.
 */
import type {
  StudioCommandApplyOutcome,
  StudioCommandApplyRequest,
  StudioCommandFrameMessage,
  StudioFrameHello,
} from '@frameleaf/host/frame-protocol'
import { STUDIO_FRAME_PROTOCOL_VERSION } from '@frameleaf/host/frame-protocol'
import type { StudioAssetRef } from '@frameleaf/host/host-contract'
import type { MediaMetadata } from '@/types/storage'
import { applyCanonicalCommands } from './canonical-commands'
import { ENGINE_REVISION } from './engine-revision'
import { initialMediaRecord, probeVideo, sourceUrlOf } from './library-media'
import { installBrowserShims } from './browser-shims'

installBrowserShims()

/** Probed once per asset for this document's lifetime: frame rates do not change. */
const probed = new Map<string, Promise<MediaMetadata>>()

const metadataFor = (asset: StudioAssetRef): Promise<MediaMetadata> => {
  let entry = probed.get(asset.id)
  if (!entry) {
    entry = (async () => {
      const record = initialMediaRecord(asset, 0)
      if (asset.kind !== 'video') return record
      const probe = await probeVideo(sourceUrlOf(asset), new AbortController().signal)
      return probe ? { ...record, ...probe } : record
    })()
    probed.set(asset.id, entry)
  }
  return entry
}

/** The assets a batch actually places, so nothing else is probed. */
const referencedAssets = (request: StudioCommandApplyRequest): StudioAssetRef[] => {
  const ids = new Set(
    request.envelopes
      .map((envelope) => (envelope.payload as { assetId?: unknown }).assetId)
      .filter((id): id is string => typeof id === 'string'),
  )
  return request.assets.filter((asset) => ids.has(asset.id) && !asset.isOffline)
}

async function apply(request: StudioCommandApplyRequest): Promise<StudioCommandApplyOutcome> {
  const media = await Promise.all(referencedAssets(request).map((asset) => metadataFor(asset)))
  const outcome = await applyCanonicalCommands(request.graph, request.envelopes, media)
  return outcome.status === 'applied'
    ? { status: 'applied', graph: outcome.project, digest: outcome.digest }
    : outcome
}

let port: MessagePort | null = null
/** One batch at a time: the stores are shared by every apply in this document. */
let queue: Promise<void> = Promise.resolve()

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== window.location.origin) return
  const data = event.data as { source?: string } | null
  if (data?.source !== 'frameleaf-studio-host' || !event.ports[0] || port) return
  port = event.ports[0]
  port.onmessage = (portEvent) => {
    const request = portEvent.data as StudioCommandApplyRequest
    if (request?.type !== 'apply') return
    queue = queue.then(async () => {
      let outcome: StudioCommandApplyOutcome
      try {
        outcome = await apply(request)
      } catch (error) {
        outcome = {
          status: 'rejected',
          index: 0,
          reason: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
      const reply: StudioCommandFrameMessage = {
        type: 'applied',
        requestId: request.requestId,
        outcome,
      }
      port?.postMessage(reply)
    })
  }
  const ready: StudioCommandFrameMessage = {
    type: 'ready',
    protocolVersion: STUDIO_FRAME_PROTOCOL_VERSION,
    engineRevision: ENGINE_REVISION,
  }
  port.postMessage(ready)
})

const hello: StudioFrameHello = {
  source: 'frameleaf-studio-frame',
  kind: 'commands',
  protocolVersion: STUDIO_FRAME_PROTOCOL_VERSION,
  engineRevision: ENGINE_REVISION,
}
window.parent.postMessage(hello, window.location.origin)
