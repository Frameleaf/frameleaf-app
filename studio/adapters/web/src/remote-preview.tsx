/**
 * The server preview inside the editor (FL-96, `STU-402`).
 *
 * Freecut previews locally: it decodes with WebCodecs and composites with WebGPU when they exist.
 * Safari and Firefox builds without them, or a source the browser cannot decode (HEVC on most
 * desktops), must still show the truth, so the editor also offers the exact frame the render
 * worker produces for the stored revision. The engine never fetches it: it sends a
 * `preview.request` envelope through the host port, and the host's revision-bound preview client
 * (seek generations, replace-not-queue backpressure, stale-frame labelling, revocation) answers in
 * `context.preview` on the next update.
 *
 * The panel opens by itself when this browser cannot decode locally, and is one click away
 * otherwise. Frames are asked for only while paused: scrubbing and inspection need exact frames;
 * continuous playback is the WebRTC stream the render worker does not publish yet (FL-145).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePlaybackStore } from '@/shared/state/playback'
import { useTimelineSettingsStore } from '@/features/timeline/stores/timeline-settings-store'
import type {
  StudioFrameServiceCalls,
  StudioFrameServiceName,
} from '@frameleaf/host/frame-protocol'
import type { StudioHostContext } from '@frameleaf/host/host-contract'

export interface LocalPreviewSupport {
  webCodecs: boolean
  webGpu: boolean
}

export const localPreviewSupport = (): LocalPreviewSupport => ({
  webCodecs: typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === 'function',
  webGpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
})

type Call = <Name extends StudioFrameServiceName>(
  name: Name,
  ...args: StudioFrameServiceCalls[Name]['args']
) => Promise<StudioFrameServiceCalls[Name]['result']>

const key = () => crypto.randomUUID()

/** A playhead frame as an exact rational second at the project's rate (FL-93). */
export const frameToTime = (frame: number, fps: number): { num: number; den: number } => {
  const rate = Number.isInteger(fps)
    ? { num: fps, den: 1 }
    : { num: Math.round(fps * 1000), den: 1000 }
  let num = frame * rate.den
  let den = rate.num
  const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b))
  const divisor = gcd(num, den) || 1
  num /= divisor
  den /= divisor
  return { num, den }
}

export function RemotePreview({ context, call }: { context: StudioHostContext; call: Call }) {
  const support = useMemo(localPreviewSupport, [])
  const [open, setOpen] = useState(!support.webCodecs)
  const frame = usePlaybackStore((playback) => (playback.isPlaying ? null : playback.currentFrame))
  const fps = useTimelineSettingsStore((settings) => settings.fps || 30)
  const panel = useRef<HTMLDivElement>(null)
  const strings = context.strings ?? {}
  const revision = context.project.revision

  useEffect(() => {
    if (!open || frame === null || !context.capabilities.renderWorker) return
    const timer = setTimeout(() => {
      const box = panel.current?.getBoundingClientRect()
      const scale = globalThis.devicePixelRatio || 1
      void call('submitCommands', [
        {
          id: 'preview.request',
          payload: {
            at: frameToTime(frame, fps),
            quality: 'standard',
            viewportWidth: Math.max(64, Math.round((box?.width ?? 480) * scale)),
            viewportHeight: Math.max(36, Math.round(((box?.width ?? 480) * 9 * scale) / 16)),
          },
          revision,
          idempotencyKey: key(),
          issuedAt: Date.now(),
        },
      ])
    }, 150)
    return () => clearTimeout(timer)
  }, [open, frame, fps, revision, call, context.capabilities.renderWorker])

  // Closing the panel stops paying for frames nobody sees (only on the transition to closed).
  const revisionRef = useRef(revision)
  revisionRef.current = revision
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) {
      void call('submitCommands', [
        {
          id: 'preview.release',
          payload: {},
          revision: revisionRef.current,
          idempotencyKey: key(),
          issuedAt: Date.now(),
        },
      ]).catch(() => undefined)
    }
    wasOpen.current = open
  }, [open, call])

  const view = context.preview
  const shown =
    view.phase === 'ready' ? view.frame : view.phase === 'stale' ? view.staleFrame : null
  const status = !context.capabilities.renderWorker
    ? strings.previewNoWorker
    : view.phase === 'rendering'
      ? strings.previewRendering
      : view.phase === 'stale'
        ? strings.previewStale
        : view.phase === 'unavailable'
          ? strings.previewUnavailable
          : view.frame?.toneMapped
            ? strings.previewToneMapped
            : undefined

  const surface: React.CSSProperties = {
    position: 'fixed',
    right: 16,
    bottom: 16,
    zIndex: 70,
    font: '500 12px/1.4 -apple-system, "SF Pro Text", Inter, system-ui, sans-serif',
    color: 'var(--fl-viewer-text, #f5f5f7)',
    background: 'var(--fl-viewer-raised, rgba(44, 44, 46, 0.92))',
    border: '1px solid var(--fl-viewer-border, #3a3a3c)',
    borderRadius: 14,
    boxShadow: 'var(--fl-shadow-2, 0 12px 32px rgba(0, 0, 0, 0.45))',
  }

  if (!open) {
    return (
      <button
        type="button"
        style={{ ...surface, padding: '6px 12px', cursor: 'pointer' }}
        onClick={() => setOpen(true)}
      >
        {strings.previewShow}
      </button>
    )
  }

  return (
    <section aria-label={strings.previewTitle} style={{ ...surface, width: 320, padding: 8 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <strong>{strings.previewTitle}</strong>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer' }}
        >
          {strings.previewHide}
        </button>
      </header>
      <div
        ref={panel}
        style={{
          position: 'relative',
          aspectRatio: '16 / 9',
          background: 'var(--fl-viewer-canvas, #000)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        {shown ? (
          <img
            src={shown.objectUrl}
            alt=""
            data-revision={shown.revision}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              opacity: view.phase === 'stale' ? 0.5 : 1,
            }}
          />
        ) : null}
      </div>
      {status ? (
        <p role="status" style={{ margin: '6px 0 0', color: 'var(--fl-viewer-muted, #a1a1a6)' }}>
          {status}
        </p>
      ) : null}
    </section>
  )
}
