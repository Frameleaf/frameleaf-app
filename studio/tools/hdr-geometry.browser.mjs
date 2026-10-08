import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { probeBaseRaster, validateBaseRaster } from './geometry-raster-calibration.mjs';
import { probeGeometryCoordinates, validateGeometryCalibration } from './geometry-device-calibration.mjs';
import { geometryReference, HDR_GEOMETRY } from './geometry-reference.mjs';
import { testedSource } from './lib/working-domain-report.mjs';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const { chromium } = createRequire(new URL('../engine/package.json', import.meta.url))('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const source = await testedSource(new URL(import.meta.url));
const envelopeBytes=await readFile(new URL('./geometry-raster-envelopes.json',import.meta.url));
assert.equal(createHash('sha256').update(envelopeBytes).digest('hex'),'2489f7711756e8c30f7b98dd94475f881fdb460a0cfb373206ef1f8fceeb5382');
const envelopes=JSON.parse(envelopeBytes);
const quadText=await readFile(new URL('../engine/src/infrastructure/gpu-shared/fullscreen-quad.ts',import.meta.url),'utf8');
const quad=quadText.slice(quadText.indexOf('`',quadText.indexOf('export const FULLSCREEN_QUAD_WGSL'))+1,quadText.lastIndexOf('`'));
const quadSha256=createHash('sha256').update(quadText).digest('hex');
const W = 8, H = 6;
const input = Array.from({ length: W * H }, (_, i) => {
  const x = i % W, y = Math.floor(i / W), alpha = [0,.25,.5,1][(x+y)%4];
  return [x < 4 ? 8 : 32, y < 3 ? -.25 : 4, (x+y)%2 ? -2 : 2, alpha];
}).flat();
const cases = [
  ...[1,-10,10].map(amount => ({ type:'gpu-twirl', params:{amount,radius:.5,centerX:.5,centerY:.5} })),
  ...[.02,0,.1].map(amplitude => ({ type:'gpu-wave', params:{amplitudeX:amplitude,amplitudeY:amplitude,frequencyX:5,frequencyY:5} })),
  ...[.5,.1,3].map(amount => ({ type:'gpu-bulge', params:{amount,radius:.5,centerX:.5,centerY:.5} })),
];
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await browser.newPage();
  await page.route(origin + '/hdr-geometry', route => route.fulfill({ contentType: 'text/html', body: `<script type="module">
import R from '/@react-refresh'; R.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>x=>x; window.__vite_plugin_react_preamble_installed__=true;
</script>` }));
  await page.goto(origin + '/hdr-geometry');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  const report = await page.evaluate(async ({ W, H, input, cases, probeSource, baseProbeSource, baseValidateSource, quad, envelopes, binding }) => {
    const { EffectsPipeline } = await import('/src/infrastructure/gpu-effects/index.ts');
    const { createCompositionRenderer } = await import('/src/features/export/utils/client-render-engine.ts');
    const pipeline = await EffectsPipeline.create();
    if (!pipeline) throw new Error('WebGPU unavailable');
    pipeline.setWorkingRange('hdr');
    const device = pipeline.getDevice();
    const rasterCapture=await (0,eval)('('+baseProbeSource+')')(device,W,H,quad);
    const raster=(0,eval)('('+baseValidateSource+')')(rasterCapture,envelopes,binding);
    const probe = (0,eval)('(' + probeSource + ')');
    const calibration = await probe(device,W,H,cases);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT;
    const original = device.createTexture({ size: [W, H], format: 'rgba16float', usage });
    const output = device.createTexture({ size: [W, H], format: 'rgba16float', usage });
    const buffer = device.createBuffer({ size: 256 * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    device.queue.writeTexture({ texture: original }, new Float16Array(input), { bytesPerRow: W * 8 }, [W, H]);
    const rows = [];
    try {
      for (const entry of cases) {
        device.pushErrorScope('validation');
        const accepted = pipeline.applyTextureEffectsToTexture(original, [{ id: 'blur', ...entry, enabled: true }], output, W, H);
        if (!accepted) throw new Error('Effect refused');
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow: 256 }, [W, H]);
        device.queue.submit([encoder.finish()]);
        const error = await device.popErrorScope();
        if (error) throw new Error(error.message);
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = buffer.getMappedRange();
        const pixels = [];
        for (let y = 0; y < H; ++y) pixels.push(...new Float16Array(mapped, y * 256, W * 4));
        buffer.unmap();
        rows.push({ ...entry, pixels });
      }
      const tiny = 2 ** -24;
      const tinyInput = [32,4,-2,0,8,-.25,2,tiny,32,4,-2,0,32,4,-2,0];
      const tinyParams = {amplitudeX:0,amplitudeY:.1,frequencyX:1,frequencyY:1};
      const tinySource = device.createTexture({size:[2,2],format:'rgba16float',usage});
      const tinyOutput = device.createTexture({size:[2,2],format:'rgba16float',usage});
      const tinyBuffer = device.createBuffer({size:512,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const halfCoverage = {input:tinyInput,params:tinyParams,pixels:[]};
      try {
        device.queue.writeTexture({texture:tinySource},new Float16Array(tinyInput),{bytesPerRow:16},[2,2]);
        device.pushErrorScope('validation');
        if (!pipeline.applyTextureEffectsToTexture(tinySource,[{id:'tiny',type:'gpu-wave',enabled:true,params:tinyParams}],tinyOutput,2,2)) throw new Error('Tiny coverage wave refused');
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({texture:tinyOutput},{buffer:tinyBuffer,bytesPerRow:256},[2,2]);
        device.queue.submit([encoder.finish()]);
        const error = await device.popErrorScope();
        if (error) throw new Error(error.message);
        await tinyBuffer.mapAsync(GPUMapMode.READ);
        const mapped = tinyBuffer.getMappedRange();
        for (let y=0;y<2;y++) halfCoverage.pixels.push(...new Float16Array(mapped,y*256,8));
        tinyBuffer.unmap();
      } finally { tinySource.destroy(); tinyOutput.destroy(); tinyBuffer.destroy(); }
      const compositions = [];
      for (const entry of cases) {
        if (await EffectsPipeline.requestCachedDevice() !== device) throw Error('COMPOSITION_CALIBRATION_DEVICE_CHANGED');
        const image = { id: 'image', mediaId: 'image', type: 'image', trackId: 'track', from: 0,
          durationInFrames: 1, src: '', sourceWidth: W, sourceHeight: H,
          transform: { x: 0, y: 0, width: W, height: H, rotation: 0, opacity: 1 },
          effects: [{ id: 'blur', enabled: true, effect: { type: 'gpu-effect', gpuEffectType: entry.type, params: entry.params } }] };
        const composition = { fps: 30, width: W, height: H, durationInFrames: 1, backgroundColor: '#000000',
          colorManagement: { workingRange: 'hdr', referenceWhiteNits: 203, masteringPeakNits: 1000, sdrMonitoring: 'none' },
          tracks: [{ id: 'track', name: 'Photo', order: 0, visible: true, muted: false, solo: false, locked: false, height: 60, items: [image] }],
          keyframes: [], transitions: [] };
        const canvas = new OffscreenCanvas(W, H);
        const renderer = await createCompositionRenderer(composition, canvas, canvas.getContext('2d'), {
          mode: 'export', hdrRasters: { image: { width: W, height: H, transfer: 'linear', rgba: new Float32Array(input), gamut: 0, referenceWhite: 203 } },
        });
        try {
          await renderer.preload?.();
          const frame = await renderer.renderFrameSignal(0, 'pq');
          if (await EffectsPipeline.requestCachedDevice() !== device) throw Error('COMPOSITION_CALIBRATION_DEVICE_CHANGED');
          const pixels = Array.from(frame.rgba);
          const repeated = await renderer.renderFrameSignal(0, 'pq');
          if (JSON.stringify(pixels) !== JSON.stringify(Array.from(repeated.rgba))) throw new Error('Repeated seek changed geometry export');
          compositions.push({ ...entry, width: frame.width, height: frame.height, pixels, repeatedSeek: true });
        } finally { renderer.dispose(); }
      }
      return { adapter: device.adapterInfo, rasterCapture, raster, calibration, rows, compositions, halfCoverage, compositionUsesCalibratedDevice:true };
    } finally {
      original.destroy(); output.destroy(); buffer.destroy(); pipeline.destroy();
    }
  }, { W, H, input, cases, probeSource:probeGeometryCoordinates.toString(),baseProbeSource:probeBaseRaster.toString(),baseValidateSource:validateBaseRaster.toString(),quad,envelopes,binding:{quadSha256,browser:browser.version(),sourceSha256:source.sourceSha256,backendArgs:chromeLaunchArgs()} });
  if (process.env.STUDIO_MEASUREMENT_REPORT) await writeFile(process.env.STUDIO_MEASUREMENT_REPORT + '.raw.json', JSON.stringify({source, ...report, browser:browser.version(), backendArgs:chromeLaunchArgs(), qualification:'pending assertions'},null,2));
  try {
  const validated = report.calibration.map((row,i) => validateGeometryCalibration(row,W,H,cases[i],i,report.raster));
  assert.equal(validated.length,cases.length);
  report.validatedCalibration=validated;
  const checkPixels = (pixels,expected,label) => {
    assert.equal(pixels.length,expected.length, label + ' dimensions');
    pixels.forEach((v,i)=>assert(Number.isFinite(v) && Math.abs(v-expected[i]) <= Math.max(.004,Math.abs(expected[i])*.003),
      `${label} channel ${i}: ${v} vs ${expected[i]}`));
  };
  report.negativeControls=[];
  for (const [index,row] of report.rows.entries()) {
    assert(HDR_GEOMETRY.includes(row.type));
    assert.deepEqual({type:row.type,params:row.params},cases[index],'render/calibration case binding');
    const expected=geometryReference(input,W,H,row.type,row.params,validated[index].coordinates);
    checkPixels(row.pixels,expected,`${row.type} ${JSON.stringify(row.params)}`);
    const clipped=row.pixels.map((value,i)=>i%4===3?value:Math.max(0,Math.min(1,value)));
    assert.throws(()=>checkPixels(clipped,expected,'clipped'));report.negativeControls.push({index,control:'clipping',refused:true});
    const alpha=row.pixels.map((value,i)=>i%4===3?1:value);
    assert.throws(()=>checkPixels(alpha,expected,'alpha'));report.negativeControls.push({index,control:'alpha',refused:true});
    const straight=geometryReference(input.map((value,i)=>i%4===3?1:value),W,H,row.type,row.params,validated[index].coordinates);
    const straightWithCoverage=straight.map((value,i)=>i%4===3?row.pixels[i]:value);
    assert.throws(()=>checkPixels(straightWithCoverage,expected,'straight alpha'));report.negativeControls.push({index,control:'straight-alpha',refused:true});
    if(!(row.type==='gpu-wave' && row.params.amplitudeX===0 && row.params.amplitudeY===0)) {
      const identity=geometryReference(input,W,H,'gpu-wave',{amplitudeX:0,amplitudeY:0,frequencyX:1,frequencyY:1});
      assert.throws(()=>checkPixels(identity,expected,'identity'));report.negativeControls.push({index,control:'wrong-identity-geometry',refused:true});
    }
    for(const [name,mutate] of [
      ['coordinates',r=>{r.values[16]+=.01;}],['pixel',r=>{r.values[0]=1;}],
      ['parameter',r=>{r.values[21]+=.01;}],['case',r=>{r.caseIndex=(index+1)%cases.length;}],
    ]) {
      const forged=structuredClone(report.calibration[index]);mutate(forged);
      assert.throws(()=>validateGeometryCalibration(forged,W,H,cases[index],index,report.raster));
      report.negativeControls.push({index,control:'forged-'+name,refused:true});
    }
  }
  for (const row of report.rows) {
    for (let i=0;i<row.pixels.length;i+=4) if (row.pixels[i+3] === 0)
      assert.deepEqual(row.pixels.slice(i,i+3),[0,0,0], `${row.type} zero stored coverage retains RGB`);
  }
  const pq = nits => {
    const light = Math.max(0, Math.min(1, nits / 10000)) ** (2610 / 16384);
    return ((3424 / 4096 + (2413 / 4096) * 32 * light) / (1 + (2392 / 4096) * 32 * light)) ** ((2523 / 4096) * 128);
  };
  const bt2020 = [[.627404, .329282, .043314], [.069097, .91954, .011361], [.016392, .088013, .895595]];
  assert.equal(report.compositions.length, cases.length);
  for (const [index,row] of report.compositions.entries()) {
    assert.deepEqual({type:row.type,params:row.params},cases[index],'composition/calibration case binding');
    assert.equal(row.pixels.length,input.length);
    assert.deepEqual([row.width, row.height], [W, H]);
    const filtered = geometryReference(input, W, H, row.type, row.params, validated[index].coordinates);
    for (let i = 0; i < W * H; ++i) {
      const rgb = filtered.slice(i * 4, i * 4 + 3).map(v => v * filtered[i * 4 + 3]);
      for (let c = 0; c < 3; ++c) {
        const expected = pq(bt2020[c].reduce((sum, value, at) => sum + value * rgb[at] * 203, 0));
        assert(Math.abs(row.pixels[i * 4 + c] - expected) < .004, `${row.type} full export pixel ${i} channel ${c}`);
      }
      assert.equal(row.pixels[i * 4 + 3], 1);
    }
  }
  report.geometryAndPqAssertionsPassed=true;
  const tinyExpected = geometryReference(report.halfCoverage.input,2,2,'gpu-wave',report.halfCoverage.params);
  assert.deepEqual(report.halfCoverage.pixels,tinyExpected,'binary16 coverage boundary must clear underflow RGB and preserve the minimum positive coverage');
  assert.deepEqual(await testedSource(new URL(import.meta.url)), source, 'tested inputs changed during measurement');
  if (process.env.STUDIO_MEASUREMENT_REPORT) await writeFile(process.env.STUDIO_MEASUREMENT_REPORT,
    JSON.stringify({ source, ...report, browser:browser.version(), backendArgs:chromeLaunchArgs(), oracle: 'independent admitted same-device f32 coordinate witness and premultiplied sampler; unchanged thresholds; linear BT.709, straight-alpha output, 203 nits reference white' }, null, 2));
  console.log(JSON.stringify({ check: 'HDR alpha-aware Twirl/Wave/Bulge', cases: report.rows.length, compositionExports: report.compositions.length, channels: report.rows.length * input.length }));
  } catch(error) {
    if(process.env.STUDIO_MEASUREMENT_REPORT) await writeFile(process.env.STUDIO_MEASUREMENT_REPORT+'.failed.json',JSON.stringify({source,...report,backendArgs:chromeLaunchArgs(),result:'failed',failure:{name:error.name,message:error.message}},null,2));
    throw error;
  }
} finally { await browser.close(); }
