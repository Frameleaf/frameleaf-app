import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { cleanupWhisperRun } from './whisper-worker.browser.mjs';
import { runNativeInterceptionPreflight, nativeChannelDisposition } from './native-interception-preflight.browser.mjs';

test('actual flattened native controller guards page then PID-stops unsupported paused worker without its sink running', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-native-preflight-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'observation.json');
  const report = await runNativeInterceptionPreflight(file);
  assert.equal(report.status, 'unsupported');
  assert.equal(report.unsupported.targetType, 'worker');
  assert.match(report.unsupported.reason, /Fetch.enable.*wasn't found/);
  const events=report.observations;
  const page=events.find(e=>e.event==='target-attached' && e.type==='page');
  const worker=events.find(e=>e.event==='target-attached' && e.type==='worker');
  assert.ok(page?.owned && worker?.owned);
  assert.equal(page.waitingForDebugger,true);assert.equal(worker.waitingForDebugger,true);
  const rootAck=events.find(e=>e.event==='recursive-attach-ack' && !e.sessionId);
  assert.ok(rootAck.sequence<page.sequence,'Root attach acknowledgement precedes owned target');
  const inPage=events.filter(e=>e.sessionId===page.sessionId);
  const enabled=inPage.find(e=>e.event==='command-sent' && e.method==='Fetch.enable');
  assert.deepEqual(enabled.parameters.patterns,[{urlPattern:'*',requestStage:'Request'},{urlPattern:'*',requestStage:'Response'}]);
  const resume=inPage.find(e=>e.event==='command-sent' && e.method==='Runtime.runIfWaitingForDebugger');
  for(const method of ['Target.setAutoAttach','Network.enable','Fetch.enable']) {
    assert.ok(inPage.find(e=>e.event==='command-ack' && e.method===method).sequence<resume.sequence,`${method} acknowledged before sole page resume`);
  }
  const inWorker=events.filter(e=>e.sessionId===worker.sessionId);
  assert.ok(inWorker.some(e=>e.event==='recursive-attach-ack'));
  assert.ok(inWorker.some(e=>e.event==='command-ack' && e.method==='Network.enable'));
  const rejection=inWorker.find(e=>e.event==='command-rejected' && e.method==='Fetch.enable');
  assert.ok(rejection);
  const interrupted=events.find(e=>e.event==='command-rejected' && e.method==='Runtime.evaluate' && e.sequence>rejection.sequence);
  assert.equal(interrupted?.reason,rejection.reason,'Pending evaluation rejects with first native failure, not its timeout');
  assert.ok(!inWorker.some(e=>e.method==='Runtime.runIfWaitingForDebugger'),'Unsupported worker is never resumed');
  for(const forwarded of events.filter(e=>e.event==='fixture-forward-admitted')) {
    assert.ok(events.some(e=>e.event==='guard-allow' && e.sessionId===forwarded.sessionId && e.requestId===forwarded.requestId && e.url===forwarded.url && e.sequence<forwarded.sequence),'Every fixture forward has attributable earlier owned Request admission');
  }
  assert.equal(report.gates.window.result.get,'authored tiny local fixture');
  assert.equal(report.gates.window.result.head,200);
  assert.equal(report.gates.window.result.denied,'TypeError');
  assert.equal(report.gates.window.result.forbidden,'TypeError');
  assert.ok(events.some(e=>e.event==='guard-deny' && e.reason==='method' && e.method==='POST'));
  assert.ok(events.some(e=>e.event==='native-fetch-pause' && e.stage==='Response'));
  assert.deepEqual(report.ownedFixture.requests.map(r=>[r.method,r.url,r.bodyBytes]),[
    ['GET','/entry',0],['GET','/get',0],['HEAD','/head',0],['GET','/worker.js',0]
  ],'Positive controls occurred; no denied POST/body or worker GET sink ran');
  for(const gate of ['nested-worker','relative-redirect-chain','wss','webtransport','serviceworker','browser-process','unowned-target','guard-disconnect']) {
    assert.equal(report.gates[gate].disposition,'not-executed',`${gate} is not qualified by absence`);
  }
  assert.equal(report.ownedFixture.tlsConnections,0);assert.equal(report.ownedFixture.upgrades,0);assert.equal(report.ownedFixture.udpPackets,0);
  assert.equal(report.modelDownloads,0);assert.equal(report.externalBypass,false);assert.equal(report.directHuggingFaceTLS,'unmeasured');
  assert.equal(report.browserExited,true);assert.equal(report.controllerClosed,true);assert.equal(report.pendingCommands,0);
  assert.ok(events.find(e=>e.event==='owned-browser-exited-before-proxy-close').sequence<events.find(e=>e.event==='owned-proxy-closed').sequence,'Deny-all proxy remains alive until owned child exit');
  assert.ok(!events.some(e=>e.event==='command-sent' && e.method==='Browser.close'),'Failure PID-stops before CDP detachment can resume the worker');
  assert.ok(report.cleanup.resources.every(value=>value==='fulfilled'));
  assert.equal(report.cleanup.ownedModelCacheRemoved,true);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),report,'Saved observation matches actual native run');
});


test('actual owned close and removal errors fail result while attempting remaining cleanup', async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'frameleaf-native-cleanup-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const closed=http.createServer();
  const live=http.createServer();live.listen(0,'127.0.0.1');await once(live,'listening');
  t.after(()=>{if(live.listening)live.close();});
  const close=server=>()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  const report={status:'partial-local-preflight'};let persisted;
  await assert.rejects(cleanupWhisperRun(report,[close(closed),close(live)],()=>rm(root),()=>{persisted=JSON.parse(JSON.stringify(report));}),/cleanup failed/i);
  assert.equal(live.listening,false,'Later real close still executes after first rejection');
  assert.equal(report.status,'failed');assert.deepEqual(report.cleanup.resources,['rejected','fulfilled']);
  assert.equal(report.cleanup.ownedModelCacheRemoved,false);assert.match(report.cleanup.cacheRemovalError,/directory|EISDIR/i);
  assert.deepEqual(persisted,report,'Failure evidence persisted before rejection');
});

test('actual cleanup rejection preserves earlier native failure', async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'frameleaf-native-cleanup-first-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const server=http.createServer();
  const report={status:'unsupported',error:'Fetch.enable native unsupported'};
  await cleanupWhisperRun(report,[()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))],()=>rm(root,{recursive:true,force:true}),()=>{});
  assert.equal(report.error,'Fetch.enable native unsupported');assert.equal(report.status,'failed');
  assert.deepEqual(report.cleanup.resources,['rejected']);assert.equal(report.cleanup.ownedModelCacheRemoved,true);
});


test('channel classification requires an actual rejection or acknowledged successful registration',()=>{
  assert.equal(nativeChannelDisposition({rejected:'TypeError'}),'native-rejection');
  assert.equal(nativeChannelDisposition({unsupported:'missing native API'}),'unsupported');
  assert.equal(nativeChannelDisposition({registered:true},true),'measured-guarded-registration');
  assert.throws(()=>nativeChannelDisposition({unexpected:'ready'}),/acknowledged guard/);
  assert.throws(()=>nativeChannelDisposition({registered:true},false),/acknowledged guard/);
  assert.throws(()=>nativeChannelDisposition({}),/acknowledged guard/);
  assert.throws(()=>nativeChannelDisposition({rejected:'TypeError',registered:true}),/contradictory/);
  assert.throws(()=>nativeChannelDisposition({rejected:'TypeError',unexpected:'ready'}),/contradictory/);
});
