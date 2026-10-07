// This runs in a fresh browser/worker realm with real CacheStorage. All bodies are authored fixtures.
export async function run() {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const rejected = async (work, message) => { try { await work(); } catch { return; } throw Error(message); };
  const bytes = new Uint8Array(new Float32Array(256).fill(0.25).buffer);
  const equals = (actual) => actual.length === bytes.length && actual.every((v,i)=>v===bytes[i]);
  const base = 'https://huggingface.co/synthetic-contract/transport/resolve/';
  const revision = 'a'.repeat(40);
  const rawOpen = caches.open.bind(caches);
  const cache = await rawOpen('transformers-cache');
  const voice = await rawOpen('kokoro-voices');
  const rawMatch = cache.match.bind(cache), rawPut = cache.put.bind(cache), rawDelete = cache.delete.bind(cache);
  let mode = 'good', downloads = 0, persisted = 0;
  // Native cache failures are injected beneath production wrappers; loaders remain unmodified.
  caches.open = async name => { if (mode==='open-fail' && name==='transformers-cache') throw Error('fixture open error'); return name==='transformers-cache'?cache:rawOpen(name); };
  cache.match = async (...args) => { if (mode==='match-fail' || mode==='corrupt-match-fail') throw Error('fixture match error'); return rawMatch(...args); };
  cache.put = async (...args) => { persisted++; if(mode==='put-fail') throw Error('fixture put error'); return rawPut(...args); };
  cache.delete = async (...args) => { if(mode==='delete-fail') throw Error('fixture delete error'); return rawDelete(...args); };
  globalThis.fetch = async request => {
    downloads++;
    check(request instanceof Request,'transport receives native Request');
    check(request.url.includes(`/resolve/${revision}/`),'canonical revision');
    if(mode==='aborted-read') return new Response(new ReadableStream({start(c){c.error(Error('fixture body failed'))}}));
    if(mode==='partial') return new Response(bytes,{status:206});
    if(mode==='failed-voice') return new Response(new Float32Array(256).fill(0.75),{status:404});
    if(mode==='failure') return new Response('not found',{status:404});
    if(mode.startsWith('corrupt')) return new Response('corrupt');
    if(mode==='opaque') { const r=new Response(bytes);Object.defineProperty(r,'type',{value:'opaque'});return r; }
    if(mode==='redirect') {const r=new Response(bytes,{headers:{'x-fixture':'retained'}});Object.defineProperties(r,{url:{value:'https://cdn.invalid/unapproved.bin'},redirected:{value:true}});return r;}
    return new Response(bytes,{headers:{'content-length':String(bytes.length),'x-fixture':'retained'}});
  };
  await import('/policy/src/shared/utils/resource-admission.mjs');
  const root = await import('/node_modules/@huggingface/transformers/src/utils/hub.js');
  const nested = await import('/node_modules/kokoro-js/node_modules/@huggingface/transformers/src/utils/hub.js');
  const rootEnv = (await import('/node_modules/@huggingface/transformers/src/env.js')).env;
  const nestedEnv = (await import('/node_modules/kokoro-js/node_modules/@huggingface/transformers/src/env.js')).env;
  check(rootEnv.version==='4.1.0' && nestedEnv.version==='3.8.1','actual installed versions');
  check(nestedEnv.allowLocalModels===false,'Kokoro installed browser runtime disables local files');
  for(const env of [rootEnv,nestedEnv]) { env.allowLocalModels=false;env.allowRemoteModels=true;env.useBrowserCache=true;env.useFSCache=false;env.useCustomCache=false; }
  for(const [version,hub] of [[4,root],[3,nested]]) {
    const load = name => hub.getModelFile('synthetic-contract/transport',`${version}-${name}.bin`,true,{revision});
    mode='good';check(equals(await load('cold')),'cold exact bytes');
    check(!!await rawMatch(`${base}${revision}/${version}-cold.bin`),'canonical persist');
    mode='corrupt';const before=persisted;await rejected(()=>load('corrupt'),'cold corruption escaped');check(persisted===before,'corrupt persisted');
    mode='good';await rawPut(`${base}${revision}/${version}-warm.bin`,new Response(bytes));const count=downloads;
    check(equals(await load('warm')) && downloads===count,'warm exact bytes');
    await rawPut(`${base}main/${version}-legacy.bin`,new Response(bytes));
    check(equals(await hub.getModelFile('synthetic-contract/transport',`${version}-legacy.bin`,true,{revision:'main'})),'legacy exact bytes');
    for(const name of ['stale','delete-fail']) {
      await rawPut(`${base}main/${version}-${name}.bin`,new Response('stale'));
      mode=name==='delete-fail'?'delete-fail':'good';
      check(equals(await hub.getModelFile('synthetic-contract/transport',`${version}-${name}.bin`,true,{revision:'main'})),'corrupt cache verified fallback');
    }
    for(const name of ['match-fail','put-fail','open-fail']) { mode=name;check(equals(await load(name)),`${name} verified fallback`); }
    await rawDelete(`${base}${revision}/${version}-match-fail.bin`);mode='corrupt-match-fail';await rejected(()=>load('match-fail'),'cache failure permitted corrupt fetch');
    mode='good';const prev=downloads;
    for(const name of ['extra.bin','tokenizer.json','model.onnx_data']) await rejected(()=>hub.getModelFile('synthetic-contract/transport',name,true,{revision}),'unapproved file escaped');
    check(downloads===prev,'unapproved file fetched');
  }
  mode='good';const wrapped=await caches.open('transformers-cache');
  for(const key of [`${base}main/config.json?query=1`,`${base}wrong/config.json`,`${base}main/%2fconfig.json`,'/local/config.json']) await rejected(()=>wrapped.match(key),'invalid cache key escaped');
  for(const method of ['matchAll','add','addAll']) await rejected(()=>wrapped[method](`${base}main/config.json`),'raw cache method exposed');
  const other=await caches.open('fixture-unrelated');await other.put('https://fixture.invalid/local',new Response('unrelated'));
  check((await other.matchAll()).length===1,'unrelated cache semantics');
  check((await wrapped.keys()).length>0,'named cache management remains usable');
  await rejected(()=>wrapped.put(`${base}main/config.json`,new Response('wrong')),'corrupt put');
  await rejected(()=>wrapped.match(`${base}main/config.json`,{ignoreSearch:true}),'cache options widen identity');
  await rawPut(`${base}main/config.json`,new Response('wrong'));
  check(await caches.match(`${base}main/config.json`,{cacheName:new String('transformers-cache')})===undefined,'boxed named cache bypass');
  await rawPut(`${base}main/config.json`,new Response('wrong'));await rejected(()=>caches.match(`${base}main/config.json`),'storage match bypass');
  for(const state of ['partial','aborted-read','opaque']) {mode=state;await rejected(()=>fetch(`${base}main/config.json`),'partial/unreadable accepted');}
  mode='failure';check((await fetch(`${base}main/config.json`)).status===404,'optional HTTP semantics');
  for(const hub of [root,nested]) check(await hub.getModelFile('synthetic-contract/transport','config.json',false,{revision})===null,'actual loader optional404 semantics');
  mode='good';const noFetch=downloads;
  for(const url of ['https://huggingface.co/synthetic-contract/empty/resolve/main/config.json',
    `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_nova.bin`,
    `${base}main/config.json?download=1`,`${base}other/config.json`,`${base}main/%2e%2e/config.json`]) await rejected(()=>fetch(url),'missing/blocked binding escaped');
  check(downloads===noFetch,'missing/blocked binding fetched');
  mode='good';const abort=new AbortController();abort.abort();const previous=downloads;
  await rejected(()=>fetch(new Request(`${base}main/config.json`,{signal:abort.signal})),'aborted request accepted');check(previous===downloads,'aborted fetched');
  const writes=persisted;const late=new AbortController();
  await rejected(()=>wrapped.put(new Request(`${base}main/config.json`,{signal:late.signal}),
    new Response(new ReadableStream({pull(c){c.enqueue(bytes);late.abort();c.close()}}))),'aborted cache body persisted');
  check(persisted===writes,'aborted read reached persistence');
  mode='redirect';const response=await fetch(`${base}main/config.json`);check(response.headers.get('x-fixture')==='retained'&&equals(new Uint8Array(await response.arrayBuffer())),'response compatibility');
  // Actual browser build selects fs/promises:false. generate_from_ids executes its voice transport
  // and tensor construction; authored model output is a sink observation, not inference evidence.
  const {KokoroTTS}=await import('/node_modules/kokoro-js/dist/kokoro.js');
  let styles=0;const tts=new KokoroTTS(async ({style})=>{styles++;check(style.data.every(v=>v===0.25),'unverified voice reached tensor');return {waveform:{data:new Float32Array([0])}}},null);
  check(nestedEnv.allowLocalModels===false,'Kokoro browser local file branch disabled');
  const ids={dims:[1,2]};const voiceBase='https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/';
  mode='good';const start=downloads;
  await tts.generate_from_ids(ids,{voice:'af_heart'});check(downloads===start+1,'actual browser voice fetch');
  check(!!await voice.match(`${voiceBase}${revision}/voices/af_heart.bin`),'voice canonical persist');
  mode='corrupt';await tts.generate_from_ids(ids,{voice:'af_heart'});check(downloads===start+1,'verified in-memory voice reuse');
  await voice.put(`${voiceBase}main/voices/af_alloy.bin`,new Response(bytes));
  await tts.generate_from_ids(ids,{voice:'af_alloy'});check(downloads===start+1,'native legacy voice read');
  await voice.put(`${voiceBase}main/voices/af_bella.bin`,new Response('bad'));
  await rejected(()=>tts.generate_from_ids(ids,{voice:'af_bella'}),'corrupt voice escaped fallback');check(styles===3,'corrupt voice reached sink');
  mode='failed-voice';const failedStart=downloads;
  await rejected(()=>tts.generate_from_ids(ids,{voice:'af_sarah'}),'failed HTTP voice escaped');
  check(styles===3,'failed HTTP voice reached model sink');
  check(!await voice.match(`${voiceBase}${revision}/voices/af_sarah.bin`),'failed HTTP voice persisted');
  mode='good';await tts.generate_from_ids(ids,{voice:'af_sarah'});
  check(downloads===failedStart+2 && styles===4,'failed HTTP response poisoned voice Map or prevented fresh verified fetch');
  return {versions:[rootEnv.version,nestedEnv.version],kokoro:true,checked:true};
}
