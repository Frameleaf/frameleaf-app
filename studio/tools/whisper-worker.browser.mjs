// FL111: actual production Bridge/pool/Whisper worker on genuine approved model bytes.
// Controlled replay through the existing deny-all harness; direct browser HF TLS is a separate gate.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHarness } from './lib/cross-browser-harness.mjs';
import { inventory } from './engine.mjs';
import { ownerApproval, approvalRowDigest } from '../../scripts/frameleaf-studio-rights.mjs';

export async function cleanupWhisperRun(report, closes, removeCache, persistReport) {
  const priorError=Object.hasOwn(report,'error');
  const cleanup=[];
  for(const close of closes)cleanup.push(...await Promise.allSettled([Promise.resolve().then(close)]));
  const [removal]=await Promise.allSettled([Promise.resolve().then(removeCache)]);
  const removed=removal.status==='fulfilled';
  report.cleanup={...report.cleanup,resources:cleanup.map(result=>result.status),ownedModelCacheRemoved:removed,
    resourceErrors:cleanup.map(result=>result.status==='rejected'?String(result.reason):null),
    cacheRemovalError:removed?null:String(removal.reason)};
  const failed=cleanup.some(result=>result.status==='rejected')||!removed;
  const error=failed?new Error('Whisper cleanup failed: owned close or cache removal refused'):undefined;
  if(failed) {report.status='failed';report.cleanupError=String(error);report.error??=String(error)}
  else if(!priorError&&report.status==='measured-controlled-native-worker-check')report.status='passed-controlled-native-worker-check';
  try {await persistReport()} catch(writeError) {if(!priorError)throw writeError}
  if(error&&!priorError)throw error; // An earlier inference exception resumes after finally.
}

