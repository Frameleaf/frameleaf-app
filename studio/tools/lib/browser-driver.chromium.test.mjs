// FL-112: proves the design's own gate - "before any Firefox or Safari row counts, Chromium must
// produce byte-identical reports through the new harness" - using the exact shape every simple
// `*.browser.mjs` matrix script already follows (serve a synthetic entrypoint at a fixed path,
// navigate to it, `page.evaluate` a real module import + computation, collect a JSON report).
// It stands in for the real engine/Vite dev server, which this checkout doesn't vendor (`studio/
// engine` isn't present outside a prepared build) - the point being proven is the *mechanism*
// (proxy-routed override + real-origin module load produces the same bytes as `page.route`), not
// any particular script's real computation, which studio-color/studio-editing own.
//
// Needs a real Chromium binary; skips itself if Playwright can't launch one. Resolves the same
// way the real matrix scripts do - rooted at the prepared engine's own install
// (studio/engine/package.json) - so this actually runs wherever CI's own engine job does; a
// checkout without a prepared engine (studio/engine isn't vendored until `engine.mjs prepare` +
// `npm ci` run) skips it instead of failing, matching the module-level tests in
// browser-driver.test.mjs and cross-browser-harness.test.mjs, which cover the logic without a
// browser at all (studio-editing, FL-112 review, 2026-09-30).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createHarness } from './cross-browser-harness.mjs';
import { createChromiumDriver } from './browser-driver.mjs';
import { captureHostPreview, deselectPreview, editHostScenario } from './admitted-host-controls.mjs';

const require = createRequire(new URL('../../engine/package.json', import.meta.url));

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  // studio/engine isn't prepared in this checkout - see the module doc above.
}

