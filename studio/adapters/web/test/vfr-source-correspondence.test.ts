/**
 * FL-403 (STU-301a): an edit on a variable-frame-rate source must keep every timeline frame on the
 * source picture it showed before the edit.
 *
 * A VFR source has a nominal `sourceFps` (what the library reports) and irregular presentation
 * timestamps. The engine maps timeline frame t of a clip to a source time
 * (`getVideoTargetTimeSeconds`), and the decoder presents the last picture whose timestamp is not
 * after that time. These tests split, trim and move real clips through the engine's own actions,
 * then compare, frame by frame, which source picture each timeline frame lands on.
 *
 * Where an edit point maps to a whole number of source frames, the correspondence must be exact.
 * Where it does not (a 30 fps-nominal source in a 24 fps project, cut at a frame whose source offset
 * is fractional), the engine stores the new `sourceStart` rounded to a whole source frame (the graph
 * schema requires an integer), so the half after the cut shifts by up to half a source frame. That
 * is a known defect, pinned below with `it.fails` so the suite flips when it is fixed.
 */
import { beforeEach, describe, expect, it } from 'vite-plus/test'
import type { TimelineItem, VideoItem } from '@/types/timeline'
import { getVideoTargetTimeSeconds } from '@/runtime/composition-runtime/utils/video-timing'
import { moveItem } from '@/features/timeline/stores/actions/item-actions'
import {
  splitItem,
  trimItemEnd,
  trimItemStart,
} from '@/features/timeline/stores/actions/item-edit-actions'
import { useItemsStore } from '@/features/timeline/stores/items-store'
import { useTimelineCommandStore } from '@/features/timeline/stores/timeline-command-store'
import { useTimelineSettingsStore } from '@/features/timeline/stores/timeline-settings-store'
import { useTransitionsStore } from '@/features/timeline/stores/transitions-store'
import { useEditorStore } from '@/shared/state/editor'

const NOMINAL_FPS = 30
const SOURCE_FRAMES = 900

/**
 * Presentation timestamps of a phone-style VFR recording: nominally 30 fps, but each picture is up
 * to 40% of a frame early or late, with a run of 60 fps pictures and a dropped-frame stall.
 */
const PTS: readonly number[] = (() => {
  const pts: number[] = []
  let t = 0
  for (let index = 0; index < SOURCE_FRAMES; index++) {
    pts.push(t)
    const base = 1 / NOMINAL_FPS
    const jitter = 0.4 * Math.sin(index * 1.7) * base
    const burst = index >= 300 && index < 360 ? -base / 2 : 0
    const stall = index === 500 ? base * 2 : 0
    t += base + jitter * 0.5 + burst + stall
  }
  return pts
})()

/** The picture a decoder presents at `seconds`: the last one whose timestamp is not after it. */
const pictureAt = (seconds: number) => {
  let low = 0
  let high = PTS.length - 1
  if (seconds < PTS[0]!) return 0
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (PTS[middle]! <= seconds) low = middle
    else high = middle - 1
  }
  return low
}

const clip = (overrides: Partial<VideoItem> = {}): VideoItem =>
  ({
    id: 'clip',
    type: 'video',
    trackId: 'v1',
    from: 10,
    durationInFrames: 200,
    label: 'vfr.mp4',
    src: 'blob:vfr',
    mediaId: 'vfr-media',
    sourceStart: 40,
    sourceEnd: 40 + 250,
    sourceDuration: SOURCE_FRAMES,
    sourceFps: NOMINAL_FPS,
    speed: 1,
    ...overrides,
  }) as VideoItem

/** For each timeline frame a video clip covers: the source picture it presents. */
const landing = (items: readonly TimelineItem[], fps: number) => {
  const pictures = new Map<number, number>()
  for (const item of items) {
    if (item.type !== 'video') continue
    for (let frame = item.from; frame < item.from + item.durationInFrames; frame++) {
      const seconds = getVideoTargetTimeSeconds(
        item.sourceStart ?? 0,
        item.sourceFps ?? fps,
        frame - item.from,
        item.speed ?? 1,
        fps,
      )
      expect(pictures.has(frame), `frame ${frame} covered twice`).toBe(false)
      pictures.set(frame, pictureAt(seconds))
    }
  }
  return pictures
}

const reset = (fps: number, item: VideoItem = clip()) => {
  useTimelineCommandStore.getState().clearHistory()
  useEditorStore.setState({ linkedSelectionEnabled: false })
  useTimelineSettingsStore.setState({ fps, isDirty: false })
  useTransitionsStore.getState().setTransitions([])
  useItemsStore.getState().setTracks([])
  useItemsStore.getState().setItems([item])
}
const items = () => useItemsStore.getState().items

