import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { unzipSync } from 'fflate'
import type { StudioHostContext } from '@frameleaf/host/host-contract'
import type { StudioSourceResolutionDto } from '@frameleaf/sdk'
import { studioSourceJson } from '@frameleaf/host/source-resolution'
import { nativeVectorScope } from '../src/native-vector-scope'
import { call } from '../src/host-port'
import { archiveFiles } from './lottie-archive-owned.fixture.mjs'

vi.mock('../src/host-port', () => ({ call: vi.fn() }))
const id = '11111111-1111-4111-8111-111111111111'
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const context = () => ({
  auth: { userId: 'owner' }, online: true, sourceEpoch: 3,
  project: { id: 'project', revision: 7, hasLease: true, graphVersion: 3,
    graphDigest: 'b'.repeat(64), leaseEpoch: 2, leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    graph: { retained: { history: ['opaque'] }, timeline: { items: [{ type: 'lottie', mediaId: id }], compositions: [] } } },
  projectImports: [{ id, kind: 'vector', checksum: 'a'.repeat(64) }], assets: [],
}) as unknown as StudioHostContext
const result = (ctx: StudioHostContext, files: Record<string, Uint8Array> = { 'animation.json': new TextEncoder().encode('{"v":"5.7","layers":[]}') }): StudioSourceResolutionDto => {
  const value = { projectId: ctx.project.id, revision: ctx.project.revision, graphDigest: ctx.project.graphDigest!,
    parent: { id, kind: 'project-import', checksum: 'a'.repeat(64) } as StudioSourceResolutionDto['parent'],
    expiresAt: new Date(Date.now() + 4000).toISOString(), selection: {}, archive: !!files['manifest.json'],
    files: Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([path, bytes]) => ({ path, sha256: sha(bytes), base64: Buffer.from(bytes).toString('base64') })) }
  return { ...value, manifestDigest: sha(studioSourceJson({ ...value, files: value.files.map(({ path, sha256 }) => ({ path, sha256 })) })) }
}
const resign = (value: StudioSourceResolutionDto) => {
  const { manifestDigest: _digest, files, ...metadata } = value
  value.manifestDigest = sha(studioSourceJson({ ...metadata, files: files.map(({ path, sha256 }) => ({ path, sha256 })) }))
  return value
}
const load = (ctx: StudioHostContext, current = () => true) => nativeVectorScope(ctx, 'engine-mount', 4, current).load(id, new AbortController().signal)
beforeEach(() => { vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID }); vi.mocked(call).mockReset() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('canonical complete closed native sources', () => {
  it('uses only the actual acknowledgement, preserving immutable graph/history and raw bytes', async () => {
    const ctx = context(), before = studioSourceJson(ctx), value = result(ctx)
    vi.mocked(call).mockResolvedValue(value)
    const source = await load(ctx)
    expect(source.blob.size).toBe(Buffer.from(value.files[0]!.base64, 'base64').length)
    expect(call).toHaveBeenCalledWith('resolveStudioProjectSource', {
      revision: 7, graphDigest: 'b'.repeat(64), parent: value.parent, selection: {},
    }, { userId: 'owner', projectId: 'project', graphVersion: 3 })
    expect(studioSourceJson(ctx)).toBe(before)
  })
  for (const version of ['1', '2']) {
    it(`v${version} preserves every animation, authored theme, raster/font file and selected nonfirst use`, async () => {
      const ctx = context()
      const graph = ctx.project.graph as { timeline: { items: unknown[]; compositions: unknown[] } }
      graph.timeline.items = [{ type: 'lottie', mediaId: id, animationId: 'selected' }]
      graph.timeline.compositions = [{ items: [{ type: 'lottie', mediaId: id, animationId: 'first', themeId: 'alternate' }] }]
      const files = { ...archiveFiles(version), [`${version === '2' ? 'i' : 'images'}/retained.png`]: new Uint8Array([137,80,78,71,13,10,26,10]), 'f/retained.ttf': new Uint8Array([0,1,0,0]) }
      // Actual references distinguish closure validation from unreferenced retained-file coverage.
      const prefix = version === '2' ? 'a' : 'animations'
      for (const animationId of ['first', 'selected']) {
        const document = JSON.parse(new TextDecoder().decode(files[`${prefix}/${animationId}.json`]!))
        document.assets = [...(document.assets ?? []), { id: 'retained-image', u: `${version === '2' ? 'i' : 'images'}/`, p: 'retained.png' }]
        document.fonts = { list: [{ fName: 'Retained', fPath: 'f/retained.ttf' }] }
        files[`${prefix}/${animationId}.json`] = new TextEncoder().encode(JSON.stringify(document))
      }
      const value = resign({ ...result(ctx, files), selection: { animationId: 'selected' } })
      vi.mocked(call).mockResolvedValue(value)
      const before = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, new Uint8Array(bytes)]))
      const source = await load(ctx)
      // jsdom's Blob lacks arrayBuffer: use the browser reader supported by the test environment.
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(source.blob)
      })
      expect(unzipSync(new Uint8Array(bytes))).toEqual(before)
      expect(files).toEqual(before)
    })
    it(`v${version} refuses an invalid nested selection before dedup can hide it`, async () => {
      const ctx = context()
      const graph = ctx.project.graph as { timeline: { compositions: unknown[] } }
      graph.timeline.compositions = [{ items: [{ type: 'lottie', mediaId: id, animationId: 'absent' }] }]
      vi.mocked(call).mockResolvedValue(result(ctx, archiveFiles(version)))
      await expect(load(ctx)).rejects.toThrow()
    })
  }
  for (const kind of ['image', 'font']) {
    it(`refuses a missing referenced archive ${kind}`, async () => {
      const ctx = context(), files = archiveFiles('2')
      const document = JSON.parse(new TextDecoder().decode(files['a/selected.json']))
      if (kind === 'image') document.assets = [{ id: 'missing', u: 'i/', p: 'missing.png' }]
      else document.fonts = { list: [{ fName: 'Missing', fPath: 'f/missing.ttf' }] }
      files['a/selected.json'] = new TextEncoder().encode(JSON.stringify(document))
      vi.mocked(call).mockResolvedValue(result(ctx, files))
      await expect(load(ctx)).rejects.toThrow()
    })
  }
  it('rejects exact binding, manifest, checksum, path, canonical base64 and closure failures', async () => {
    const ctx = context(), good = result(ctx)
    const bad: StudioSourceResolutionDto[] = [
      { ...good, projectId: 'other' }, { ...good, revision: 8 }, { ...good, graphDigest: 'c'.repeat(64) },
      { ...good, parent: { ...good.parent, checksum: 'c'.repeat(64) } },
      { ...good, manifestDigest: 'c'.repeat(64) }, { ...good, expiresAt: new Date(0).toISOString() },
      { ...good, files: [{ ...good.files[0]!, path: '../escape' }] },
      { ...good, files: [{ ...good.files[0]!, base64: 'AB==' }] },
      resign({ ...good, files: [{ ...good.files[0]!, sha256: 'c'.repeat(64) }] }),
      resign({ ...good, files: [...good.files, good.files[0]!] }),
      resign({ ...good, files: [{ ...good.files[0]!, path: 'unlisted.json' }] }),
    ]
    for (const value of bad) { vi.mocked(call).mockResolvedValue(value); await expect(load(ctx)).rejects.toThrow() }
  })
  for (const text of ['{"v":"5.7","v":"5.8","layers":[]}', '{"v":"5.7","layers":[],"assets":[{"p":"https://unowned.invalid/image"}]}']) {
    it('refuses malformed/unsupported content and zeroes owned partial decode allocations', async () => {
      const ctx = context(), zeroed: Uint8Array[] = []
      const fill = Uint8Array.prototype.fill
      vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (this: Uint8Array, value: number, ...args: [number?, number?]) {
        const result = fill.call(this, value, ...args)
        if (value === 0) zeroed.push(this)
        return result
      })
      vi.mocked(call).mockResolvedValue(result(ctx, { 'animation.json': new TextEncoder().encode(text) }))
      await expect(load(ctx)).rejects.toThrow()
      expect(zeroed.length).toBeGreaterThanOrEqual(2)
      expect(zeroed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
    })
  }
  for (const boundary of [0, 1, 2]) {
    it(`revocation at await ${boundary} never publishes a Blob`, async () => {
      const ctx = context(); let current = true; let digests = 0
      vi.stubGlobal('crypto', { subtle: { digest: async (...args: Parameters<SubtleCrypto['digest']>) => {
        const bytes = await webcrypto.subtle.digest(args[0], args[1] as Parameters<typeof webcrypto.subtle.digest>[1]); if (++digests === boundary) current = false; return bytes
      } } })
      vi.mocked(call).mockImplementation(async () => { if (boundary === 0) current = false; return result(ctx) })
      await expect(load(ctx, () => current)).rejects.toThrow()
    })
  }
  it('refuses missing acknowledgement and contradictory namespaces without asking the host', async () => {
    const ctx = context(); ctx.project.graphDigest = null
    await expect(load(ctx)).rejects.toThrow(); expect(call).not.toHaveBeenCalled()
    ctx.project.graphDigest = 'b'.repeat(64)
    ;(ctx.project.graph as Record<string, unknown>).studioVectorDependencies = { bindings: [{ parent: { id, kind: 'vector-graphic', checksum: 'a'.repeat(64) } }] }
    await expect(load(ctx)).rejects.toThrow(); expect(call).not.toHaveBeenCalled()
  })
})

