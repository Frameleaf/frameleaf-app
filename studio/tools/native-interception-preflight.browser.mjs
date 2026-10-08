// FL111 task-owned LOCAL native CDP preflight. No external bypass or model payload.
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHarness } from './lib/cross-browser-harness.mjs';
import { cleanupWhisperRun } from './whisper-worker.browser.mjs';
import { inventory } from './engine.mjs';

const deadline = 10000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class Unsupported extends Error {}

// One controller; incoming events remain readable while setup awaits acknowledgements.
export async function connectNativeController(endpoint, observe, fail) {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  let closePromise;
  const socketClosed=new Promise(resolve=>socket.addEventListener('close',resolve,{once:true}));
  let nextId = 0, closing = false, aborted = false, expectedDisconnect = false, handler = () => {};
  const rejectPending = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      if (!message || typeof message !== 'object') throw new Error('Malformed CDP envelope');
      if (Object.hasOwn(message, 'id')) {
        const item = pending.get(message.id);
        if (!item) throw new Error('Unknown CDP response id');
        if (message.sessionId !== item.sessionId) throw new Error('CDP response session mismatch');
        pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(new Unsupported(`${item.method}: ${message.error.message}`));
        else item.resolve(message.result ?? {});
      } else if (typeof message.method === 'string') {
        Promise.resolve(handler(message)).catch(fail);
      } else throw new Error('Malformed CDP event');
    } catch (error) { rejectPending(error); fail(error); }
  });
  socket.addEventListener('error', () => { if (!closing && !expectedDisconnect) fail(new Error('Native CDP socket error')); });
  socket.addEventListener('close', () => {
    const error = new Error('Native CDP disconnected'); rejectPending(error);
    if (!closing && !expectedDisconnect) fail(error);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { closing = true; socket.close(); reject(new Error('Native CDP open timeout')); }, deadline);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Native CDP open failed')); }, { once: true });
  });
  return {
    setHandler(value) { handler = value; },
    async send(method, params = {}, sessionId) {
      if (closing || aborted || socket.readyState !== WebSocket.OPEN) throw new Error('Native CDP unavailable');
      const id = ++nextId;
      observe({ event: 'command-sent', method, sessionId, ...(['Fetch.enable','Target.setAutoAttach'].includes(method)?{parameters:params}:{}) });
      let result;
      try { result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); const error = new Error(`CDP timeout: ${method}`); reject(error); fail(error); }, deadline);
        pending.set(id, { method, sessionId, resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
      } catch(error) { observe({event:'command-rejected',method,sessionId,reason:String(error)}); throw error; }
      observe({ event: 'command-ack', method, sessionId });
      return result;
    },
    abortPending(error) { aborted=true; rejectPending(error); },
    expectDisconnect() { expectedDisconnect=true; },
    close() {
      closePromise??=(async()=>{
        closing=true;rejectPending(new Error('Owned controller shutdown'));
        if(socket.readyState===WebSocket.CLOSED)return;
        socket.close();
        let timer;
        try { await Promise.race([socketClosed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned WebSocket close timeout')),deadline);})]); }
        finally {clearTimeout(timer);}
      })();return closePromise;
    },
    get pendingCount(){return pending.size;},
    get open() { return !closing && socket.readyState === WebSocket.OPEN; }
  };
}

export async function installNativeTargetGate(controller, observe, sessionId) {
  await controller.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true,
    flatten: true, filter: [{ type: 'browser', exclude: true }, { type: 'tab', exclude: true }, {}] }, sessionId);
  observe({ event: 'recursive-attach-ack', sessionId });
}

// Truthful result classification; this does not itself measure a native channel.
export function nativeChannelDisposition(outcome, guardedRegistration = false) {
  assert.ok(outcome && typeof outcome === 'object', 'Native outcome required');
  if (outcome.unsupported) {
    assert.ok(typeof outcome.unsupported === 'string' && !outcome.rejected && !outcome.registered && !outcome.unexpected,
      'Unsupported outcome must not be contradictory');
    return 'unsupported';
  }
  if (outcome.rejected) {
    assert.ok(typeof outcome.rejected === 'string' && !outcome.registered && !outcome.unexpected,
      'Native rejection must not be contradictory');
    return 'native-rejection';
  }
  assert.ok(outcome.registered === true && guardedRegistration === true && !outcome.unexpected,
    'Successful registration requires acknowledged guard; unexpected ready is a failure');
  return 'measured-guarded-registration';
}

// Error text and unknown URLs may contain signed capabilities or header values.
// Keep only a fixed error category and URL digest at the diagnostic boundary.
export function nativeDiagnosticError(error) {
  const name=error instanceof Unsupported?'Unsupported':error?.name==='AssertionError'?'AssertionError':'Error';
  return `${name}: details withheld`;
}

