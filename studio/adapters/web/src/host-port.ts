/**
 * The editor frame's one channel to the host (FL-88).
 *
 * The host hands this document one end of a `MessageChannel` after the frame announces itself.
 * Everything the editor sends the host — service calls, drafts, navigation, dirty state, export
 * requests — goes through `post` and `call` here, so the adapter's substituted modules (the export
 * dialogs) and the editor session share one connection.
 */
import type {
  StudioFrameHello,
  StudioFrameServiceCalls,
  StudioFrameServiceName,
  StudioFrameToHostMessage,
  StudioHostToFrameMessage,
} from '@frameleaf/host/frame-protocol'
import { STUDIO_FRAME_PROTOCOL_VERSION } from '@frameleaf/host/frame-protocol'
import { ENGINE_REVISION } from './engine-revision'

let port: MessagePort | null = null
let nextCallId = 1
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

export const post = (message: StudioFrameToHostMessage): void => port?.postMessage(message)

export function call<Name extends StudioFrameServiceName>(
  name: Name,
  ...args: StudioFrameServiceCalls[Name]['args']
): Promise<StudioFrameServiceCalls[Name]['result']> {
  if (!port) return Promise.reject(new Error('The Studio host is not connected'))
  const callId = nextCallId++
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve: resolve as (value: unknown) => void, reject })
    post({ type: 'service', callId, name, args })
  })
}

/** Accept the host's port and route its messages; service answers are settled here. */
export function connectToHost(
  kind: StudioFrameHello['kind'],
  onMessage: (message: StudioHostToFrameMessage) => void,
): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return
    const data = event.data as { source?: string } | null
    if (data?.source !== 'frameleaf-studio-host' || !event.ports[0] || port) return
    port = event.ports[0]
    port.onmessage = (portEvent) => {
      const message = portEvent.data as StudioHostToFrameMessage
      if (message?.type === 'service-result') {
        const waiting = pending.get(message.callId)
        if (!waiting) return
        pending.delete(message.callId)
        if (message.ok) waiting.resolve(message.value)
        else waiting.reject(new Error(message.error))
        return
      }
      onMessage(message)
    }
  })
  const hello: StudioFrameHello = {
    source: 'frameleaf-studio-frame',
    kind,
    protocolVersion: STUDIO_FRAME_PROTOCOL_VERSION,
    engineRevision: ENGINE_REVISION,
  }
  window.parent.postMessage(hello, window.location.origin)
}
