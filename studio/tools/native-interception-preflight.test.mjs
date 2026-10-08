import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { cleanupWhisperRun } from './whisper-worker.browser.mjs';
import { runNativeInterceptionPreflight, nativeChannelDisposition, nativeDiagnosticError, nativeDiagnosticURL } from './native-interception-preflight.browser.mjs';

test('actual browser Fetch guards page and workers, redirects and OPTIONS while sockets remain fenced', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-native-preflight-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'observation.json');
  const report = await runNativeInterceptionPreflight(file);
  assert.equal(report.status, 'partial-local-preflight');
  const events=report.observations;
  const enabled=events.filter(e=>e.event==='command-sent' && e.method==='Fetch.enable');
  assert.equal(enabled.length,1,'Only root Fetch owns request decisions');
  assert.equal(enabled[0].sessionId,undefined);
  assert.deepEqual(enabled[0].parameters.patterns,[{urlPattern:'*',requestStage:'Request'},{urlPattern:'*',requestStage:'Response'}]);
  const ready=events.find(e=>e.event==='root-fetch-ready');
  assert.ok(ready.sequence<events.find(e=>e.event==='command-sent' && e.method==='Target.createBrowserContext').sequence);
  const targets=events.filter(e=>e.event==='target-attached' && e.owned && ['page','worker'].includes(e.type));
  assert.ok(targets.filter(e=>e.type==='worker').length>=3,'Dedicated and genuinely nested worker targets attached');
  for(const target of targets) {
    assert.equal(target.waitingForDebugger,true);
    const inTarget=events.filter(e=>e.sessionId===target.sessionId);
    const resume=inTarget.find(e=>e.event==='command-sent' && e.method==='Runtime.runIfWaitingForDebugger');
    assert.ok(resume);
    for(const method of ['Target.setAutoAttach','Network.enable'])assert.ok(inTarget.find(e=>e.event==='command-ack' && e.method===method).sequence<resume.sequence);
    assert.ok(ready.sequence<resume.sequence);
  }
  for(const realm of ['window','dedicated-worker','nested-worker']) {
    const gate=report.gates[realm];assert.equal(gate.disposition,'measured-local-fixture');
    assert.equal(gate.requestAttribution,'UNKNOWN','Authored fixture labels are not production target provenance');
    assert.deepEqual(gate.result.redirectStatuses,[301,302,303,307,308]);
    assert.equal(gate.result.get,'authored tiny local fixture');assert.equal(gate.result.head,200);
    assert.equal(gate.result.denied,'TypeError');assert.equal(gate.result.preflight,'TypeError');
    assert.ok(events.some(e=>e.event==='guard-deny' && e.method==='POST' && e.url.endsWith('/denied/'+realm)));
    assert.ok(events.some(e=>e.event==='guard-deny' && e.method==='OPTIONS' && e.url.endsWith('/cors/'+realm)));
    for(const status of [301,302,303,307,308])assert.ok(events.some(e=>e.event==='redirect-chain-verified' && e.url.endsWith('/final/'+realm+'/'+status)));
  }
  for(const forwarded of events.filter(e=>e.event==='fixture-forward-admitted')) {
    assert.ok(events.some(e=>e.event==='guard-allow' && e.requestId===forwarded.requestId && e.url===forwarded.url && e.sequence<forwarded.sequence));
    assert.equal(forwarded.requestAttribution,'UNKNOWN');
  }
  assert.ok(!report.ownedFixture.requests.some(r=>r.url.startsWith('/denied/') || r.url.startsWith('/forbidden/')));
  assert.ok(report.ownedFixture.requests.every(r=>r.bodyBytes===0));
  assert.equal(report.foreignFixture.requests.length,0);assert.equal(report.foreignFixture.tcpConnections,0);
  assert.equal(report.gates.https.disposition,'measured-local-native-TLS');
  assert.equal(report.gates.https.trustedBody,'authored tiny TLS fixture');
  assert.equal(report.gates.https.certificateRejection,true);
  assert.equal(report.tlsFixture.trustedRequests,12);
  assert.deepEqual(report.gates.https.redirectStatuses,[301,302,303,307,308]);
  assert.equal(report.gates.https.downgradeDenied,true);
  assert.equal(report.gates['relative-redirect-chain'].copiedFinalDenied,true);
  assert.equal(report.ownedFixture.requests.filter(r=>r.url==='/get/window').length,1,'HTTPS downgrade did not repeat allowed HTTP sink');
  assert.equal(report.ownedFixture.requests.filter(r=>r.url==='/final/window/302').length,1,'Copied final request was refused before sink');assert.equal(report.tlsFixture.untrustedRequests,0);
  assert.equal(report.gates['relative-redirect-chain'].disposition,'measured-local-fixture');
  assert.ok(report.gates['relative-redirect-chain'].negativeCases.every(c=>c.denied));
  for(const entry of report.gates['relative-redirect-chain'].negativeCases)assert.ok(events.some(e=>e.event==='guard-deny' && e.stage==='Response' && e.url.endsWith('/negative/'+entry.name)),'Negative redirect refused at native Response pause');
  assert.ok(events.some(e=>e.event==='guard-deny' && e.stage==='Request' && e.reason==='missing redirect parent' && e.url.endsWith('/final/window/302')));
  assert.ok(events.some(e=>e.event==='guard-deny' && e.stage==='Response' && e.url.endsWith('/tls-downgrade')));
  for(const status of [301,302,303,307,308])assert.ok(events.some(e=>e.event==='redirect-chain-verified' && e.url.endsWith('/tls-final/'+status)));
  for(const realm of ['window','dedicated-worker','nested-worker']) {
    assert.equal(report.gates.sockets[realm].disposition,'proxy-fallback-refusal');
    assert.equal(report.gates.sockets[realm].interceptionCoverage,'unproven');
  }
  assert.equal(report.ownedFixture.upgrades,0);assert.equal(report.ownedFixture.udpPackets,0);
  assert.equal(report.gates.serviceworker.disposition,'closed-paused-target-refusal');
  assert.ok(events.some(e=>e.event==='unsupported-target-closed-paused' && e.type==='service_worker'));
  for(const closed of events.filter(e=>e.event==='unsupported-target-closed-paused'))assert.ok(events.some(e=>e.event==='command-ack' && e.method==='Target.closeTarget' && e.sequence>events.find(a=>a.event==='target-attached' && a.targetId===closed.targetId).sequence && e.sequence<closed.sequence),'Close event follows actual native acknowledgement, including duplicate sessions');
  assert.ok(!events.some(e=>e.event==='guard-deny' && e.url.endsWith('/hold-denied')),'Held request is not falsely labelled a completed failRequest denial');
  for(const target of events.filter(e=>e.event==='target-attached' && e.type==='service_worker'))assert.ok(!events.some(e=>e.event==='command-sent' && e.sessionId===target.sessionId && e.method==='Runtime.runIfWaitingForDebugger'));
  assert.ok(!report.ownedFixture.requests.some(r=>r.url==='/sw.js'));
  assert.equal(report.gates['browser-process'].disposition,'unsupported');
  assert.equal(report.gates['unowned-target'].disposition,'closed-before-resume');
  assert.equal(report.gates['guard-disconnect'].disposition,'measured-owned-browser-shutdown');
  assert.ok(report.remainingGates.includes('external all-channel native denial under host bypass'));
  assert.equal(report.modelDownloads,0);assert.equal(report.externalBypass,false);assert.equal(report.directHuggingFaceTLS,'unmeasured');
  assert.equal(report.browserExited,true);assert.equal(report.controllerClosed,true);assert.equal(report.pendingCommands,0);
  assert.ok(events.find(e=>e.event==='owned-browser-exited-before-proxy-close').sequence<events.find(e=>e.event==='owned-proxy-closed').sequence);
  assert.ok(report.cleanup.resources.every(value=>value==='fulfilled'));
  assert.equal(report.cleanup.ownedModelCacheRemoved,true);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),report);
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


test('native diagnostic boundary withholds arbitrary URL, header and error capabilities',()=>{
  const capability='authored-secret-do-not-log';
  for(const text of [`https://user:${capability}@example.invalid/a?sig=${capability}#${capability}`,`Authorization: Bearer ${capability}`,`request failed with signed query ${capability}`]) {
    const error=new Error(text);assert.equal(nativeDiagnosticError(error),'Error: details withheld');
    assert.ok(!nativeDiagnosticError(error).includes(capability));
  }
  const url=nativeDiagnosticURL(`https://user:${capability}@example.invalid/${capability}?sig=${capability}#${capability}`);
  assert.match(url,/^https:\/\/example\.invalid#sha256=[a-f0-9]{64}$/);assert.ok(!url.includes(capability));
  assert.equal(nativeDiagnosticURL('http://127.0.0.1:1234/get/window'),'http://127.0.0.1:1234/get/window');
  assert.ok(!nativeDiagnosticURL(`http://127.0.0.1:1234/${capability}?sig=${capability}`).includes(capability));
});
