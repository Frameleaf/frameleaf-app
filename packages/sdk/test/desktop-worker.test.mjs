import assert from 'node:assert/strict';
import test from 'node:test';
import {claimDesktopTask,completeDesktopTask,readDesktopTaskInput,readDesktopAcceptedQualification} from '../build/index.js';

const proof='fixture-proof';
const authorization='Bearer fixture-worker-token';
test('desktop claim/result preserve exact signed payload strings and keep credentials in headers', async () => {
  for (const [operation,path,args] of [
    [claimDesktopTask,'/api/desktop/worker/claim',{}],
    [completeDesktopTask,'/api/desktop/tasks/attempt/result',{id:'attempt'}],
  ]) {
    const payload='{"model":"été","value":1e+20}';
    const result=await operation({...args,xFrameleafDesktopProof:proof,desktopWorkerPayloadDto:{payload}}, {
      headers:{Authorization:authorization},
      fetch:async (url,options) => {
        assert.equal(url,path);
        const headers=new Headers(options.headers);
        assert.equal(headers.get('authorization'),authorization);
        assert.equal(headers.get('x-frameleaf-desktop-proof'),proof);
        assert.deepEqual(JSON.parse(options.body),{payload});
        assert.ok(!url.includes('token'));
        return new Response(JSON.stringify(path.endsWith('/claim')?{task:null}:{accepted:true}),{headers:{'content-type':'application/json'}});
      },
    });
    assert.ok(result);
  }
});
test('desktop scoped input remains binary and carries both proofs outside the URL', async () => {
  const bytes=new Uint8Array([0,255,1,10]);
  const result=await readDesktopTaskInput({id:'attempt',xFrameleafDesktopProof:proof},{
    headers:{Authorization:authorization},
    fetch:async (url,options) => {
      assert.equal(url,'/api/desktop/tasks/attempt/input');
      const headers=new Headers(options.headers);
      assert.equal(headers.get('authorization'),authorization);
      assert.equal(headers.get('x-frameleaf-desktop-proof'),proof);
      return new Response(bytes,{headers:{'content-type':'application/octet-stream'}});
    },
  });
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()),bytes);
});


test('accepted qualification reads retain both credentials in headers and return evidence metadata', async () => {
  const id='d621bd72-ad35-4199-95ab-76300756a38e';
  const evidence={id,deviceId:'445bc2b6-f4cd-439e-b8bb-7e84d7ee0550',sessionId:'1117c1ca-0495-46e9-b579-f321520c2b1a',authorizationEpoch:2,modelKey:'clip:'+ 'a'.repeat(64),configSha256:'b'.repeat(64),inputKind:'text',bindingSha256:'c'.repeat(64),manifestSha256:'d'.repeat(64),runtimeFingerprint:'e'.repeat(64),reportSha256:'f'.repeat(64),qualifiedAt:'2026-10-15T20:00:00Z',expiresAt:'2026-10-15T21:00:00Z'};
  const result=await readDesktopAcceptedQualification({id,xFrameleafDesktopProof:proof},{headers:{Authorization:authorization},fetch:async(url,options)=>{
    assert.equal(url,'/api/desktop/worker/qualifications/'+id);
    assert.equal(options.method ?? 'GET','GET');
    assert.equal(options.body,undefined);
    const headers=new Headers(options.headers);
    assert.equal(headers.get('authorization'),authorization);
    assert.equal(headers.get('x-frameleaf-desktop-proof'),proof);
    return new Response(JSON.stringify(evidence),{headers:{'content-type':'application/json'}});
  }});
  assert.deepEqual(result,evidence);
});
