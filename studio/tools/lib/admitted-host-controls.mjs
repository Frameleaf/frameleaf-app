import assert from 'node:assert/strict';

const button = label => `button[aria-label=${JSON.stringify(label)}]`;
const preview = '[data-player-container]:has([data-player-container])';

async function nativeFrame15(frame) {
  for (let i = 0; i <= 15; i++) {
    await frame.click(button(i === 0 ? 'Go To Start' : 'Next Frame'));
    const expected = `00:00:${String(i).padStart(2, '0')}/00:01:29`;
    const deadline = Date.now() + 30000;
    for (;;) {
      const count = await frame.evaluate(expected => [...document.querySelectorAll('button')]
        .filter(b => b.checkVisibility() && b.textContent.replace(/\s/g, '') === expected).length, expected);
      if (count === 1) break;
      assert.ok(Date.now() < deadline, `native timecode acknowledgement ${expected}: ${count} visible buttons`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

export async function openAutoKeyControls(frame) {
  await frame.waitForFunction(() => !!document.querySelector('[data-item-id="still"]'));
  await frame.click('[data-item-id="still"]');
  const open = await frame.evaluate(() => !!document.querySelector(
    '[role="toolbar"][aria-label="Controls"] button[aria-label="Hide keyframe panel"][aria-pressed="true"]'));
  if (!open) await frame.click('[role="toolbar"][aria-label="Controls"] button[aria-label="Show keyframe panel"]');
  await frame.waitForFunction(() => !!document.querySelector('[data-testid="dopesheet-scroll-area"] input[aria-label="Position X"]'));
  await nativeFrame15(frame);
}

/** Native controls only; witness reads never mutate the project or substitute an input event. */
export async function editHostScenario(frame, scenario) {
  assert.ok(['track', 'auto-key'].includes(scenario));
  if (scenario === 'auto-key') {
    await openAutoKeyControls(frame);
    await frame.click('[data-testid="dopesheet-scroll-area"] ' + button('Enable auto-key for Position'));
    await frame.fill('[data-testid="dopesheet-scroll-area"] input[aria-label="Position X"]', '12');
    await frame.click('[data-testid="dopesheet-scroll-area"] ' + button('Auto-key enabled for Position'));
    await frame.waitForFunction(() => window.__hostWitness?.some(w => w.args?.[0]?.timeline?.keyframes?.some(e =>
      e.itemId === 'still' && e.vectorProperties?.some(l => l.keyframes?.some(k => k.frame === 15)))));
  } else {
    await frame.waitForFunction(() => !!document.querySelector('button[aria-label="Disable track"]'));
    await frame.click(button('Disable track'));
    await frame.waitForFunction(() => !!document.querySelector('button[aria-label="Enable track"]') &&
      window.__hostWitness?.some(w => w.args?.[0]?.timeline?.tracks?.[0]?.visible === false));
    await frame.click('button[aria-label="Undo"],button[aria-label^="Undo "]');
    await frame.waitForFunction(() => !!document.querySelector('button[aria-label="Disable track"]') &&
      window.__hostWitness?.some(w => w.args?.[0]?.timeline?.tracks?.[0]?.visible === true));
    await frame.click(button('Lock Track'));
    await frame.waitForFunction(() => !!document.querySelector('button[aria-label="Unlock Track"]') &&
      window.__hostWitness?.some(w => w.args?.[0]?.timeline?.tracks?.[0]?.visible === true && w.args[0].timeline.tracks[0].locked === true));
  }
  await frame.click(button('Save project'));
}

export async function deselectPreview(frame) {
  const geometry = await frame.evaluate(selector => {
    const background = [...document.querySelectorAll('[aria-label="Video Preview"]')].filter(e => e.checkVisibility());
    const viewports = [...document.querySelectorAll(selector)].filter(e => e.checkVisibility());
    if (background.length !== 1 || viewports.length !== 1) throw new Error('one visible native background and viewport required');
    const bounds = e => { const {x, y, width, height} = e.getBoundingClientRect(); return {x, y, width, height}; };
    return {backgroundBounds: bounds(background[0]), viewportBounds: bounds(viewports[0])};
  }, preview);
  const {backgroundBounds, viewportBounds} = geometry;
  const point = {x: backgroundBounds.x + 5, y: backgroundBounds.y + 5};
  assert.ok(point.x < viewportBounds.x || point.x >= viewportBounds.x + viewportBounds.width ||
    point.y < viewportBounds.y || point.y >= viewportBounds.y + viewportBounds.height,
  'native background click must be outside the rendered viewport');
  await frame.click('[aria-label="Video Preview"]', {position: {x: 5, y: 5}});
  await frame.waitForFunction(() => !document.querySelector('button[aria-label="Move selected element"]') &&
    !document.querySelector('[data-testid="motion-path-overlay"]'));
  assert.equal(await frame.evaluate(() => [...document.querySelectorAll('button')].filter(b =>
    b.checkVisibility() && b.textContent.replace(/\s/g, '') === '00:00:15/00:01:29').length), 1);
  return {...geometry, point};
}

/** Measure the actual PNG screenshot crop from iframe + viewport CSS bounds, including device scale. */
export async function captureHostPreview(host) {
  const geometry = await host.inFrame('[data-testid="studio-editor-frame"]', frame => frame.evaluate(selector => {
    const viewports = [...document.querySelectorAll(selector)].filter(e => e.checkVisibility());
    if (viewports.length !== 1) throw new Error('one visible native preview required');
    const {x, y, width, height} = viewports[0].getBoundingClientRect();
    return {bounds: {x, y, width, height}, children: [...viewports[0].querySelectorAll('canvas,img,video')].map(e => ({
      tag: e.tagName, width: e.width, height: e.height, visible: e.checkVisibility(),
    }))};
  }, preview));
  const layout = await host.evaluate(() => {
    const frame = document.querySelector('[data-testid="studio-editor-frame"]');
    const {x, y} = frame.getBoundingClientRect();
    return {x: x + frame.clientLeft, y: y + frame.clientTop, width: innerWidth, height: innerHeight};
  });
  const screenshotPng = Buffer.from(await host.screenshot(), 'base64');
  assert.ok(screenshotPng.length >= 24 && screenshotPng.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    screenshotPng.toString('ascii', 12, 16) === 'IHDR', 'actual browser PNG screenshot required');
  const image = {width: screenshotPng.readUInt32BE(16), height: screenshotPng.readUInt32BE(20)};
  const scale = image.width / layout.width;
  assert.ok(Number.isFinite(scale) && scale > 0 && Math.abs(image.height / layout.height - scale) < 0.01,
    'browser screenshot must match viewport device scale');
  const left = Math.floor((layout.x + geometry.bounds.x) * scale);
  const top = Math.floor((layout.y + geometry.bounds.y) * scale);
  const right = Math.ceil((layout.x + geometry.bounds.x + geometry.bounds.width) * scale);
  const bottom = Math.ceil((layout.y + geometry.bounds.y + geometry.bounds.height) * scale);
  assert.ok(left >= 0 && top >= 0 && right <= image.width && bottom <= image.height && right > left && bottom > top,
    'entire native preview must be visible in the actual browser screenshot');
  const crop = {left, top, width: right - left, height: bottom - top};
  return {...geometry, deviceScale: scale, screenshotCrop: crop, screenshotPng};
}
