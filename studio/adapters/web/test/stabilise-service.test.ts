import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  registerStabiliseHost,
  stabiliseAnalysis,
  stabiliseAvailable,
  StabiliseUnavailableError,
} from '../src/shims/stabilise-service'
// The engine's card imports the module by this name; the adapter build substitutes it (vite.config.mjs).
import * as substituted from '@/features/editor/components/properties-sidebar/clip-panel/stabilise-service'

const projectId = '0195e2a0-0000-7000-8000-000000000020'
const motion = {
  version: 1, method: 'block-similarity-v1', rate: 30, start: 0, count: 2, width: 160, height: 90,
  x: 'AAAAAArXIzw=', y: 'AAAAAAAAAAA=', a: 'AAAAAAAAAAA=', found: 1,
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('FL-638 Stabilise through the Frameleaf server', () => {
  let unregister: (() => void) | undefined
  afterEach(() => {
    unregister?.()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('is what the engine card gets in the adapter build', () => {
    expect(substituted.stabiliseAvailable).toBe(true)
    expect(substituted.stabiliseAnalysis).toBe(stabiliseAnalysis)
    expect(stabiliseAvailable).toBe(true)
  })

  it('is unavailable before the editor names its project', async () => {
    await expect(stabiliseAnalysis.analyse('clip', new AbortController().signal, () => {})).rejects.toBeInstanceOf(
      StabiliseUnavailableError,
    )
  })

  it('queues the job for the clip, follows it in Activity order and returns the camera path', async () => {
    vi.useFakeTimers()
    unregister = registerStabiliseHost(() => projectId)
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(201, { id: 'job-1', status: 'queued' }))
      .mockResolvedValueOnce(json(200, { status: 'rendering', progress: 40, error: null, result: null }))
      .mockResolvedValueOnce(json(200, { status: 'completed', progress: 100, error: null, result: motion }))
    vi.stubGlobal('fetch', fetch)
    const progress: number[] = []
    const result = stabiliseAnalysis.analyse('clip-1', new AbortController().signal, (value) => progress.push(value))
    await vi.advanceTimersByTimeAsync(2500)
    await expect(result).resolves.toEqual(motion)
    expect(progress).toEqual([40, 100])
    expect(fetch.mock.calls[0][0]).toBe(`/api/studio/projects/${projectId}/stabilisations`)
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ clipId: 'clip-1' }),
    })
    expect(fetch.mock.calls[1][0]).toBe(`/api/studio/projects/${projectId}/stabilisations/job-1`)
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'GET', credentials: 'same-origin' })
  })

  it('waits for autosave when the server does not know the new clip yet', async () => {
    vi.useFakeTimers()
    unregister = registerStabiliseHost(() => projectId)
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(400, { message: 'The clip is not on the main timeline of this revision' }))
      .mockResolvedValueOnce(json(201, { id: 'job-2', status: 'queued' }))
      .mockResolvedValueOnce(json(200, { status: 'completed', progress: 100, error: null, result: motion }))
    vi.stubGlobal('fetch', fetch)
    const result = stabiliseAnalysis.analyse('clip-2', new AbortController().signal, () => {})
    await vi.advanceTimersByTimeAsync(3000)
    await expect(result).resolves.toEqual(motion)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("passes the server's reason on when the job is refused or fails", async () => {
    vi.useFakeTimers()
    unregister = registerStabiliseHost(() => projectId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(400, { message: 'Only a video clip can be stabilised' })))
    await expect(stabiliseAnalysis.analyse('a', new AbortController().signal, () => {})).rejects.toThrow(
      'Only a video clip can be stabilised',
    )
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json(201, { id: 'job-3' }))
        .mockResolvedValueOnce(json(200, { status: 'failed', progress: 0, error: 'The clip has no picture to stabilise' })),
    )
    const failed = stabiliseAnalysis.analyse('b', new AbortController().signal, () => {})
    const settled = expect(failed).rejects.toThrow('The clip has no picture to stabilise')
    await vi.advanceTimersByTimeAsync(1500)
    await settled
  })
})