export function nativeDiagnosticURL(value) {
  const url=new URL(value);
  if(url.hostname==='127.0.0.1' && !url.username && !url.password && !url.search && !url.hash)return url.href;
  return `${url.origin}#sha256=${hash(value)}`;
}

async function waitUntil(predicate, failure, label) {
  const until = Date.now() + deadline;
  while (!predicate()) {
    if (failure()) throw failure();
    if (Date.now() >= until) throw new Error(`Timeout: ${label}`);
    await delay(10);
  }
}

// Copied explicit defaults from locked PW1.60.0 desktop Chromium switches, not its controller.
function nativeArguments(proxy, profile, gpuArgs) {
  const disabled = ['AvoidUnnecessaryBeforeUnloadCheckSync','BoundaryEventDispatchTracksNodeRemoval','DestroyProfileOnBrowserClose',
    'DialMediaRouteProvider','GlobalMediaControls','HttpsUpgrades','LensOverlay','MediaRouter','PaintHolding',
    'ThirdPartyStoragePartitioning','Translate','AutoDeElevate','RenderDocument','OptimizationHints',
    'msForceBrowserSignIn','msEdgeUpdateLaunchServicesPreferredVersion'];
  return ['--disable-field-trial-config','--disable-background-networking','--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows','--disable-back-forward-cache','--disable-breakpad',
    '--disable-client-side-phishing-detection','--disable-component-extensions-with-background-pages','--disable-component-update',
    '--no-default-browser-check','--disable-default-apps','--disable-dev-shm-usage','--disable-edgeupdater','--disable-extensions',
    `--disable-features=${disabled.join(',')}`,'--enable-features=CDPScreenshotNewSurface','--allow-pre-commit-input',
    '--disable-hang-monitor','--disable-ipc-flooding-protection','--disable-popup-blocking','--disable-prompt-on-repost',
    '--disable-renderer-backgrounding','--force-color-profile=srgb','--metrics-recording-only','--no-first-run',
    '--password-store=basic','--use-mock-keychain','--no-service-autorun','--export-tagged-pdf','--disable-search-engine-choice-screen',
    '--unsafely-disable-devtools-self-xss-warnings','--edge-skip-compat-layer-relaunch','--disable-infobars',
    '--disable-search-engine-choice-screen','--disable-sync','--enable-unsafe-swiftshader','--headless','--hide-scrollbars',
    '--mute-audio','--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
    '--no-sandbox',`--proxy-server=${proxy}`,'--proxy-bypass-list=<-loopback>',...gpuArgs,
    `--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-startup-window'];
}

export async function runNativeInterceptionPreflight(reportPath) {
  assert.ok(path.isAbsolute(reportPath), 'Fresh absolute report required');
  assert.ok(!process.env.FREECUT_CHROME_ARGS && !process.env.FREECUT_CHROME_ARGS_REPLACE, 'No unreviewed launch overrides');
  const studio = path.resolve(import.meta.dirname, '..'), engine = path.join(studio, 'engine');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-raw-cdp-'));
  const report = { kind: 'local-browser-fetch-preflight', status: 'failed', observations: [], gates: Object.fromEntries(['window','dedicated-worker','nested-worker','request-response-pauses','relative-redirect-chain','https','sockets','webtransport','serviceworker','browser-process','unowned-target','guard-disconnect'].map(name=>[name,{disposition:'not-executed'}])),

    modelDownloads: 0, externalBypass: false, directHuggingFaceTLS: 'unmeasured',
    ownedFixture: { requests: [], tcpConnections: 0, upgrades: 0, udpPackets: 0 }, foreignFixture:{requests:[],tcpConnections:0}, tlsFixture:{trustedRequests:0,untrustedRequests:0,trustedConnections:0,untrustedConnections:0,requests:[]} };
  let fixture, secure, untrusted, foreign, udp, harness, tlsHarness, untrustedHarness, controller, child, childExit, firstFailure, shutdownFailure, shutdownPromise, shuttingDown = false, contextId, rootFetchReady=false;
  const sockets = new Set(), targets = new Map(), requests = new Map(), admissions = new Map(), ownedContexts=new Set(), closingTargets=new Map();
  let seq = 0;
  const observe = entry => report.observations.push(Object.fromEntries(Object.entries({ sequence: ++seq, ...entry }).filter(([,value])=>value!==undefined).map(([key,value])=>[key,['url','parentUrl'].includes(key)?nativeDiagnosticURL(value):key==='reason' && entry.event==='command-rejected'?nativeDiagnosticError(new Error(value)):key==='errorText'?nativeDiagnosticError(new Error(value)):value])));
  const fail = error => {
    if(firstFailure || shuttingDown)return;
    firstFailure=error; controller?.abortPending(error);
    void stopBrowser().catch(error=>{shutdownFailure??=error;});
  };
  const failure = () => firstFailure;
  const evaluate = async (session, expression) => {
    const result = await controller.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error('Native evaluated fixture exception');
    if (firstFailure) throw firstFailure;
    return result.result.value;
  };
  const stopBrowser = () => {
    if(shutdownPromise)return shutdownPromise;
    shutdownPromise=(async()=>{
      if(!child)return;
      shuttingDown=true;controller?.expectDisconnect();
      let closeError;
      // Never detach an unsupported paused target before PID shutdown: detaching can resume it.
      if(firstFailure || report.intentionalDisconnect) {
        controller?.abortPending(firstFailure ?? new Error('Intentional disconnect'));
        child.kill('SIGTERM');
      } else if(controller?.open && child.exitCode===null && child.signalCode===null) {
        try { await controller.send('Browser.close'); } catch(error) { closeError=error; }
      }
      const exited=ms=>Promise.race([childExit.then(()=>true),delay(ms).then(()=>false)]);
      if(!await exited(2000)) { child.kill('SIGTERM'); if(!await exited(2000)) { child.kill('SIGKILL'); assert.ok(await exited(2000),'Owned browser did not exit'); } }
      await controller?.close();
      report.controllerClosed=true;report.pendingCommands=controller?.pendingCount??0;
      observe({event:'owned-browser-exited-before-proxy-close'});
      report.browserExited=child.exitCode!==null || child.signalCode!==null;
      report.browserExit={code:child.exitCode,signal:child.signalCode};
      if(closeError && !report.intentionalDisconnect)throw closeError;
    })();
    return shutdownPromise;
  };
  try {
    report.sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:path.resolve(studio,'..'),encoding:'utf8'}).trim();
    report.toolSha256=hash(await readFile(new URL(import.meta.url)));
    report.runtimeSha256=hash(await readFile(path.join(studio,'runtime/resource-admission.mjs')));
    report.lockSha256=hash(await readFile(path.join(engine,'package-lock.json')));
    report.observedEngineSourceSha256 = hash(JSON.stringify(await inventory(engine, '', new Set(['node_modules','dist','frameleaf-source.json','frameleaf-build.json']))));
    const metadata = JSON.parse(await readFile(path.join(engine, 'node_modules/playwright-core/browsers.json'), 'utf8'));
    const pinned = metadata.browsers.find(item => item.name === 'chromium-headless-shell');
    assert.equal(pinned.revision, '1223'); assert.equal(pinned.browserVersion, '148.0.7778.96');
    const executable = path.join(os.homedir(), 'Library/Caches/ms-playwright', `chromium_headless_shell-${pinned.revision}`, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
    report.binarySha256 = hash(await readFile(executable));
    assert.equal(report.binarySha256, 'aa25f2e795c02d5cb5ef5d6987745cc5bbe7d8bea58827390c7a4c81c8d2dd7b');
    // Each realm executes the same native actions; labels identify authored fixtures,
    // not production request target ownership (root Fetch does not report a worker ID).
    foreign=http.createServer((request,response)=>{report.foreignFixture.requests.push({method:request.method,url:request.url});response.end();});
    foreign.on('connection',socket=>{report.foreignFixture.tcpConnections++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    foreign.listen(0,'127.0.0.1');await once(foreign,'listening');
    report.foreignOrigin=`http://127.0.0.1:${foreign.address().port}`;
    const actions=`async function run(realm){const g=await fetch('/get/'+realm);const h=await fetch('/head/'+realm,{method:'HEAD'});const redirectStatuses=[];for(const status of [301,302,303,307,308]){const r=await fetch('/redirect/'+realm+'/'+status);if(await r.text()!=='authored tiny local fixture')throw Error('redirect body');redirectStatuses.push(status)}let denied,preflight;try{await fetch('/denied/'+realm,{method:'POST',body:'tiny-authored-body'})}catch(e){denied=e.name}try{await fetch('${report.foreignOrigin}/cors/'+realm,{headers:{'x-fixture':'authored'}})}catch(e){preflight=e.name}const ws=await new Promise(resolve=>{const s=new WebSocket(location.origin.replace('http:','ws:')+'/socket/'+realm);s.onerror=()=>resolve('native-error');s.onopen=()=>resolve('unexpected-open')});return{get:await g.text(),head:h.status,redirectStatuses,denied,preflight,ws}}`;
    const workerSource = actions+`;onmessage=async e=>{try{if(e.data.nested){const w=new Worker('/worker.js');w.onmessage=e=>postMessage(e.data);w.postMessage({realm:'nested-worker'});return}postMessage(await run(e.data.realm))}catch(e){postMessage({error:e.name})}}`;
    fixture = http.createServer((request, response) => {
      const entry = { method: request.method, url: request.url, bodyBytes: 0 };
      report.ownedFixture.requests.push(entry);
      request.on('data', data => { entry.bodyBytes += data.length; });
      response.setHeader('cache-control','no-store');
      const redirect=/^\/redirect\/(window|dedicated-worker|nested-worker)\/(301|302|303|307|308)$/.exec(request.url);
      const negative=/^\/negative\/(foreign|wrong-file|query|host-alias|credentials|loop)$/.exec(request.url);
      if(redirect){response.writeHead(Number(redirect[2]),{location:'../../final/'+redirect[1]+'/'+redirect[2]});response.end();}
      else if(negative){const location={foreign:report.foreignOrigin+'/forbidden/foreign','wrong-file':'/forbidden/wrong-file',query:'/get/window?capability=authored','host-alias':'http://localhost:'+fixture.address().port+'/forbidden/host-alias',credentials:'http://authored:private@127.0.0.1:'+fixture.address().port+'/forbidden/credentials',loop:'/negative/loop'}[negative[1]];response.writeHead(302,{location});response.end();}
      else if (request.url === '/worker.js') { response.writeHead(200,{'content-type':'text/javascript'}); response.end(workerSource); }
      else if (request.url === '/sw.js') { response.writeHead(200,{'content-type':'text/javascript'}); response.end("self.addEventListener('install', e=>e.waitUntil(fetch('/denied/service-worker').catch(()=>{})));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));"); }
      else if (request.url === '/entry') { response.writeHead(200,{'content-type':'text/html'}); response.end('<!doctype html><title>Owned native fixture</title>'); }
      else { response.writeHead(200,{'content-type':'text/plain'}); response.end('authored tiny local fixture'); }
    });
    fixture.on('connection', socket => { report.ownedFixture.tcpConnections++; sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); });
    fixture.on('upgrade',(_,socket)=>{report.ownedFixture.upgrades++;socket.destroy();});
    fixture.listen(0,'127.0.0.1'); await once(fixture,'listening');
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    report.fixtureOrigin = origin;
    for(const name of ['trusted','untrusted'])execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(scratch,name+'-key.pem'),'-out',path.join(scratch,name+'-cert.pem'),'-subj','/CN=localhost','-days','1'],{stdio:'ignore'});
    const trustedCertificate=await readFile(path.join(scratch,'trusted-cert.pem'));
    const trustedSPKI=createHash('sha256').update(new X509Certificate(trustedCertificate).publicKey.export({type:'spki',format:'der'})).digest('base64');
    secure = https.createServer({key:await readFile(path.join(scratch,'trusted-key.pem')),cert:trustedCertificate},(req,res)=>{report.tlsFixture.trustedRequests++;report.tlsFixture.requests.push({method:req.method,url:req.url});const redirect=/^\/tls-redirect\/(301|302|303|307|308)$/.exec(req.url);if(redirect){res.writeHead(Number(redirect[1]),{location:'/tls-final/'+redirect[1]});res.end();}else if(req.url==='/tls-downgrade'){res.writeHead(302,{location:origin+'/get/window'});res.end();}else res.end('authored tiny TLS fixture');});
    untrusted=https.createServer({key:await readFile(path.join(scratch,'untrusted-key.pem')),cert:await readFile(path.join(scratch,'untrusted-cert.pem'))},(_,res)=>{report.tlsFixture.untrustedRequests++;res.end('must not reach HTTP');});
    for(const [server,key]of [[secure,'trustedConnections'],[untrusted,'untrustedConnections']]){server.on('connection',socket=>{report.tlsFixture[key]++;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});server.listen(0,'127.0.0.1');await once(server,'listening');}
    const tlsOrigin=`https://127.0.0.1:${secure.address().port}`,untrustedOrigin=`https://127.0.0.1:${untrusted.address().port}`;
    // These exact LOCAL TLS upstreams are the only opaque CONNECT exceptions.
    // They are synthetic certificate fixtures, never external egress plumbing.
    tlsHarness=createHarness({upstream:tlsOrigin});untrustedHarness=createHarness({upstream:untrustedOrigin});
    const tlsProxy=await tlsHarness.listen(),untrustedProxy=await untrustedHarness.listen();
    udp = dgram.createSocket('udp4'); udp.on('message',()=>report.ownedFixture.udpPackets++);
    udp.bind(0,'127.0.0.1'); await once(udp,'listening');
    harness = createHarness({upstream:origin,inspectConnect:true,overrides:[{
      // Only this tiny owned fixture is fronted. A URL/method ticket from its actual
      // native Request pause is consumed once; this is no external TLS guard.
      test(url,request) {
        const key=`${request.method}:${url.href}`, tickets=admissions.get(key);
        if(tickets?.length && !shuttingDown) {
          const admission=tickets.shift();
          observe({event:'fixture-forward-admitted',...admission,url:url.href,method:request.method});return false;
        }
        observe({event:'fixture-proxy-fallback-deny',url:url.href,method:request.method});return true;
      },
      respond(){return {status:403,body:''};}
    }]}); const proxy=await harness.listen();
    const {chromeLaunchArgs}=await import(pathToFileURL(path.join(engine,'headless/lib/cli.mjs')));
    const args=nativeArguments(proxy,scratch,chromeLaunchArgs()).concat(`--ignore-certificate-errors-spki-list=${trustedSPKI}`); report.argumentsSha256=hash(JSON.stringify(args));
    report.launchFlags=args.map(arg=>arg.startsWith('--user-data-dir=')?'--user-data-dir=<owned>':arg.startsWith('--proxy-server=')?'--proxy-server=<owned>':arg);
    child=spawn(executable,args,{stdio:['ignore','ignore','pipe']});
    childExit=once(child,'exit'); child.on('error',fail);
    child.stderr.on('data',()=>{}); // No debugging capability URL or browser error URL enters persistent logs.
    child.on('exit',()=>{if(!shuttingDown)fail(new Error('Owned browser exited before shutdown'));});
    let active;
    const startupUntil=Date.now()+deadline;
    while(!active) {
      if(firstFailure)throw firstFailure;
      if(Date.now()>startupUntil)throw new Error('Owned debugging endpoint timeout');
      try { active=(await readFile(path.join(scratch,'DevToolsActivePort'),'utf8')).trim().split('\n'); }
      catch(error) { if(error.code!=='ENOENT')throw error; await delay(10); }
    }
    assert.match(active[0],/^[0-9]+$/); assert.match(active[1],/^\/devtools\/browser\/[a-zA-Z0-9-]+$/);
    controller=await connectNativeController(`ws://127.0.0.1:${active[0]}${active[1]}`,observe,fail);
    // Handler is installed before any attachment command, context, or target creation.
    const allowed=new Set(['/entry','/worker.js',...['window','dedicated-worker','nested-worker'].flatMap(realm=>['/get/'+realm,'/head/'+realm,...[301,302,303,307,308].flatMap(status=>['/redirect/'+realm+'/'+status,'/final/'+realm+'/'+status])]),...['foreign','wrong-file','query','host-alias','credentials','loop'].map(name=>'/negative/'+name)]);
    const approvedURL=url=>(url.origin===origin && allowed.has(url.pathname+url.search)) || ([tlsOrigin,untrustedOrigin].includes(url.origin) && (/^\/tls$/.test(url.pathname) || (url.origin===tlsOrigin && /^\/tls-(?:downgrade|(?:redirect|final)\/(?:301|302|303|307|308))$/.test(url.pathname))) && !url.search);
    controller.setHandler(async message=>{
      if(shuttingDown)return;
      const {method,params={},sessionId:parentSession}=message;
      if(parentSession && !targets.has(parentSession))throw new Error('Unknown CDP event session');
      if(method==='Target.attachedToTarget') {
        const {sessionId,targetInfo,waitingForDebugger}=params;
        assert.ok(sessionId && !targets.has(sessionId),'Unique attached session required');
        const state={sessionId,parentSession,targetId:targetInfo.targetId,type:targetInfo.type,waitingForDebugger,ready:false,owned:ownedContexts.has(targetInfo.browserContextId)};
        targets.set(sessionId,state); observe({event:'target-attached',...state});
        if(!state.owned || !['page','worker'].includes(state.type)) {
          assert.equal(waitingForDebugger,true,'Unowned target must remain paused');
          state.expectedDetach=true;
          if(!closingTargets.has(state.targetId))closingTargets.set(state.targetId,controller.send('Target.closeTarget',{targetId:state.targetId}));
          const closed=await closingTargets.get(state.targetId);assert.equal(closed.success,true,'Paused target close acknowledged');
          state.closedPaused=true;observe({event:state.owned?'unsupported-target-closed-paused':'unowned-target-closed-paused',sessionId,targetId:state.targetId,type:state.type}); return;
        }
        assert.equal(waitingForDebugger,true,'Owned target ran before guard');
        await installNativeTargetGate(controller,observe,sessionId);
        await controller.send('Network.enable',{},sessionId);
        assert.ok(rootFetchReady,'Browser Fetch acknowledged before target resume');
        state.guardsAcknowledged=true; observe({event:'guards-acknowledged',sessionId});
        await controller.send('Runtime.runIfWaitingForDebugger',{},sessionId);
        state.ready=true; observe({event:'target-resumed',sessionId});
      } else if(method==='Target.detachedFromTarget') {
        const state=targets.get(params.sessionId);
        if(!shuttingDown && !state?.expectedDetach)throw new Error('Unexpected target detach');
        if(state)state.detached=true;
      } else if(method==='Fetch.requestPaused') {
        assert.equal(parentSession,undefined,'Fetch pause belongs to root guard');assert.ok(rootFetchReady);
        const key=params.requestId,request=params.request;
        const responseStage=Object.hasOwn(params,'responseStatusCode') || Object.hasOwn(params,'responseErrorReason');
        const url=new URL(request.url); const relative=url.pathname+url.search;
        observe({event:'native-fetch-pause',stage:responseStage?'Response':'Request',sessionId:parentSession,requestId:params.requestId,url:request.url,method:request.method,requestAttribution:'UNKNOWN'});
        const previous=requests.get(key);
        if(responseStage) {
          assert.ok(previous && previous.url===request.url,'Response pause matches root request ID');
          const location=params.responseHeaders?.find(header=>header.name.toLowerCase()==='location')?.value;
          if(location && params.responseStatusCode>=300 && params.responseStatusCode<400) {
            const resolved=new URL(location,previous.url).href;
            previous.redirect=resolved;
            observe({event:'redirect-response',requestId:params.requestId,parentUrl:previous.url,status:params.responseStatusCode,locationSha256:hash(location),resolvedSha256:hash(resolved)});
            const destination=new URL(resolved);
            const sourceURL=new URL(previous.url);
            const expectedFinal=sourceURL.pathname.replace(/^\/redirect\//,'/final/').replace(/^\/tls-redirect\//,'/tls-final/');
            if(!approvedURL(destination) || destination.username || destination.password || destination.hash || (sourceURL.protocol==='https:' && destination.protocol!=='https:') || destination.pathname!==expectedFinal || resolved===request.url || previous.hops>=5) {
              observe({event:'guard-deny',stage:'Response',sessionId:parentSession,requestId:params.requestId,url:request.url,reason:'unapproved redirect'});
              await controller.send('Fetch.failRequest',{requestId:params.requestId,errorReason:'BlockedByClient'},parentSession); return;
            }
          }
          await controller.send('Fetch.continueRequest',{requestId:params.requestId},parentSession); return;
        }
        if(params.redirectedRequestId) {
          const prior=requests.get(params.redirectedRequestId);
          assert.ok(prior?.redirect && prior.redirect===request.url,'Exact root request-ID redirected chain');
          observe({event:'redirect-chain-verified',sessionId:parentSession,requestId:params.requestId,redirectedRequestId:params.redirectedRequestId,url:request.url});
        }
        const forbiddenHeader=Object.entries(request.headers??{}).some(([name,value])=>/^(cookie|authorization|proxy-authorization|transfer-encoding)$/i.test(name) || (name.toLowerCase()==='content-length' && value!=='0'));
        const reason= !['GET','HEAD'].includes(request.method)?'method':request.hasPostData || request.postData || request.postDataEntries?.length?'body':forbiddenHeader?'private header':
          !params.redirectedRequestId && /^\/(final|tls-final)\//.test(url.pathname)?'missing redirect parent':
          url.username || url.password || url.hash?'credentials or fragment':!approvedURL(url)?'URL':null;
        requests.set(key,{url:request.url,networkId:params.networkId,hops:params.redirectedRequestId?(requests.get(params.redirectedRequestId).hops+1):0});
        if(relative==='/hold-denied') { observe({event:'request-held-for-disconnect',requestId:params.requestId,url:request.url}); return; }
        observe({event:reason?'guard-deny':'guard-allow',stage:'Request',sessionId:parentSession,requestId:params.requestId,url:request.url,method:request.method,reason,requestAttribution:'UNKNOWN'});
        if(!reason) {
          const admissionKey=`${request.method}:${request.url}`;
          const tickets=admissions.get(admissionKey)??[];
          tickets.push({requestId:params.requestId,requestAttribution:'UNKNOWN'});admissions.set(admissionKey,tickets);
        }
        await controller.send(reason?'Fetch.failRequest':'Fetch.continueRequest',reason?{requestId:params.requestId,errorReason:'BlockedByClient'}:{requestId:params.requestId},parentSession);
      } else if(method==='Network.loadingFailed' || method==='Network.webSocketCreated' || method==='Network.webSocketClosed') {
        observe({event:method,sessionId:parentSession,requestId:params.requestId,errorText:params.errorText});
      }
    });
    const version=await controller.send('Browser.getVersion'); report.browserVersion=version.product;
    assert.equal(version.product,`HeadlessChrome/${pinned.browserVersion}`);
    await controller.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'},{urlPattern:'*',requestStage:'Response'}]});
    rootFetchReady=true;observe({event:'root-fetch-ready',requestAttribution:'UNKNOWN'});
    await installNativeTargetGate(controller,observe);
    contextId=(await controller.send('Target.createBrowserContext')).browserContextId;ownedContexts.add(contextId);
    const pageId=(await controller.send('Target.createTarget',{url:'about:blank',browserContextId:contextId})).targetId;
    await waitUntil(()=>[...targets.values()].some(s=>s.targetId===pageId && s.ready),failure,'guarded page');
    const page=[...targets.values()].find(s=>s.targetId===pageId);
    await controller.send('Page.enable',{},page.sessionId);
    await controller.send('Page.navigate',{url:origin+'/entry'},page.sessionId);
    await waitUntil(()=>report.ownedFixture.requests.some(r=>r.url==='/entry'),failure,'native fixture entry');
    await evaluate(page.sessionId,`new Promise(r=>document.readyState==='complete'?r(true):addEventListener('load',()=>r(true),{once:true}))`);
    const window=await evaluate(page.sessionId,actions+";run('window')");
    report.gates.window={disposition:'measured-local-fixture',requestAttribution:'UNKNOWN',result:window};
    const runWorker=nested=>evaluate(page.sessionId,`new Promise((resolve,reject)=>{const w=new Worker('/worker.js');(window.ownedWorkers??=[]).push(w);w.onmessage=e=>resolve(e.data);w.onerror=()=>reject(new Error('worker'));w.postMessage({nested:${nested},realm:'dedicated-worker'})})`);
    for(const [name,nested] of [['dedicated-worker',false],['nested-worker',true]]) {
      const result=await runWorker(nested);assert.equal(result.get,'authored tiny local fixture');assert.equal(result.denied,'TypeError');assert.equal(result.preflight,'TypeError');
      report.gates[name]={disposition:'measured-local-fixture',requestAttribution:'UNKNOWN',result};
    }
    const negativeCases=[];
    for(const name of ['foreign','wrong-file','query','host-alias','credentials','loop']){const denied=await evaluate(page.sessionId,`fetch('/negative/${name}').then(()=>false,()=>true)`);assert.equal(denied,true);negativeCases.push({name,denied});}
    const copiedFinalDenied=await evaluate(page.sessionId,`fetch('/final/window/302').then(()=>false,()=>true)`);assert.equal(copiedFinalDenied,true);
    report.gates['relative-redirect-chain']={disposition:'measured-local-fixture',statuses:[301,302,303,307,308],negativeCases,copiedFinalDenied};
    report.gates.sockets=Object.fromEntries(['window','dedicated-worker','nested-worker'].map(realm=>{
      assert.equal(report.gates[realm].result.ws,'native-error');
      assert.ok(harness.observations.some(o=>o.url===origin+'/socket/'+realm && o.kind==='error'));
      assert.ok(!report.observations.some(o=>o.event==='native-fetch-pause' && o.url===origin+'/socket/'+realm));
      return [realm,{disposition:'proxy-fallback-refusal',interceptionCoverage:'unproven'}];
    }));
    assert.equal(report.ownedFixture.upgrades,0);assert.equal(report.foreignFixture.tcpConnections,0);assert.equal(report.foreignFixture.requests.length,0);
    const tlsResults=[];
    for(const [proxy,url,shouldTrust]of [[tlsProxy,tlsOrigin+'/tls',true],[untrustedProxy,untrustedOrigin+'/tls',false]]){
      const {browserContextId}=await controller.send('Target.createBrowserContext',{proxyServer:proxy,proxyBypassList:'<-loopback>'});ownedContexts.add(browserContextId);
      const {targetId}=await controller.send('Target.createTarget',{url:'about:blank',browserContextId});
      await waitUntil(()=>[...targets.values()].some(s=>s.targetId===targetId && s.ready),failure,'guarded TLS fixture page');
      const tlsPage=[...targets.values()].find(s=>s.targetId===targetId);
      await controller.send('Page.enable',{},tlsPage.sessionId);
      const result=await controller.send('Page.navigate',{url},tlsPage.sessionId);
      if(shouldTrust){assert.ok(!result.errorText);await waitUntil(()=>report.tlsFixture.trustedRequests===1,failure,'trusted native TLS request');await evaluate(tlsPage.sessionId,`new Promise(r=>document.readyState==='complete'?r(true):addEventListener('load',()=>r(true),{once:true}))`);tlsResults.push(await evaluate(tlsPage.sessionId,'document.body.innerText'));
        const redirects=await evaluate(tlsPage.sessionId,`(async()=>{const statuses=[];for(const status of [301,302,303,307,308]){const r=await fetch('/tls-redirect/'+status);if(await r.text()!=='authored tiny TLS fixture')throw Error('TLS redirect body');statuses.push(status)}return statuses})()`);
        report.gates.https={redirectStatuses:redirects,downgradeDenied:await evaluate(tlsPage.sessionId,`fetch('/tls-downgrade').then(()=>false,()=>true)`)};assert.equal(report.gates.https.downgradeDenied,true);}
      else{assert.match(result.errorText,/ERR_CERT_/);tlsResults.push(true);}
    }
    assert.equal(report.tlsFixture.untrustedRequests,0);
    report.gates.https={...report.gates.https,disposition:'measured-local-native-TLS',trustedBody:tlsResults[0],certificateRejection:tlsResults[1],trust:'task-only certificate SPKI; second certificate remains rejected',externalTLS:'unmeasured'};
    report.gates.webtransport={disposition:'not-executed',interceptionCoverage:'unproven'};
    // Closing a new paused SW target can leave its registration promise unsettled.
    // Observe that actual target refusal without awaiting or claiming activation.
    await evaluate(page.sessionId,`window.ownedSWOutcome={registration:'unsettled'};void navigator.serviceWorker.register('/sw.js').then(()=>{window.ownedSWOutcome={registration:'registered'}},e=>{window.ownedSWOutcome={registration:'rejected',name:e.name}});true`);
    await waitUntil(()=>[...targets.values()].some(s=>s.type==='service_worker' && s.closedPaused),failure,'paused service worker target refusal');
    const sw=await evaluate(page.sessionId,'window.ownedSWOutcome');
    report.gates.serviceworker={disposition:'closed-paused-target-refusal',nativeOutcome:sw,activation:'unqualified',interceptionCoverage:'unproven'};
    assert.ok(!report.ownedFixture.requests.some(r=>r.url.startsWith('/denied/')));
    const otherContext=(await controller.send('Target.createBrowserContext')).browserContextId;
    await controller.send('Target.createTarget',{url:'about:blank',browserContextId:otherContext});
    await waitUntil(()=>report.observations.some(o=>o.event==='unowned-target-closed-paused'),failure,'unowned paused refusal');
    report.gates['unowned-target']={disposition:'closed-before-resume'};
    report.gates['browser-process']={disposition:'unsupported',reason:'No independent attributable browser-process network trigger qualified by this fixture; renderer observations do not prove it'};
    const held=evaluate(page.sessionId,`fetch('/hold-denied').then(()=>true,()=>false)`);held.catch(()=>{});
    await waitUntil(()=>report.observations.some(o=>o.event==='request-held-for-disconnect'),failure,'held native request');
    report.intentionalDisconnect=true;controller.close();
    await stopBrowser();assert.ok(!report.ownedFixture.requests.some(r=>r.url==='/hold-denied'));
    report.gates['guard-disconnect']={disposition:'measured-owned-browser-shutdown',browserExited:report.browserExited,containment:'task-local proxy; external native denial unqualified'};
    report.gates['request-response-pauses']={disposition:'measured',requestAttribution:'UNKNOWN',requestPauses:report.observations.filter(o=>o.event==='native-fetch-pause' && o.stage==='Request').length,responsePauses:report.observations.filter(o=>o.event==='native-fetch-pause' && o.stage==='Response').length};
    if(firstFailure)throw firstFailure;
    report.status='partial-local-preflight';
    report.remainingGates=['production request-to-target attribution','browser-process attribution','external all-channel native denial under host bypass','WSS interception under future bypass','WebTransport interception under future bypass','external native HTTPS/redirect transport','full production negative matrix and sanitizer qualification'];
  } catch(error) {
    firstFailure??=error;report.error=nativeDiagnosticError(firstFailure);report.status=firstFailure instanceof Unsupported?'unsupported':'failed';
    const rejected=report.observations.find(o=>o.event==='command-rejected' && o.method==='Fetch.enable');
    if(rejected) {
      report.unsupported={primitive:'browser-target Request/Response Fetch enable',targetType:'browser',sessionId:rejected.sessionId,reason:rejected.reason};
      report.gates['request-response-pauses']={disposition:'unsupported',reason:rejected.reason};
    }
  } finally {
    if(harness)report.harness=harness.observations;report.tlsProxies=[tlsHarness?.observations??[],untrustedHarness?.observations??[]];
    await cleanupWhisperRun(report,[async()=>{await stopBrowser();if(shutdownFailure)throw shutdownFailure;},()=>controller?.close(),async()=>{await harness?.close();observe({event:'owned-proxy-closed'});},()=>tlsHarness?.close(),()=>untrustedHarness?.close(),
      async()=>{for(const socket of sockets)socket.destroy();await Promise.all([fixture,secure,untrusted,foreign].filter(Boolean).map(server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))));},
      ()=>udp && new Promise(resolve=>udp.close(resolve))],()=>rm(scratch,{recursive:true,force:true}),
      ()=>{report.harness=JSON.parse(JSON.stringify(harness?.observations??[]));if(report.gates.serviceworker.disposition==='closed-paused-target-refusal')report.gates.serviceworker.fixtureProxyFallbackDenials=report.observations.filter(o=>o.event==='fixture-proxy-fallback-deny' && o.url===report.fixtureOrigin+'/sw.js').length;return writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});});
  }
  return report;
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.env.STUDIO_NATIVE_PREFLIGHT,'1','Explicit local native preflight required');
  assert.ok(process.env.STUDIO_NATIVE_PREFLIGHT_REPORT,'Fresh absolute report required');
  const report=await runNativeInterceptionPreflight(process.env.STUDIO_NATIVE_PREFLIGHT_REPORT);
  console.log(JSON.stringify({status:report.status,error:report.error,gates:report.gates,cleanup:report.cleanup}));
  if(report.status!=='partial-local-preflight')process.exitCode=report.status==='unsupported'?2:1;
}