async function startFakeStudioServer() {
  // Stands in for the real Vite dev server: serves one "module" a matrix script would import.
  const server = http.createServer((req, res) => {
    if (req.url === '/src/fake-matrix-module.mjs') {
      res.setHeader('content-type', 'text/javascript');
      res.end('export const computeReport = () => ({ deterministic: 2 + 2, ranAt: "fake-module" });');
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0);
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// The exact pattern every simple matrix script follows: a page.evaluate callback that imports a
// real same-origin module and returns a JSON report. Kept as one shared function so both the
// "current" (page.route) and "harness" paths run the literal same evaluate step.
const evaluateReport = async () => {
  const { computeReport } = await import('/src/fake-matrix-module.mjs');
  return computeReport();
};

async function runCurrentPattern(studioOrigin) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route(studioOrigin + '/fake-matrix', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Fake matrix</title>' }),
    );
    await page.goto(studioOrigin + '/fake-matrix');
    return await page.evaluate(evaluateReport);
  } finally {
    await browser.close();
  }
}

async function runHarnessPattern(studioOrigin) {
  const harness = createHarness({
    upstream: studioOrigin,
    overrides: [
      {
        test: (url) => url.pathname === '/fake-matrix',
        respond: () => ({ contentType: 'text/html', body: '<title>Fake matrix</title>' }),
      },
    ],
  });
  const harnessOrigin = await harness.listen();
  const driver = await createChromiumDriver({ harnessOrigin, chromium });
  try {
    const page = await driver.newPage();
    await page.goto(studioOrigin + '/fake-matrix');
    const report = await page.evaluate(evaluateReport);
    return { report, observations: harness.observations };
  } finally {
    await driver.close();
    await harness.close();
  }
}

test(
  'Chromium produces a byte-identical report through the harness as through direct page.route()',
  { skip: !chromium && 'no Playwright chromium available in this environment' },
  async () => {
    const studio = await startFakeStudioServer();
    try {
      const [current, harnessed] = await Promise.all([
        runCurrentPattern(studio.url),
        runHarnessPattern(studio.url),
      ]);
      assert.deepEqual(harnessed.report, current);
      assert.deepEqual(harnessed.report, { deterministic: 4, ranAt: 'fake-module' });
      // The entrypoint went through the override, the real module load proxied through untouched.
      assert.deepEqual(
        harnessed.observations.map((o) => o.kind),
        ['override', 'proxied'],
      );
    } finally {
      await studio.close();
    }
  },
);

test('shared host controls use trusted input and screenshot crops include iframe offsets and device scale',
  {skip: !chromium && 'no Playwright chromium available in this environment'}, async () => {
    // Synthetic DOM contract only: no engine, GPU, admission, backend revision or media qualification.
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.url === '/host') {
        res.end('<body style="margin:0;background:blue"><iframe data-testid="studio-editor-frame" src="/controls" style="position:absolute;left:90px;top:80px;width:800px;height:620px;border:3px solid black"></iframe>');
        return;
      }
      res.end(`<body style="margin:0">
        <button aria-label="Disable track">track</button><button aria-label="Undo track">undo</button>
        <button aria-label="Lock Track">lock</button><button aria-label="Save project">save</button>
        <button data-item-id="still">still</button>
        <div role="toolbar" aria-label="Controls"><button aria-label="Show keyframe panel">keys</button></div>
        <button aria-label="Go To Start">start</button><button aria-label="Next Frame">next</button>
        <button id="time">00:00:00 / 00:01:29</button>
        <div data-testid="dopesheet-scroll-area"><button aria-label="Enable auto-key for Position">auto</button><input aria-label="Position X" value="0"></div>
        <div aria-label="Video Preview" style="position:absolute;left:20px;top:120px;width:700px;height:450px;background:#111">
          <div data-player-container style="position:absolute;left:30px;top:30px;width:320px;height:180px;background:#cc4422"><div data-player-container></div></div>
          <button aria-label="Move selected element" style="position:absolute;left:50px;top:60px">selected</button><div data-testid="motion-path-overlay"></div>
        </div><script>
          window.state = {visible:true,locked:false,value:0,frame:0,saves:0,background:null};
          window.__hostWitness = [];
          window.trust = [];
          const buttons = [...document.querySelectorAll('button')];
          const byLabel = label => buttons.find(b => b.getAttribute('aria-label') === label);
          const draft = () => window.__hostWitness.push({args:[{timeline:{tracks:[{visible:state.visible,locked:state.locked}]}}]});
          byLabel('Disable track').onclick = function() {state.visible=!state.visible;this.setAttribute('aria-label',state.visible?'Disable track':'Enable track');draft();};
          byLabel('Undo track').onclick = () => {state.visible=true;buttons[0].setAttribute('aria-label','Disable track');draft();};
          byLabel('Lock Track').onclick = function() {state.locked=true;this.setAttribute('aria-label','Unlock Track');draft();};
          byLabel('Save project').onclick = () => state.saves++;
          byLabel('Show keyframe panel').onclick = function() {this.setAttribute('aria-label','Hide keyframe panel');this.setAttribute('aria-pressed','true');};
          byLabel('Go To Start').onclick = () => {state.frame=0;time.textContent='00:00:00 / 00:01:29';};
          byLabel('Next Frame').onclick = () => {state.frame++;time.textContent='00:00:'+String(state.frame).padStart(2,'0')+' / 00:01:29';};
          byLabel('Enable auto-key for Position').onclick = function() {this.setAttribute('aria-label',this.getAttribute('aria-label').startsWith('Enable')?'Auto-key enabled for Position':'Enable auto-key for Position');};
          document.querySelector('input').oninput = event => {state.value=Number(event.target.value);window.__hostWitness.push({args:[{timeline:{keyframes:[{itemId:'still',vectorProperties:[{keyframes:[{frame:state.frame,value:state.value}]}]}]}}]});};
          document.querySelector('[aria-label="Video Preview"]').onclick = event => {state.background={x:event.clientX,y:event.clientY};document.querySelector('[aria-label="Move selected element"]')?.remove();document.querySelector('[data-testid="motion-path-overlay"]')?.remove();};
          for(const type of ['click','input']) document.addEventListener(type,event=>trust.push({type,trusted:event.isTrusted}));
        </script>`);
    });
    server.listen(0); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const harness = createHarness({upstream: origin});
    let driver;
    try {
      driver = await createChromiumDriver({harnessOrigin: await harness.listen(), chromium,
        contextOptions: {viewport: {width: 1000, height: 800}, deviceScaleFactor: 2}});
      const page = await driver.newPage();
      for(const scenario of ['track', 'auto-key']) {
        await page.goto(origin + '/host');
        await page.inFrame('[data-testid="studio-editor-frame"]', async frame => {
          await editHostScenario(frame, scenario);
          const result = await frame.evaluate(() => ({...state, trust}));
          assert.equal(result.saves, 1);
          assert.ok(result.trust.length && result.trust.every(event => event.trusted));
          if(scenario === 'track') {assert.equal(result.visible, true);assert.equal(result.locked, true);}
          else {
            assert.equal(result.value, 12); assert.equal(result.frame, 15);
            assert.ok(result.trust.some(event => event.type === 'input'));
            const deselection = await deselectPreview(frame);
            assert.deepEqual(await frame.evaluate(() => state.background), deselection.point);
          }
        });
        const shot = await captureHostPreview(page);
        assert.equal(shot.deviceScale, 2);
        assert.deepEqual(shot.screenshotCrop, {left:286,top:466,width:640,height:360});
        const center = await page.evaluate(async ({png, crop}) => {
          const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
          const canvas = new OffscreenCanvas(crop.width, crop.height), context = canvas.getContext('2d');
          context.drawImage(image, crop.left, crop.top, crop.width, crop.height, 0, 0, crop.width, crop.height);
          return [...context.getImageData(crop.width / 2, crop.height / 2, 1, 1).data];
        }, {png:shot.screenshotPng.toString('base64'),crop:shot.screenshotCrop});
        assert.deepEqual(center, [204,68,34,255]);
        await page.inFrame('[data-testid="studio-editor-frame"]', frame => frame.evaluate(() => {
          document.querySelector('[data-player-container]').style.left = '1200px';
        }));
        await assert.rejects(captureHostPreview(page), /entire native preview must be visible/);
      }
      assert.equal(harness.observations.filter(r => r.kind === 'override').length, 0);
    } finally {
      if(driver) await driver.close();
      await harness.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
