// Synthetic protocol fixtures through real installed loaders and native browser caches.
// No model payloads, inference, production approval or platform qualification.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdtemp, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeResourcePolicy } from './resource-policy.mjs';
import { approvalRowDigest } from '../../scripts/frameleaf-studio-rights.mjs';
const studio = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(studio, 'engine/package.json'));

export async function runModelTransportAdmission() {
  const cleanup = [];
  const t = { after: callback => cleanup.push(callback) };
  try {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-model-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(studio, 'runtime'), path.join(root, 'runtime'), { recursive: true });
  const payload = Buffer.from(new Float32Array(256).fill(0.25).buffer);
  const digest = createHash('sha256').update(payload).digest('hex');
  const revision = 'a'.repeat(40);
  const cases = ['cold', 'corrupt', 'warm', 'legacy', 'stale', 'match-fail', 'put-fail', 'delete-fail', 'open-fail'];
  const row = (locator, files) => ({ id: `model:${locator}`, kind: 'model', locator, revision,
    licenseDeclared: 'Synthetic protocol fixture', decisions: { redistribution: 'blocked', localRuntime: 'blocked', hostedUse: 'blocked' },
    files: files.map((path) => ({ path, sha256: digest })) });
  const rows = [row('synthetic-contract/transport', ['config.json', ...[4,3].flatMap(v => cases.map(c => `${v}-${c}.bin`))]),
    row('onnx-community/Kokoro-82M-v1.0-ONNX', ['af_heart','af_alloy','af_bella','af_nova','af_sarah'].map(v => `voices/${v}.bin`)), row('synthetic-contract/empty', []),
    {...row('synthetic-contract/blocked-voice',['voices/af_nova.bin']), locator:`https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${revision}/voices/af_nova.bin`}];
  await writeFile(path.join(root, 'dependency-attribution.json'), JSON.stringify({schemaVersion:1,resources:rows}));
  await writeFile(path.join(root, 'rights-approval.json'), JSON.stringify({schemaVersion:1,approvedBy:'Synthetic contract',approvedOn:'2026-10-07',
    source:'Authored protocol fixture, not production approval',uses:['localRuntime'],resources:rows.slice(0,-1).map(r=>({id:r.id,sha256:approvalRowDigest(r)}))}));
  await writeResourcePolicy(root, path.join(root, 'policy'));
  await symlink(path.join(studio,'engine/node_modules'), path.join(root,'node_modules'));
  await writeFile(path.join(root,'index.html'), '<!doctype html><title>Transport contract</title>');
  await writeFile(path.join(root,'contract.mjs'), await readFile(new URL('./fixtures/model-transport-contract.mjs',import.meta.url)));
  const { createServer } = await import(require.resolve('vite'));
  const server = await createServer({configFile:false,root,server:{host:'127.0.0.1',port:0,fs:{allow:[root,studio]}},
    optimizeDeps:{noDiscovery:true},logLevel:'error'});
  await server.listen(); t.after(()=>server.close());
  const browser = await require('playwright').chromium.launch({headless:true}); t.after(()=>browser.close());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const realm of ['window','worker']) {
    const context = await browser.newContext();
    await context.route('https://**/*',route=>route.abort('blockedbyclient'));
    const page = await context.newPage();
    await page.goto(origin);
    const result = await page.evaluate(async ({realm}) => {
      if (realm === 'window') return (await import('/contract.mjs')).run();
      const worker = new Worker(URL.createObjectURL(new Blob([`import {run} from '${location.origin}/contract.mjs'; run().then(r=>postMessage({result:r}),e=>postMessage({error:e.stack}));`],{type:'text/javascript'})),{type:'module'});
      return new Promise((resolve,reject)=>{worker.onmessage=({data})=>{worker.terminate();data.error?reject(Error(data.error)):resolve(data.result)};worker.onerror=e=>reject(Error(e.message))});
    },{realm});
    assert.deepEqual(result.versions,['4.1.0','3.8.1']);
    assert.equal(result.kokoro,true); assert.equal(result.checked,true);
    await context.close();
  }
  return { chromium: true, window: true, worker: true, versions: ['4.1.0', '3.8.1'], kokoro: true };
  } finally { for (const close of cleanup.reverse()) await close(); }
}