describe('closed source allocation and complete inventories', () => {
  it('refuses UTF8 replacement, incomplete archives and unsupported retained resources', async () => {
    const ctx = context()
    const cases = [
      { 'animation.json': new Uint8Array([255]) },
      { ...archiveFiles('2'), 'a/selected.json': undefined },
      { ...archiveFiles('2'), 'i/unsupported.svg': new TextEncoder().encode('<svg/>') },
      { ...archiveFiles('2'), 'f/unsupported.ttf': new Uint8Array([1,2,3,4]) },
    ]
    for (const files of cases) {
      const present = Object.fromEntries(Object.entries(files).filter((entry) => entry[1] !== undefined)) as Record<string, Uint8Array>
      vi.mocked(call).mockResolvedValue(result(ctx, present))
      await expect(load(ctx)).rejects.toThrow()
    }
  })
  it('refuses every bounded allocation gate before constructing any source URL', async () => {
    const ctx = context(), good = result(ctx)
    const entries = Array.from({ length: 257 }, (_, index) => ({ ...good.files[0]!, path: `a/${index}.json` }))
    const tooEncoded = 'AAAA'.repeat(6 * 1024 * 1024 + 1)
    const tooDecoded = 'AAAA'.repeat(6 * 1024 * 1024)
    const tooAllocated = 'AAAA'.repeat(3 * 1024 * 1024)
    const create = vi.fn()
    const NativeURL = URL
    vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = create })
    for (const files of [entries, [{ ...good.files[0]!, base64: tooEncoded }], [{ ...good.files[0]!, base64: tooDecoded }], [{ ...good.files[0]!, base64: tooAllocated }]]) {
      vi.mocked(call).mockResolvedValue(resign({ ...good, files }))
      await expect(load(ctx)).rejects.toThrow()
    }
    expect(create).not.toHaveBeenCalled()
  })
})
