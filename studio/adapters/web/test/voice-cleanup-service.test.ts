import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { changeAppLanguage, i18n } from '@/i18n'
import { VOICE_CLEANUP_ENGINE_STRINGS } from '@frameleaf/host/voice-cleanup-strings'
import { getVoiceCleanupHost, registerVoiceCleanupHost } from '../src/shims/voice-cleanup-service'
import { HOST_ENGINE_STRINGS } from '../src/host-engine-strings'

const projectId = '0195e2a0-0000-7000-8000-000000000040'
const jobId = '0195e2a0-0000-7000-8000-000000000041'
const importId = '0195e2a0-0000-4000-8000-000000000042'
const kept = {
  id: importId, kind: 'audio', contentType: 'audio/mp4', fileName: 'Beach walk (cleaned voice).m4a',
  sizeBytes: 1234, checksum: 'a'.repeat(64),
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('FL-637 Clean up voice host', () => {
  afterEach(() => {
    registerVoiceCleanupHost(null)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('has no host until an editor document registers its project', () => {
    expect(getVoiceCleanupHost()).toBeNull()
    registerVoiceCleanupHost({ projectId: () => projectId, seedImport: vi.fn() })
    expect(getVoiceCleanupHost()).not.toBeNull()
  })

  it("asks the project's server what is in the clip", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ clipId: 'a1', noises: ['hum'], humHz: 50 }))
    vi.stubGlobal('fetch', fetch)
    registerVoiceCleanupHost({ projectId: () => projectId, seedImport: vi.fn() })
    await expect(getVoiceCleanupHost()!.analyze('a1', new AbortController().signal)).resolves.toEqual({
      noises: ['hum'],
      humHz: 50,
    })
    expect(fetch).toHaveBeenCalledWith(
      `/api/studio/projects/${projectId}/voice-analysis`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ clipId: 'a1' }), credentials: 'same-origin' }),
    )
  })

  it('follows the job, puts the cleaned sound in the bin, and answers its media id', async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ id: jobId, status: 'queued' }, 201))
      .mockResolvedValueOnce(json({ id: jobId, status: 'rendering', progress: 40, error: null, result: null }))
      .mockResolvedValueOnce(
        json({
          id: jobId, status: 'completed', progress: 100, error: null,
          result: { import: kept, strength: 'light', noises: ['wind'], humHz: null, sourceStartSeconds: 1, durationSeconds: 6 },
        }),
      )
    vi.stubGlobal('fetch', fetch)
    const seedImport = vi.fn().mockResolvedValue(undefined)
    registerVoiceCleanupHost({ projectId: () => projectId, seedImport })
    const progress: number[] = []
    const cleaning = getVoiceCleanupHost()!.clean(
      { clipId: 'a1', strength: 'light', noises: ['wind'], humHz: null },
      (percent) => progress.push(percent),
      new AbortController().signal,
    )
    await vi.advanceTimersByTimeAsync(2500)
    await expect(cleaning).resolves.toEqual({
      importId, strength: 'light', noises: ['wind'], humHz: null, sourceStartSeconds: 1, durationSeconds: 6,
    })
    expect(progress).toEqual([40, 100])
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ clipId: 'a1', strength: 'light', noises: ['wind'] })
    expect(seedImport).toHaveBeenCalledWith({
      id: importId, kind: 'audio', name: kept.fileName, mimeType: 'audio/mp4', sizeBytes: 1234,
      checksum: kept.checksum, url: `/api/studio/projects/${projectId}/imports/${importId}/file`,
    })
  })

  it("says why a job failed, and cancels the job when the card lets go", async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ id: jobId, status: 'queued' }, 201))
      .mockResolvedValueOnce(json({ id: jobId, status: 'failed', progress: 10, error: 'The clip has no sound to clean up', result: null }))
    vi.stubGlobal('fetch', fetch)
    registerVoiceCleanupHost({ projectId: () => projectId, seedImport: vi.fn() })
    const failing = getVoiceCleanupHost()!.clean(
      { clipId: 'a1', strength: 'light', noises: ['wind'], humHz: null }, () => {}, new AbortController().signal,
    )
    const settled = expect(failing).rejects.toThrow('The clip has no sound to clean up')
    await vi.advanceTimersByTimeAsync(1500)
    await settled

    fetch.mockReset().mockResolvedValueOnce(json({ id: jobId, status: 'queued' }, 201)).mockResolvedValue(json({}))
    const controller = new AbortController()
    const cancelled = getVoiceCleanupHost()!.clean(
      { clipId: 'a1', strength: 'light', noises: ['wind'], humHz: null }, () => {}, controller.signal,
    )
    const rejected = expect(cancelled).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await rejected
    expect(fetch).toHaveBeenLastCalledWith(`/api/media-operations/${jobId}/cancel`, expect.objectContaining({ method: 'POST' }))
  })

  it('never seeds a result into another editor document or project', async () => {
    vi.useFakeTimers()
    const done = {
      id: jobId, status: 'completed', progress: 100, error: null,
      result: { import: kept, strength: 'light', noises: ['wind'], humHz: null, sourceStartSeconds: 1, durationSeconds: 6 },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ id: jobId, status: 'queued' }, 201)).mockResolvedValue(json(done)))
    const seedImport = vi.fn()
    registerVoiceCleanupHost({ projectId: () => projectId, seedImport })
    const cleaning = getVoiceCleanupHost()!.clean(
      { clipId: 'a1', strength: 'light', noises: ['wind'], humHz: null }, () => {}, new AbortController().signal,
    )
    const settled = expect(cleaning).rejects.toThrow('The project changed while the voice was cleaned up')
    const other = vi.fn()
    registerVoiceCleanupHost({ projectId: () => '0195e2a0-0000-7000-8000-000000000099', seedImport: other })
    await vi.advanceTimersByTimeAsync(1500)
    await settled
    expect(seedImport).not.toHaveBeenCalled()
    expect(other).not.toHaveBeenCalled()
  })

  it('refuses a project that is not saved yet, and passes on the server reason', async () => {
    registerVoiceCleanupHost({ projectId: () => null, seedImport: vi.fn() })
    await expect(getVoiceCleanupHost()!.analyze('a1', new AbortController().signal)).rejects.toThrow('Save the project first')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ message: 'Only a clip with sound can be cleaned up' }, 400)))
    registerVoiceCleanupHost({ projectId: () => projectId, seedImport: vi.fn() })
    await expect(getVoiceCleanupHost()!.analyze('a1', new AbortController().signal)).rejects.toThrow(
      'Only a clip with sound can be cleaned up',
    )
  })

  it('every card string has engine English with the same run-time values, and is host-translated', async () => {
    await changeAppLanguage('en')
    for (const [name, entry] of Object.entries(VOICE_CLEANUP_ENGINE_STRINGS)) {
      const english = i18n.getResource('en', 'translation', entry.engine) as string | undefined
      expect(english, entry.engine).toBeTruthy()
      const markers = [...english!.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1])
      expect(new Set(markers), entry.engine).toEqual(new Set('values' in entry ? entry.values : []))
      expect(HOST_ENGINE_STRINGS[name as keyof typeof HOST_ENGINE_STRINGS]).toBe(entry.engine)
    }
  })
})
