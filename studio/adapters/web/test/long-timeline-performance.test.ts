/**
 * FL-403 (STU-301a): a measured budget for a long project on the real engine stores.
 *
 * Thousands of clips on several tracks, at a desktop and a tablet viewport. Each interaction the
 * timeline repeats while a person edits is timed through the same code the editor runs:
 *
 * - scroll and zoom: the viewport/zoom store update and every track's `useVisibleItems` re-render
 *   (React, culled to the visible window);
 * - drag: `moveItems`, one committed drag of a multi-clip selection;
 * - trim: `trimItemEnd` / `trimItemStart` on single clips;
 * - undo: `useTimelineCommandStore.undo`, back to the untouched project.
 *
 * Budgets are per-interaction p95 wall time in this test environment (jsdom, one Node worker).
 * They are deliberately loose against a local run (see the report) so a busy CI runner passes,
 * and tight enough that an accidental O(n²) pass over the project, or culling that stops
 * culling, fails. Set `LONG_TIMELINE_REPORT=<file>` to keep the measurements as JSON.
 */
import { writeFileSync } from 'node:fs'
import { createElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test'
import type { AudioItem, TimelineItem, TimelineTrack, VideoItem } from '@/types/timeline'
import { useSettingsStore } from '@/features/settings/stores/settings-store'
import { useVisibleItems } from '@/features/timeline/hooks/use-visible-items'
import { moveItems } from '@/features/timeline/stores/actions/item-actions'
import { trimItemEnd, trimItemStart } from '@/features/timeline/stores/actions/item-edit-actions'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store'
import { useTimelineSettingsStore } from '@/features/timeline/stores/timeline-settings-store'
import {
  _resetViewportThrottle,
  useTimelineViewportStore,
} from '@/features/timeline/stores/timeline-viewport-store'
import { useTransitionsStore } from '@/features/timeline/stores/transitions-store'
import { _resetZoomStoreForTest, useZoomStore } from '@/features/timeline/stores/zoom-store'
import { useEditorStore } from '@/shared/state/editor'

const FPS = 30
const VIDEO_TRACKS = 4
const AUDIO_TRACKS = 2
const ITEMS_PER_TRACK = 800
const CLIP_FRAMES = 45
const GAP_FRAMES = 5
const STEP = CLIP_FRAMES + GAP_FRAMES
const TIMELINE_FRAMES = ITEMS_PER_TRACK * STEP

/** p95 wall time per interaction, in milliseconds. */
// Local reference (Apple M-series, 2026-10-22), p95 ms desktop/tablet: scroll 0.4/0.1,
// zoom 0.4/0.2, drag 5.5/2.7, trim 2.3/2.7, undo 7.6/10.1, load 9.
export const BUDGETS = {
  load: 500,
  scroll: 8,
  zoom: 8,
  drag: 40,
  trim: 40,
  undo: 60,
} as const

/** At most this many clips per track may be mounted at once at any zoom the sweep visits. */
const MAX_MOUNTED_PER_TRACK = 400

const PROFILES = [
  { name: 'desktop', viewportWidth: 1920, viewportHeight: 900 },
  { name: 'tablet', viewportWidth: 1180, viewportHeight: 820 },
] as const

const trackIds = [
  ...Array.from({ length: VIDEO_TRACKS }, (_, index) => `v${index + 1}`),
  ...Array.from({ length: AUDIO_TRACKS }, (_, index) => `a${index + 1}`),
]

const makeTrack = (id: string, order: number): TimelineTrack => ({
  id,
  name: id.toUpperCase(),
  kind: id.startsWith('v') ? 'video' : 'audio',
  height: 64,
  locked: false,
  visible: true,
  muted: false,
  solo: false,
  volume: 0,
  order,
  items: [],
})

const makeClip = (trackId: string, index: number): TimelineItem => {
  const base = {
    id: `${trackId}-${index}`,
    trackId,
    from: index * STEP,
    durationInFrames: CLIP_FRAMES,
    label: `${trackId}-${index}`,
    mediaId: `media-${trackId}-${index % 40}`,
    sourceStart: 120,
    sourceEnd: 120 + CLIP_FRAMES,
    sourceDuration: 100_000,
    sourceFps: FPS,
  }
  return trackId.startsWith('v')
    ? ({ ...base, type: 'video', src: 'blob:video' } as VideoItem)
    : ({ ...base, type: 'audio', src: 'blob:audio' } as AudioItem)
}

type Sample = { p50: number; p95: number; max: number; n: number }
const summarize = (durations: number[]): Sample => {
  const sorted = [...durations].sort((left, right) => left - right)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  const round = (value: number) => Math.round(value * 1000) / 1000
  return { p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)!), n: sorted.length }
}
const time = (action: () => void) => {
  const start = performance.now()
  action()
  return performance.now() - start
}

