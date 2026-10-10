import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { decompressFrames, parseGIF } from 'gifuct-js'
import { gifFrameCache } from '@/features/timeline/services/gif-frame-cache'
import { getGifFrames } from '@/infrastructure/storage/workspace-fs/gif-frames'
import { setWorkspaceRoot } from '@/infrastructure/storage/workspace-fs/root'
import { VirtualWorkspace } from '../src/virtual-workspace'

// Original 3x1 GIF: transparent/red/green/blue palette; each LZW pixel starts with a clear code.
const gifHex = [
  '47494638396103000100810000000000ff000000ff000000ff',
  '21f90401020000002c00000000030001000002030cc31400', // 0: red red red, retain
  '21f90405030000002c0100000001000100000202540100', // 1: green at x=1, retain
  '21f90409040000002c00000000020001000002021c5100', // 2: blue/transparent, clear x=0..1
  '21f9040d050000002c0200000001000100000202540100', // 3: green at x=2, restore
  '21f9040d060000002c00000000010001000002025c0100', // 3: blue at x=0, restore again
  '21f90405070000002c0100000001000100000202540100', // 1: green at x=1 reveals both restores
  '3b',
].join('')
const gif = Uint8Array.from(gifHex.match(/../g)!, (byte) => Number.parseInt(byte, 16))
const red = [255, 0, 0, 255]
const green = [0, 255, 0, 255]
const blue = [0, 0, 255, 255]
const transparent = [0, 0, 0, 0]
const expectedPixels = [
  [...red, ...red, ...red],
  [...red, ...green, ...red],
  [...blue, ...green, ...red],
  [...transparent, ...transparent, ...green],
  [...blue, ...transparent, ...red],
  [...transparent, ...green, ...red],
]
const expectedDelays = [20, 30, 40, 50, 60, 70]

// shortcut: only this fixture's one-row binary-alpha canvas operations, use real browser pixels for qualification.
class FixtureCanvas {
  private columns = 0
  pixels = new Uint8ClampedArray(0)

  get width() {
    return this.columns
  }
  set width(value: number) {
    expect(value).toBeGreaterThanOrEqual(1)
    expect(value).toBeLessThanOrEqual(3)
    this.columns = value
    this.pixels = new Uint8ClampedArray(value * 4)
  }
  get height() {
    return 1
  }
  set height(value: number) {
    expect(value).toBe(1)
    this.pixels = new Uint8ClampedArray(this.width * 4)
  }
  getContext(kind: string) {
    expect(kind).toBe('2d')
    return this
  }
  clearRect(x: number, y: number, width: number, height: number) {
    expect([y, height]).toEqual([0, 1])
    expect(x + width).toBeLessThanOrEqual(this.width)
    this.pixels.fill(0, x * 4, (x + width) * 4)
  }
  getImageData(x: number, y: number, width: number, height: number) {
    expect([x, y, width, height]).toEqual([0, 0, this.width, 1])
    return new ImageData(this.pixels.slice(), this.width, 1)
  }
  putImageData(image: ImageData, x: number, y: number) {
    expect([x, y, image.width, image.height]).toEqual([0, 0, this.width, 1])
    this.pixels.set(image.data)
  }
  drawImage(source: FixtureCanvas, x: number, y: number) {
    expect(y).toBe(0)
    expect(x + source.width).toBeLessThanOrEqual(this.width)
    for (let column = 0; column < source.width; column++) {
      const pixel = source.pixels.subarray(column * 4, (column + 1) * 4)
      expect([0, 255]).toContain(pixel[3])
      if (pixel[3] === 255) this.pixels.set(pixel, (x + column) * 4)
    }
  }
  toBlob(callback: BlobCallback, type: string) {
    expect(type).toBe('image/png')
    // Raw RGBA boundary payload, deliberately not a PNG encoder or browser decode claim.
    callback(new Blob([this.pixels.slice()], { type: 'application/x-test-rgba' }))
  }
}

type FixtureBitmap = ImageBitmap & { pixels: number[] }

