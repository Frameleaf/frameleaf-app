// FL-639: Cut out the subject. Real Chromium Canvas2D readback of the engine's cut-out compositor
// (`features/export/utils/subject-cutout.ts`), which preview and export both draw clips through.
// A red clip is cut out with a matte whose left half is the subject; each background is checked by
// pixel well inside each half, as is the blend between two matte frames and the clip's rotation.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await browser.newPage();
  await page.route(origin + '/subject-cutout-probe', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Subject cut-out regression</title>' }),
  );
  await page.goto(origin + '/subject-cutout-probe');
  const results = await page.evaluate(async () => {
    const { renderVideoWithSubjectCutout, cutoutImageItem } = await import('/src/features/export/utils/subject-cutout.ts');
    const { CanvasPool } = await import('/src/features/export/utils/canvas-pool.ts');
    const W = 64;
    const H = 36;
    // Two 16x9 matte frames side by side: frame 0 keeps the left half, frame 1 keeps the left quarter.
    const atlas = new OffscreenCanvas(32, 9);
    const atlasContext = atlas.getContext('2d');
    atlasContext.fillStyle = '#000';
    atlasContext.fillRect(0, 0, 32, 9);
    atlasContext.fillStyle = '#fff';
    atlasContext.fillRect(0, 0, 8, 9);
    atlasContext.fillRect(16, 0, 4, 9);
    const photo = new OffscreenCanvas(8, 8);
    const photoContext = photo.getContext('2d');
    photoContext.fillStyle = 'rgb(0, 200, 0)';
    photoContext.fillRect(0, 0, 8, 8);
    const matte = { importId: 'matte', startSeconds: 0, durationSeconds: 0.2, fps: 10, frames: 2, columns: 2, frameWidth: 16, frameHeight: 9 };
    const item = {
      id: 'clip', type: 'video', trackId: 'v1', from: 0, durationInFrames: 6, label: 'Clip', src: '', mediaId: 'media',
      sourceStart: 0, sourceFps: 30, sourceWidth: 1920, sourceHeight: 1080,
    };
    const run = async ({ background, frame = 0, rotation = 0, colour }) => {
      const cutoutItem = { ...item, subjectCutout: {
        subject: { kind: 'subject' }, background, softness: 0, matte, colour, photo: { mediaId: 'photo' },
      } };
      const imageElements = new Map([
        [cutoutImageItem(cutoutItem, 'matte', 'matte').id, { source: atlas, width: 32, height: 9 }],
        [cutoutImageItem(cutoutItem, 'photo', 'photo').id, { source: photo, width: 8, height: 8 }],
      ]);
      const rctx = {
        fps: 30, renderMode: 'export', canvasSettings: { width: W, height: H, fps: 30 },
        canvasPool: new CanvasPool(W, H, 2, 6), imageElements, ensureImageItemReady: async () => {},
      };
      const target = new OffscreenCanvas(W, H);
      const ctx = target.getContext('2d');
      ctx.fillStyle = 'rgb(0, 0, 255)';
      ctx.fillRect(0, 0, W, H); // a blue clip beneath
      if (rotation) {
        ctx.translate(W / 2, H / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.translate(-W / 2, -H / 2);
      }
      const drawn = await renderVideoWithSubjectCutout(
        ctx, cutoutItem, { x: 0, y: 0, width: W, height: H, rotation, opacity: 1, cornerRadius: 0 }, frame, rctx, 0, undefined,
        async (context) => {
          context.fillStyle = 'rgb(255, 0, 0)';
          context.fillRect(0, 0, W, H);
          return true;
        },
      );
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
      return { drawn, left: pixel(8, 18), right: pixel(56, 18), quarter: pixel(24, 18) };
    };
    return {
      remove: await run({ background: 'remove' }),
      colour: await run({ background: 'colour', colour: '#1f6feb' }),
      photo: await run({ background: 'photo' }),
      blur: await run({ background: 'blur' }),
      // Frame 1 is 1/30 s in: one third of the way from matte frame 0 to matte frame 1.
      between: await run({ background: 'remove', frame: 1 }),
      rotated: await run({ background: 'remove', rotation: 180 }),
    };
  });
  const near = (actual, expected, label, tolerance = 3) =>
    assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance),
      `${label}: ${actual.join(',')} != ${expected.join(',')}`);
  for (const [name, result] of Object.entries(results)) assert.equal(result.drawn, true, `${name} drew`);
  // Remove: the subject over the clip beneath; the rest of the clip is see-through.
  near(results.remove.left, [255, 0, 0, 255], 'remove subject');
  near(results.remove.right, [0, 0, 255, 255], 'remove background shows the clip beneath');
  near(results.colour.right, [31, 111, 235, 255], 'colour background');
  near(results.colour.left, [255, 0, 0, 255], 'colour subject');
  near(results.photo.right, [0, 200, 0, 255], 'photo background');
  // Blur of a uniform clip stays the clip, inside its own frame.
  near(results.blur.right, [255, 0, 0, 255], 'blur background');
  // Two thirds of frame 0 (subject at x=24) and one third of frame 1 (background there).
  near(results.between.quarter, [Math.round(255 * 2 / 3), 0, Math.round(255 / 3), 255], 'blend between matte frames', 8);
  // Turned half a turn, the subject (the clip's left half) is on the right of the canvas.
  near(results.rotated.right, [255, 0, 0, 255], 'rotated subject');
  near(results.rotated.left, [0, 0, 255, 255], 'rotated background');
  console.log(JSON.stringify({ check: 'subject cut-out backgrounds, matte blend and transform', cases: Object.keys(results).length,
    manifestIds: ['readme.effects-masks-compositing.5'] }));
} finally {
  await browser.close();
}