const mounted = new Map<string, number>()
const renders = new Map<string, number>()
function TrackProbe({ trackId }: { trackId: string }) {
  const { visibleItems } = useVisibleItems(trackId)
  mounted.set(trackId, visibleItems.length)
  renders.set(trackId, (renders.get(trackId) ?? 0) + 1)
  return createElement('div', { 'data-track': trackId }, visibleItems.length)
}

const shape = (items: readonly TimelineItem[]) =>
  items
    .map((item) => {
      const media = item as VideoItem
      return `${item.id}:${item.trackId}:${item.from}:${item.durationInFrames}:${media.sourceStart}:${media.sourceEnd}`
    })
    .sort()

const report: Record<string, unknown> = {
  issue: 'FL-403',
  environment: 'jsdom (vite-plus test), engine stores and hooks, one worker',
  project: {
    tracks: trackIds.length,
    items: trackIds.length * ITEMS_PER_TRACK,
    frames: TIMELINE_FRAMES,
    fps: FPS,
  },
  budgets: BUDGETS,
  profiles: {},
}

describe('long timeline performance budget (FL-403)', () => {
  let initial: string[] = []

  beforeAll(() => {
    useTimelineCommandStore.getState().clearHistory()
    useEditorStore.setState({ linkedSelectionEnabled: false })
    // Room for every edit below, so undo can walk back to the untouched project.
    useSettingsStore.setState({ maxUndoHistory: 100 })
    useTimelineSettingsStore.setState({
      fps: FPS,
      scrollPosition: 0,
      snapEnabled: true,
      isDirty: false,
      isTimelineLoading: false,
    })
    useTransitionsStore.getState().setTransitions([])
    _resetZoomStoreForTest()
    _resetViewportThrottle()
    const items = trackIds.flatMap((trackId) =>
      Array.from({ length: ITEMS_PER_TRACK }, (_, index) => makeClip(trackId, index)),
    )
    const load = time(() => {
      useItemsStore.getState().setTracks(trackIds.map(makeTrack))
      useItemsStore.getState().setItems(items)
    })
    report.load = { ms: Math.round(load * 1000) / 1000 }
    expect(load).toBeLessThan(BUDGETS.load)
    initial = shape(useItemsStore.getState().items)
    expect(initial).toHaveLength(trackIds.length * ITEMS_PER_TRACK)
  })

  afterAll(() => {
    cleanup()
    if (process.env.LONG_TIMELINE_REPORT) {
      writeFileSync(process.env.LONG_TIMELINE_REPORT, `${JSON.stringify(report, null, 2)}\n`)
    }
    console.info(`FL-403 long timeline: ${JSON.stringify(report)}`)
  })

  for (const profile of PROFILES) {
    describe(`${profile.name} viewport (${profile.viewportWidth}×${profile.viewportHeight})`, () => {
      const measured: Record<string, Sample> = {}
      ;(report.profiles as Record<string, unknown>)[profile.name] = measured

      // Testing Library unmounts after every test, so each test mounts the six tracks afresh.
      beforeEach(() => {
        cleanup()
        mounted.clear()
        renders.clear()
        _resetZoomStoreForTest()
        act(() => {
          useTimelineViewportStore.getState().setViewportImmediate({
            scrollLeft: 0,
            scrollTop: 0,
            viewportWidth: profile.viewportWidth,
            viewportHeight: profile.viewportHeight,
          })
        })
        render(
          createElement(
            'div',
            null,
            trackIds.map((trackId) => createElement(TrackProbe, { key: trackId, trackId })),
          ),
        )
      })

      it('scrolls the whole project within budget, mounting only the visible window', () => {
        const pps = useZoomStore.getState().pixelsPerSecond
        const totalPx = (TIMELINE_FRAMES / FPS) * pps
        const steps = 240
        const durations: number[] = []
        const before = renders.get('v1') ?? 0
        let maxMounted = 0
        for (let step = 1; step <= steps; step++) {
          const scrollLeft = Math.round((step / steps) * (totalPx - profile.viewportWidth))
          durations.push(
            time(() =>
              act(() => {
                useTimelineViewportStore.getState().setViewportImmediate({
                  scrollLeft,
                  scrollTop: 0,
                  viewportWidth: profile.viewportWidth,
                  viewportHeight: profile.viewportHeight,
                })
              }),
            ),
          )
          for (const trackId of trackIds)
            maxMounted = Math.max(maxMounted, mounted.get(trackId) ?? 0)
          expect(mounted.get('v1')).toBeGreaterThan(0)
        }
        measured.scroll = summarize(durations)
        expect((renders.get('v1') ?? 0) - before).toBeGreaterThan(steps / 4)
        // Culling holds: a viewport of ~1–2k px at the default zoom never mounts the project.
        expect(maxMounted).toBeLessThan(ITEMS_PER_TRACK / 10)
        expect(measured.scroll.p95).toBeLessThan(BUDGETS.scroll)
      })

      it('zooms out to the whole project and back, by keys and by wheel, within budget', async () => {
        const durations: number[] = []
        // The editor keeps the frame under the playhead in place while zooming; so does this.
        const center = TIMELINE_FRAMES / 2
        const anchor = () => {
          const pps = useZoomStore.getState().pixelsPerSecond
          useTimelineViewportStore.getState().setViewportImmediate({
            scrollLeft: Math.max(0, (center / FPS) * pps - profile.viewportWidth / 2),
            scrollTop: 0,
            viewportWidth: profile.viewportWidth,
            viewportHeight: profile.viewportHeight,
          })
        }
        const zoomStep = (zoom: () => void) =>
          durations.push(
            time(() =>
              act(() => {
                zoom()
                anchor()
              }),
            ),
          )
        const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 400)))
        const mountedNow = () => Math.max(...trackIds.map((trackId) => mounted.get(trackId) ?? 0))
        act(anchor)
        const atDefaultZoom = mountedNow()
        // Keyboard zoom: each step commits the content zoom that culling follows.
        while (useZoomStore.getState().level > 0.02)
          zoomStep(() => useZoomStore.getState().zoomOut())
        await settle()
        // Zoomed out to the whole project, culling has (almost) nothing left to cull.
        const zoomedOut = mountedNow()
        expect(zoomedOut).toBeGreaterThan(atDefaultZoom)
        while (useZoomStore.getState().level < 5) zoomStep(() => useZoomStore.getState().zoomIn())
        await settle()
        const zoomedIn = mountedNow()
        expect(zoomedIn).toBeGreaterThan(0)
        expect(zoomedIn).toBeLessThanOrEqual(MAX_MOUNTED_PER_TRACK)
        // Wheel zoom: one gesture of live steps, then its end-of-gesture content commit.
        act(() => useZoomStore.getState().beginZoomGesture())
        for (let step = 0; step < 40; step++) {
          zoomStep(() => useZoomStore.getState().setZoomLevelImmediate(5 * 0.9 ** step))
        }
        durations.push(time(() => act(() => useZoomStore.getState().endZoomGesture())))
        await settle()
        expect(mountedNow()).toBeGreaterThan(0)
        expect(mountedNow()).toBeLessThanOrEqual(MAX_MOUNTED_PER_TRACK)
        ;(report.profiles as Record<string, Record<string, unknown>>)[profile.name].mounted = {
          atDefaultZoom,
          zoomedOut,
          zoomedIn,
        }
        measured.zoom = summarize(durations)
        expect(measured.zoom.n).toBeGreaterThan(80)
        expect(measured.zoom.p95).toBeLessThan(BUDGETS.zoom)
        act(() => _resetZoomStoreForTest())
        await settle()
      })

      it('drags, trims and undoes back to the untouched project within budget', () => {
        useTimelineCommandStore.getState().clearHistory()
        const drag: number[] = []
        const trim: number[] = []
        const undo: number[] = []
        // Twenty committed drags of a ten-clip selection, nudged into their gaps and back.
        for (let round = 0; round < 20; round++) {
          const first = 300 + round * 10
          const delta = round % 2 === 0 ? 3 : -3
          const updates = Array.from({ length: 10 }, (_, offset) => {
            const id = `v${(offset % VIDEO_TRACKS) + 1}-${first + offset}`
            const item = useItemsStore.getState().itemById[id]!
            return { id, from: item.from + delta }
          })
          drag.push(time(() => act(() => moveItems(updates))))
        }
        // Forty trims: end handles in, then start handles in, across the project.
        for (let index = 0; index < 20; index++) {
          trim.push(time(() => act(() => trimItemEnd(`a1-${100 + index * 30}`, -2))))
          trim.push(time(() => act(() => trimItemStart(`v2-${110 + index * 30}`, 2))))
        }
        const edited = shape(useItemsStore.getState().items)
        expect(edited).not.toEqual(initial)
        expect(useItemsStore.getState().itemById['a1-100']!.durationInFrames).toBe(CLIP_FRAMES - 2)
        expect(useItemsStore.getState().itemById['v2-110']!.durationInFrames).toBe(CLIP_FRAMES - 2)
        expect((useItemsStore.getState().itemById['v2-110'] as VideoItem).sourceStart).toBe(122)

        while (useTimelineCommandStore.getState().canUndo) {
          undo.push(time(() => act(() => useTimelineCommandStore.getState().undo())))
        }
        expect(undo).toHaveLength(60)
        expect(shape(useItemsStore.getState().items)).toEqual(initial)

        measured.drag = summarize(drag)
        measured.trim = summarize(trim)
        measured.undo = summarize(undo)
        expect(measured.drag.p95).toBeLessThan(BUDGETS.drag)
        expect(measured.trim.p95).toBeLessThan(BUDGETS.trim)
        expect(measured.undo.p95).toBeLessThan(BUDGETS.undo)
      })
    })
  }
})