/** Every timeline frame both maps cover lands on the same picture; returns the frames that moved. */
const moved = (before: Map<number, number>, after: Map<number, number>, shift = 0) => {
  const differences: Array<{ frame: number; before: number; after: number }> = []
  for (const [frame, picture] of before) {
    const now = after.get(frame + shift)
    if (now !== undefined && now !== picture)
      differences.push({ frame, before: picture, after: now })
  }
  return differences
}

describe('VFR source correspondence through edits (FL-403)', () => {
  it('has a genuinely variable-rate source', () => {
    const durations = PTS.slice(1).map((value, index) => value - PTS[index]!)
    expect(Math.min(...durations)).toBeLessThan(0.6 / NOMINAL_FPS)
    expect(Math.max(...durations)).toBeGreaterThan(2.5 / NOMINAL_FPS)
    // Timeline frames at the nominal rate do not simply equal picture indices.
    expect([...Array(120).keys()].some((frame) => pictureAt(frame / NOMINAL_FPS) !== frame)).toBe(
      true,
    )
  })

  describe('project at the nominal rate (30 fps)', () => {
    beforeEach(() => reset(30))

    it('a split at any frame keeps every frame on its source picture', () => {
      const before = landing(items(), 30)
      for (let cut = 11; cut < 210; cut += 7) {
        reset(30)
        expect(splitItem('clip', cut)).not.toBeNull()
        expect(items()).toHaveLength(2)
        expect(moved(before, landing(items(), 30))).toEqual([])
        expect(landing(items(), 30).size).toBe(before.size)
      }
    })

    it('trimming either end keeps the remaining frames on their pictures', () => {
      const before = landing(items(), 30)
      for (const amount of [1, 2, 5, 13]) {
        reset(30)
        trimItemStart('clip', amount)
        expect(items()[0]!.from).toBe(10 + amount)
        expect(moved(before, landing(items(), 30))).toEqual([])
        reset(30)
        trimItemEnd('clip', -amount)
        expect(items()[0]!.durationInFrames).toBe(200 - amount)
        expect(moved(before, landing(items(), 30))).toEqual([])
      }
    })

    it('moving a clip carries its pictures with it, and undo restores them', () => {
      const before = landing(items(), 30)
      moveItem('clip', 47)
      expect(moved(before, landing(items(), 30), 37)).toEqual([])
      useTimelineCommandStore.getState().undo()
      expect(moved(before, landing(items(), 30))).toEqual([])
      expect(items()[0]!.from).toBe(10)
    })
  })

  describe('project at another rate (24 fps) than the source (30 fps nominal)', () => {
    beforeEach(() => reset(24))

    it('a cut whose source offset is a whole source frame keeps every frame on its picture', () => {
      const before = landing(items(), 24)
      // 4 timeline frames at 24 fps are exactly 5 source frames at 30 fps.
      for (let cut = 14; cut < 210; cut += 4) {
        reset(24)
        expect(splitItem('clip', cut)).not.toBeNull()
        expect(moved(before, landing(items(), 24))).toEqual([])
      }
      for (const amount of [4, 8, 20]) {
        reset(24)
        trimItemStart('clip', amount)
        expect(moved(before, landing(items(), 24))).toEqual([])
      }
    })

    it('stores the cut on the exact source time the timeline frame shows', () => {
      // The right half's first frame must present the source time the unsplit clip showed there.
      reset(24)
      const cut = 17
      const unsplit = getVideoTargetTimeSeconds(40, NOMINAL_FPS, cut - 10, 1, 24)
      splitItem('clip', cut)
      const right = items().find((item) => item.from === cut) as VideoItem
      const split = getVideoTargetTimeSeconds(right.sourceStart!, NOMINAL_FPS, 0, 1, 24)
      // Integer source frames: 7 frames at 24 fps are 8.75 source frames, stored as 9.
      expect(Number.isInteger(right.sourceStart)).toBe(true)
      expect(Math.abs(split - unsplit)).toBeLessThanOrEqual(0.5 / NOMINAL_FPS + 1e-9)
    })

    // KNOWN DEFECT (FL-403): fractional source offsets are rounded to whole source frames, so the
    // pictures after the edit point can shift by one. Needs a non-integer (or rational) source
    // offset in the graph schema; remove `.fails` when that lands.
    it.fails('a cut whose source offset is fractional keeps every frame on its picture', () => {
      const before = landing(items(), 24)
      const shifted: number[] = []
      for (let cut = 11; cut < 210; cut++) {
        if (((cut - 10) * NOMINAL_FPS) % 24 === 0) continue
        reset(24)
        splitItem('clip', cut)
        if (moved(before, landing(items(), 24)).length > 0) shifted.push(cut)
      }
      expect(shifted).toEqual([])
    })
  })
})