// Importing the cleanup check cannot start a browser or download model payloads.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
assert.equal(process.env.STUDIO_WHISPER_BROWSER, '1', 'Explicit approved tiny-model download authorization required');
const studio = path.resolve(import.meta.dirname, '..');
const engine = path.join(studio, 'engine');
const require = createRequire(path.join(engine, 'package.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const evidenceBytes = await readFile(path.join(studio, 'tools/fixtures/whisper-timing.json'));
const evidence = JSON.parse(evidenceBytes);
const wav = await readFile(path.join(studio, 'tools/fixtures/whisper-timing.wav'));
const manifest = JSON.parse(await readFile(path.join(studio, 'dependency-attribution.json')));
const approval = ownerApproval(JSON.parse(await readFile(path.join(studio, 'rights-approval.json'))), manifest);
const model = manifest.resources.find(row => row.id === `model:${evidence.model}`);
assert.equal(model.revision, evidence.revision); assert.equal(model.files.length, 7);
for (const id of [model.id, 'runtime:whisper-transformers']) assert.equal(approval.approved.get(id), true);
const config = JSON.parse(await readFile(path.join(studio, 'engine-build.json')));
const source = await inventory(engine, '', new Set(['node_modules', 'dist', 'frameleaf-source.json', 'frameleaf-build.json']));
const prepared = JSON.parse(await readFile(path.join(engine, 'frameleaf-source.json')));
assert.equal(hash(JSON.stringify(prepared.files)), config.sourceSha256, 'Genuine base prepare inventory must match the existing pin');
const runtimeSha256 = hash(await readFile(path.join(studio, 'runtime/resource-admission.mjs')));
const copiedRuntime = new Set(['src/shared/utils/resource-admission.mjs', 'public/moss-tts/resource-admission.mjs']);
assert.equal(source.length, prepared.files.length);
for (const [index, file] of source.entries()) {
  assert.equal(file.path, prepared.files[index].path);
  assert.equal(file.sha256, copiedRuntime.has(file.path) ? runtimeSha256 : prepared.files[index].sha256,
    'Only the tracked candidate runtime copied by writeResourcePolicy may differ from the genuine prepared base');
}
const sourceSha256 = hash(JSON.stringify(source));
const { chromeLaunchArgs } = await import(pathToFileURL(path.join(engine, 'headless/lib/cli.mjs')));
const bundled = JSON.parse(await readFile(path.join(engine, 'node_modules/kokoro-js/node_modules/@huggingface/transformers/package.json')));
assert.equal(bundled.version, evidence.transformersVersion);
const runtime = manifest.resources.find(row => row.id === 'runtime:whisper-transformers');
for (const file of runtime.files) assert.equal(hash(await readFile(path.join(engine, 'node_modules', file.path))), file.sha256);
const nativeFetch = globalThis.fetch;
const { verifyResourceBytes } = await import(pathToFileURL(path.join(engine, 'src/shared/utils/resource-admission.mjs')));
const exact = new Map(model.files.map(file => [`https://huggingface.co/${model.locator}/resolve/${model.revision}/${file.path}`, file]));
const cache = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-whisper-browser-'));
const payloads = new Map();
const replayPaths = new Map();
const report = { schemaVersion: 1, kind: 'production-whisper-worker-controlled-approved-byte-replay', status: 'failed',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceSha256,
  registeredSourceSha256: config.sourceSha256, candidateRuntimeSha256: runtimeSha256,
  registeredSourceQualified: sourceSha256 === config.sourceSha256,
  workerSha256: hash(await readFile(path.join(engine, 'src/features/media-library/transcription/workers/whisper.worker.ts'))),
  model: evidence.model, revision: evidence.revision, rowDigest: approvalRowDigest(model), transformersVersion: bundled.version,
  fixtureSha256: hash(wav), evidenceSha256: hash(evidenceBytes), downloads: [], requests: [], workerEvents: [],
  directBrowserHuggingFaceTLS: 'unmeasured-separate-required-gate', fullFL111Acceptance: false };
let server, harness, browser, context;
try {
  const { createServer } = await import(require.resolve('vite'));
  server = await createServer({root: engine, configFile: path.join(engine,'vite.config.ts'), server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error'});
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  harness = createHarness({ upstream: origin, inspectConnect: true, overrides: [
    { test:url=>url.pathname==='/__fl111__/whisper.html',respond:()=>({contentType:'text/html',headers:server.config.server.headers,body:'<!doctype html><title>Actual Whisper worker qualification</title>'}) },
    { test:url=>url.pathname==='/__fl111__/whisper.wav',respond:()=>({contentType:'audio/wav',body:wav}) },
    { test:url=>replayPaths.has(url.pathname),respond:async(url,request)=>{
      assert.ok(['GET','HEAD'].includes(request.method));
      assert.ok(!request.headers['transfer-encoding'] && Number(request.headers['content-length']??0)===0,'No browser payload upload');
      assert.equal(url.search,'');const verified=await payloads.get(replayPaths.get(url.pathname));
      return {contentType:verified.headers['content-type'],headers:{'content-length':String(verified.bytes.length),'access-control-allow-origin':'*'},body:request.method==='HEAD'?Buffer.alloc(0):Buffer.from(verified.bytes)};
    } },
  ] });
  const harnessOrigin = await harness.listen();
  report.chromeArgs = chromeLaunchArgs();
  browser = await require('playwright').chromium.launch({headless:true,args:report.chromeArgs,proxy:{server:harnessOrigin}});
  context = await browser.newContext({serviceWorkers:'block'});
  const workers = new Set();
  const whisperCloses=[];
  const observeWorker=worker=>{workers.add(worker);report.workerEvents.push({event:'created',url:worker.url()});
    if(worker.url().includes('whisper.worker'))whisperCloses.push(new Promise(resolve=>worker.once('close',resolve)));
    worker.on('close',()=>{workers.delete(worker);report.workerEvents.push({event:'closed',url:worker.url()})})};
  const failures = [];
  await context.route('https://**/*', async route => {
    const request = route.request(); const url = request.url(); const file = exact.get(url);
    report.requests.push({url:new URL(url).origin+new URL(url).pathname,method:request.method(),body:request.postDataBuffer()?.length??0,approved:!!file});
    if (!file || !['GET','HEAD'].includes(request.method()) || request.postDataBuffer()) { failures.push('Unapproved or uploading browser request'); await route.abort('blockedbyclient'); return; }
    try {
      let entry = payloads.get(url);
      if (!entry) {
        entry = (async()=>{
          const response=await nativeFetch(url,{method:'GET',signal:AbortSignal.timeout(120000)});
          assert.equal(response.status,200);const bytes=await verifyResourceBytes(url,new Uint8Array(await response.arrayBuffer()));
          assert.equal(hash(bytes),file.sha256);const location=path.join(cache,file.path.replaceAll('/','_'));
          await writeFile(location,bytes);report.downloads.push({url,finalOrigin:new URL(response.url).origin,bytes:bytes.length,sha256:hash(bytes),approvedSha256:file.sha256});
          console.log(`Approved ${file.path}: ${bytes.length} bytes`);
          return {bytes,headers:{'content-type':response.headers.get('content-type')??'application/octet-stream','content-length':String(bytes.length)}};
        })();payloads.set(url,entry);
      }
      await entry;
      const replayPath=`/__fl111__/model/${file.path}`;replayPaths.set(replayPath,url);
      // The original approved Request remains the worker verifier's authority. Native redirect
      // delivery avoids sending large ONNX bodies through DevTools' bounded base64 pipe.
      await route.fulfill({status:302,headers:{location:origin+replayPath,'access-control-allow-origin':'*'}});
    } catch(error) { failures.push(String(error));await route.abort('failed'); }
  });
  const page=await context.newPage();page.on('worker',observeWorker);
  page.on('console',message=>{if(['warning','error'].includes(message.type()))console.log(`Browser ${message.type()}: ${message.text().slice(0,500)}`)});
  page.on('pageerror',error=>failures.push(String(error)));
  await page.goto(origin+'/__fl111__/whisper.html');
  report.browser=await page.evaluate(()=>navigator.userAgent);
  report.environment=await page.evaluate(async()=>({crossOriginIsolated,webgpu:!!navigator.gpu,
    adapter: navigator.gpu ? !!await navigator.gpu.requestAdapter() : false}));
  const measured=await page.evaluate(async()=>{
    const {Bridge}=await import('/src/features/media-library/transcription/lib/bridge.ts');
    const pool=await import('/src/features/media-library/transcription/lib/transcription-worker-pool.ts');
    const bytes=await (await fetch('/__fl111__/whisper.wav')).arrayBuffer();
    const file=new File([bytes],'whisper-timing.wav',{type:'audio/wav'});
    const segments=[],progress=[],runtime=[];
    await new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>{bridge.terminate();reject(Error('Production worker timeout'))},600000);
      const bridge=new Bridge({onSegment:s=>segments.push(s),onProgress:e=>progress.push(e),onRuntimeInfo:e=>runtime.push(e),
        onDone:()=>{clearTimeout(deadline);resolve()},onError:message=>{clearTimeout(deadline);reject(Error(message))}});
      bridge.start(file,'whisper-tiny','en','hybrid','whisper').catch(reject);
    });
    const coldWorker=pool.acquireTranscriptionWorker('whisper');
    const cancel={triggered:false,segments:[],done:false};
    await new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>{bridge.terminate();reject(Error('Cancel inference timeout'))},120000);
      const bridge=new Bridge({onSegment:s=>cancel.segments.push(s),onRuntimeInfo:()=>{},onDone:()=>{cancel.done=true;clearTimeout(deadline);reject(Error('Inference completed before cancellation'))},onError:reject,
        onProgress:e=>{if(e.stage==='transcribing'){cancel.triggered=true;bridge.terminate();clearTimeout(deadline);resolve()}}});
      bridge.start(file,'whisper-tiny','en','hybrid','whisper').catch(reject);
    });
    await new Promise(resolve=>setTimeout(resolve,300));
    const freshWorker=pool.acquireTranscriptionWorker('whisper');
    cancel.poolRecreated=freshWorker!==coldWorker;pool.disposeTranscriptionWorker('whisper');
    const bucket=await caches.open('transformers-cache');
    const stored=[];
    for(const request of await bucket.keys()) {
      const response=await bucket.match(request);const body=await response.arrayBuffer();
      const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',body))].map(v=>v.toString(16).padStart(2,'0')).join('');
      stored.push({url:request.url,bytes:body.byteLength,sha256});
    }
    await caches.delete('transformers-cache');
    return {segments,progress,runtime,cancel,stored};
  });
  report.measured=measured;
  // Termination events cross the browser protocol asynchronously. Require the actual
  // worker close before context shutdown rather than relying on pool bookkeeping.
  assert.ok(whisperCloses.length>0);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Native Whisper worker did not close after cancellation')),10000);
    Promise.all(whisperCloses).then(()=>{clearTimeout(timer);resolve()},reject)});
  assert.deepEqual(failures,[]);assert.equal(report.downloads.length,7);
  const words=measured.segments.flatMap(segment=>segment.words??[]);
  assert.deepEqual(words.map(word=>word.text.trim().toLowerCase()),evidence.expected.map(word=>word.text.trim().toLowerCase()));
  const tolerance=0.06;
  for(const [index,word] of words.entries()) {const expected=evidence.expected[index].timestamp;assert.ok(Math.abs(word.start-expected[0])<=tolerance&&Math.abs(word.end-expected[1])<=tolerance,`${word.text}: ${word.start},${word.end} vs ${expected}`)}
  for(const [start,end] of evidence.pauses)for(const word of words)assert.ok(!(word.start<start-tolerance&&word.end>end+tolerance),'Word spans measured pause');
  assert.ok(measured.progress.some(e=>e.stage==='preparing'&&e.progress===1));assert.ok(measured.runtime.some(e=>['wasm','webgpu'].includes(e.backend)));
  assert.equal(measured.cancel.triggered,true);assert.equal(measured.cancel.poolRecreated,true);assert.equal(measured.cancel.done,false);assert.deepEqual(measured.cancel.segments,[]);
  assert.equal(measured.stored.length,7);for(const entry of measured.stored){assert.ok(exact.has(entry.url));assert.equal(entry.sha256,exact.get(entry.url).sha256)}
  assert.ok(report.workerEvents.some(e=>e.event==='created'&&e.url.includes('whisper.worker')));assert.ok(report.workerEvents.some(e=>e.event==='closed'&&e.url.includes('whisper.worker')));
  assert.ok(harness.observations.some(e=>e.kind==='proxied'&&e.url.includes('whisper.worker')));assert.ok(!harness.observations.some(e=>['error','tunnelled','blocked'].includes(e.kind)));
  report.status='measured-controlled-native-worker-check';
  console.log(`Actual production worker: ${words.length} word timings; backend ${JSON.stringify(measured.runtime)}; cancel and pool recreation observed`);
} catch(error) {report.error=String(error);throw error}
finally {
  const downloads=await Promise.allSettled(payloads.values());
  if(harness)report.harness=harness.observations;
  report.cleanup={downloads:downloads.map(result=>result.status)};
  await cleanupWhisperRun(report,[()=>context?.close(),()=>browser?.close(),()=>harness?.close(),()=>server?.close()],
    ()=>rm(cache,{recursive:true,force:true}),async()=>{
      if(process.env.STUDIO_WHISPER_BROWSER_REPORT)await writeFile(process.env.STUDIO_WHISPER_BROWSER_REPORT,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    });
}
}
