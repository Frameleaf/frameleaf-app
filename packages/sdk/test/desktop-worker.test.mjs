import assert from 'node:assert/strict';
import test from 'node:test';
import {claimDesktopTask,completeDesktopTask,readDesktopTaskInput} from '../build/index.js';

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
