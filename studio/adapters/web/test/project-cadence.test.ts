import { describe, expect, it } from 'vite-plus/test'
import type { Project } from '@/types/project'
import { handoffProjectFps, withStoredCadence } from '../src/project-cadence'
import { frameToTime } from '../src/remote-preview'
import { snapFrameRate } from '../src/library-media'

/** FL-93: the adapter stores and uses the project cadence exactly. */
describe('project cadence (FL-93)', () => {
  const graph = (metadata: Record<string, unknown>) => ({ id: 'p', metadata }) as unknown as Project

  it('gives an opened project its exact rational, keeping legacy integer and NTSC rates readable', () => {
    expect(withStoredCadence(graph({ width: 1920, fps: 25 })).metadata).toEqual({
      width: 1920,
      fps: 25,
      frameRate: { num: 25, den: 1 },
    })
    expect(withStoredCadence(graph({ fps: 29.97 })).metadata).toEqual({
      fps: 30_000 / 1001,
      frameRate: { num: 30_000, den: 1001 },
    })
  })

  it('leaves a rate with no exact reading as it is rather than guessing one', () => {
    const odd = graph({ fps: 27.3 })
    expect(withStoredCadence(odd)).toBe(odd)
  })

  it('turns a playhead frame into an exact instant: 30000/1001 is never 2997/100', () => {
    expect(frameToTime(1, 30_000 / 1001)).toEqual({ num: 1001, den: 30_000 })
    expect(frameToTime(1, 29.97)).toEqual({ num: 1001, den: 30_000 })
    expect(frameToTime(107_892, 29.97)).toEqual({ num: 8_999_991, den: 2500 })
    expect(frameToTime(24, 24)).toEqual({ num: 1, den: 1 })
    expect(frameToTime(1, 27.3)).toBeNull()
  })

  it('snaps a measured NTSC packet rate to the exact x/1001 rate', () => {
    expect(snapFrameRate(29.969)).toBe(30_000 / 1001)
    expect(snapFrameRate(23.98)).toBe(24_000 / 1001)
    expect(snapFrameRate(25.01)).toBe(25)
  })

  it('uses the existing fallback for nonfinite and nonpositive packet rates', () => {
    for (const fps of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, -1]) {
      expect(snapFrameRate(fps)).toBe(30)
    }
  })

  it('preserves every exact supported packet rate', () => {
    for (const fps of [24_000 / 1001, 24, 25, 30_000 / 1001, 30, 48, 50, 60_000 / 1001, 60, 120]) {
      expect(snapFrameRate(fps)).toBe(fps)
    }
  })

  it('keeps the earlier nearest rate on ties and the inclusive 0.5 fps threshold', () => {
    expect(snapFrameRate(24.5)).toBe(24)
    expect(snapFrameRate(25.5)).toBe(25)
    expect(snapFrameRate(25.5001)).toBe(25.5)
    expect(snapFrameRate(27.34567)).toBe(27.346)
  })

  it('matches a new project to its handoff only when every video shares an editor rate exactly', () => {
    const video = (id: string, fps: number) => ({ id, mimeType: 'video/mp4', fps })
    expect(handoffProjectFps(['a', 'b'], [video('a', 25), video('b', 25)])).toBe(25)
    expect(handoffProjectFps(['a', 'b'], [video('a', 25), video('b', 60)])).toBe(30)
    expect(handoffProjectFps(['a'], [video('a', 30_000 / 1001)])).toBe(30)
    expect(handoffProjectFps([], [])).toBe(30)
  })
})
