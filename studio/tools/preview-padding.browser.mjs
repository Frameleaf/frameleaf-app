// Exact edge extension on real Canvas pixels; this does not test DOM/render parity.
// Run against the prepared engine's existing Vite /headless.html entry.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs'

const require = createRequire(new URL('../engine/package.json', import.meta.url))
const { chromium } = require('playwright')
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186'
let browser
let report
try {
  browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() })
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  await page.goto(`${origin}/headless.html`)
  report = await page.evaluate(async () => {
    const { drawSourceToPreviewDisplayCanvas, copyPreviewDisplayCanvasContent } =
      await import('/src/features/preview/utils/preview-display-canvas.ts')
    const cases = []
    for (const transparent of [false, true]) {
      for (const [padX, padY] of [
        [4, 4],
        [0, 0],
        [4, 0],
        [0, 4],
      ]) {
        for (const smoothing of [true, false]) {
          const width = 5
          const height = 4
          const source = new OffscreenCanvas(width, height)
          const sourceCtx = source.getContext('2d')
          const seed = sourceCtx.createImageData(width, height)
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const offset = (y * width + x) * 4
              seed.data.set(
                transparent
                  ? [x % 2 ? 255 : 0, y % 2 ? 255 : 0, 255, [0, 128, 255][(x + y) % 3]]
                  : [
                      (x * 41 + y * 17) % 256,
                      (x * 23 + y * 53) % 256,
                      (x * 67 + y * 11) % 256,
                      255,
                    ],
                offset,
              )
            }
          }
          sourceCtx.putImageData(seed, 0, 0)
          // Expected transparent color values come from actual Canvas readback.
          const expectedSource = sourceCtx.getImageData(0, 0, width, height).data
          const display = document.createElement('canvas')
          display.width = width + padX * 2
          display.height = height + padY * 2
          const ctx = display.getContext('2d')
          ctx.imageSmoothingEnabled = smoothing
          ctx.imageSmoothingQuality = smoothing ? 'high' : 'low'
          const beforeState = {
            enabled: ctx.imageSmoothingEnabled,
            quality: ctx.imageSmoothingQuality,
          }
          drawSourceToPreviewDisplayCanvas(ctx, display, source)
          const actual = ctx.getImageData(0, 0, display.width, display.height).data
          const expected = new Uint8ClampedArray(actual.length)
          for (let y = 0; y < display.height; y++) {
            for (let x = 0; x < display.width; x++) {
              const sx = Math.max(0, Math.min(width - 1, x - padX))
              const sy = Math.max(0, Math.min(height - 1, y - padY))
              const offset = (sy * width + sx) * 4
              expected.set(expectedSource.subarray(offset, offset + 4), (y * display.width + x) * 4)
            }
          }
          const snapshot = new OffscreenCanvas(width, height)
          const snapshotCtx = snapshot.getContext('2d')
          copyPreviewDisplayCanvasContent(display, snapshotCtx)
          const snapshotPixels = snapshotCtx.getImageData(0, 0, width, height).data
          const sourceAfter = sourceCtx.getImageData(0, 0, width, height).data
          const differences = []
          for (let i = 0; i < actual.length; i++) {
            if (actual[i] !== expected[i])
              differences.push({ channel: i, expected: expected[i], actual: actual[i] })
          }
          const countDifferences = (left, right) =>
            left.reduce((count, value, index) => count + Number(value !== right[index]), 0)
          cases.push({
            transparent,
            padX,
            padY,
            smoothing,
            beforeState,
            afterState: { enabled: ctx.imageSmoothingEnabled, quality: ctx.imageSmoothingQuality },
            differentChannels: differences.length,
            differences,
            snapshotDifferentChannels: countDifferences(snapshotPixels, expectedSource),
            sourceDifferentChannels: countDifferences(sourceAfter, expectedSource),
            source: Array.from(expectedSource),
            actual: Array.from(actual),
            expected: Array.from(expected),
          })
        }
      }
    }
    return { measuredAt: new Date().toISOString(), cases }
  })
  assert.equal(report.cases.length, 16)
  for (const entry of report.cases) {
    const label = JSON.stringify({
      transparent: entry.transparent,
      padX: entry.padX,
      padY: entry.padY,
      smoothing: entry.smoothing,
    })
    assert.equal(entry.differentChannels, 0, `Exact clamped RGBA: ${label}`)
    assert.equal(entry.snapshotDifferentChannels, 0, `Snapshot content: ${label}`)
    assert.equal(entry.sourceDifferentChannels, 0, `Source unchanged: ${label}`)
    assert.deepEqual(entry.afterState, entry.beforeState, `Context restored: ${label}`)
  }
  console.log(
    `Preview padding: ${report.cases.length} real Canvas cases, exact clamped RGBA, snapshot/source/state preserved`,
  )
} catch (error) {
  report = { ...report, error: { name: error.name, message: error.message } }
  throw error
} finally {
  try {
    if (process.env.PREVIEW_PADDING_REPORT) {
      await writeFile(process.env.PREVIEW_PADDING_REPORT, `${JSON.stringify(report, null, 2)}\n`)
    }
  } finally {
    await browser?.close()
  }
}