beforeEach(() => {
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  setWorkspaceRoot(new VirtualWorkspace().handle())
})
afterEach(() => {
  gifFrameCache.dispose()
  setWorkspaceRoot(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('GIF disposal component contract on the adapter workspace', () => {
  it('checks the narrow canvas boundary independently', () => {
    const canvas = new FixtureCanvas()
    canvas.width = 3
    canvas.putImageData(
      new ImageData(new Uint8ClampedArray([...red, ...green, ...blue]), 3, 1),
      0,
      0,
    )
    const saved = canvas.getImageData(0, 0, 3, 1)
    const patch = new FixtureCanvas()
    patch.width = 2
    patch.putImageData(new ImageData(new Uint8ClampedArray([...transparent, ...red]), 2, 1), 0, 0)
    canvas.drawImage(patch, 1, 0)
    expect([...canvas.pixels]).toEqual([...red, ...green, ...red])
    canvas.clearRect(1, 0, 1, 1)
    expect([...canvas.pixels]).toEqual([...red, ...transparent, ...red])
    expect([...saved.data]).toEqual([...red, ...green, ...blue])
    canvas.putImageData(saved, 0, 0)
    expect([...canvas.pixels]).toEqual([...red, ...green, ...blue])
    canvas.width = 1
    canvas.pixels.set(blue)
    canvas.height = 1
    expect([...canvas.pixels]).toEqual(transparent)
  })

  it('parses original GIF bytes, composites disposal 0/1/2/3 and reloads the same pixels and timing', async () => {
    expect(createHash('sha256').update(gif).digest('hex')).toBe(
      'd0951a5ffb79f6eab69e55f1e0ee428991238ffa87197c59e0f3ede841528d24',
    )
    const decoded = decompressFrames(parseGIF(gif.buffer), true)
    expect(decoded.map((frame) => frame.disposalType)).toEqual([0, 1, 2, 3, 3, 1])
    expect(decoded.map((frame) => frame.delay)).toEqual(expectedDelays)
    expect(decoded.map((frame) => [frame.dims.left, frame.dims.width])).toEqual([
      [0, 3],
      [1, 1],
      [0, 2],
      [2, 1],
      [0, 1],
      [1, 1],
    ])
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'canvas' ? new FixtureCanvas() : createElement(tag)) as typeof document.createElement)
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(
        async (blob: Blob): Promise<FixtureBitmap> =>
          ({
            pixels: [...new Uint8Array(await blob.arrayBuffer())],
            width: 3,
            height: 1,
            close: vi.fn(),
          }) as FixtureBitmap,
      ),
    )
    const fetchGif = vi.fn(async () => ({ arrayBuffer: async () => gif.buffer.slice(0) }))
    vi.stubGlobal('fetch', fetchGif)

    const extracted = await gifFrameCache.getGifFrames('gif-disposal', 'blob:original-gif')
    expect(extracted.frames.map((frame) => (frame as FixtureBitmap).pixels)).toEqual(expectedPixels)
    expect(extracted.durations).toEqual(expectedDelays)
    expect(extracted.cumulativeDelays).toEqual([0, 20, 50, 90, 140, 200, 270])
    expect([
      extracted.width,
      extracted.height,
      extracted.totalDuration,
      extracted.isComplete,
    ]).toEqual([3, 1, 270, true])
    for (const [time, index] of [
      [0, 0],
      [19, 0],
      [20, 1],
      [49, 1],
      [50, 2],
      [89, 2],
      [90, 3],
      [139, 3],
      [140, 4],
      [199, 4],
      [200, 5],
      [269, 5],
      [270, 0],
      [-1, 5],
      [-270, 0],
    ]) {
      expect(gifFrameCache.getFrameAtTime(extracted, time!).index).toBe(index)
      expect(
        (gifFrameCache.getFrameAtTime(extracted, time!).frame as FixtureBitmap).pixels,
      ).toEqual(expectedPixels[index!])
    }
    expect((await getGifFrames('gif-disposal'))?.durations).toEqual(expectedDelays)
    gifFrameCache.clearAll()
    for (const frame of extracted.frames) expect(frame.close).toHaveBeenCalledOnce()
    fetchGif.mockRejectedValue(new Error('Reload must use persisted GIF frames'))
    const reloaded = await gifFrameCache.getGifFrames('gif-disposal', 'blob:unavailable')
    expect(fetchGif).toHaveBeenCalledOnce()
    expect(reloaded.frames.map((frame) => (frame as FixtureBitmap).pixels)).toEqual(expectedPixels)
    expect(reloaded.durations).toEqual(expectedDelays)
    expect(reloaded.cumulativeDelays).toEqual([0, 20, 50, 90, 140, 200, 270])
    expect(reloaded.totalDuration).toBe(270)
    expect(reloaded.isComplete).toBe(true)
  })
})
