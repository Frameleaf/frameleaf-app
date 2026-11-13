import { pathToFileURL, fileURLToPath } from 'node:url';import https from 'node:https';import fs from 'node:fs';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';
const root=pathToFileURL(process.env.FRAMELEAF_FIXTURE_DIR.replace(/\/$/,'')+'/');
const wordpressOrigin=`https://localhost:${process.env.FRAMELEAF_FIXTURE_WEB_PORT||39443}`;
const providerOrigin=process.env.FRAMELEAF_FIXTURE_ORIGIN||'https://localhost:39444';const ca=fs.readFileSync(new URL('certs/ca.pem',root));const pass=fs.readFileSync(new URL('admin-password',root),'utf8');
function agent(){const cookies=new Map();return async (path,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{const url=new URL(path,wordpressOrigin);const req=https.request(url,{ca,family:4,method,headers:{...headers,Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')}},res=>{for(const c of res.headers['set-cookie']||[]){const [p]=c.split(';');const at=p.indexOf('=');cookies.set(p.slice(0,at),p.slice(at+1));}let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:data,json:()=>JSON.parse(data)}));});req.setTimeout(35000,()=>req.destroy(new Error('Synthetic HTTP request timed out')));req.on('error',reject);if(body)req.write(body);req.end();});}
const client=agent();
await client('/wp-login.php');
const login=await client('/wp-login.php',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({log:'fixture-editor',pwd:pass,'wp-submit':'Log In',testcookie:'1'}).toString()});assert.equal(login.status,302);
const page=await client('/wp-admin/upload.php?page=frameleaf-connect');assert.equal(page.status,200);
const nonce=page.text.match(/createNonceMiddleware\(\s*"([a-f0-9]+)"/)?.[1];if(!nonce)throw Error('Missing native REST nonce');
const json=body=>({method:'POST',headers:{'Content-Type':'application/json','X-WP-Nonce':nonce},body:JSON.stringify(body)});
const start=await client('/?rest_route=/frameleaf-connect/v1/connection',json({origin:providerOrigin}));assert.equal(start.status,200,start.text);
const provider=await client(start.json().authorizeUrl);assert.equal(provider.status,302);
const callback=new URL(provider.headers.location);const wrong=new URL(callback);wrong.searchParams.set('state','wrong');assert.equal((await client(wrong.href)).status,400,'state mismatch rejected');
const finish=await client(callback.href);assert.equal(finish.status,302,finish.text);
assert.equal((await client(callback.href)).status,400,'callback replay rejected');
const status=await client('/?rest_route=/frameleaf-connect/v1/connection',{headers:{'X-WP-Nonce':nonce}});assert.equal(status.json().state,'active');
console.log('PASS WordPress browser-session PKCE round trip, callback state and replay');
const dir=fs.realpathSync(root);const expire=`<?php $u=get_user_by('login','fixture-editor');$s=new Frameleaf_Connect_Store();$r=$s->read($u->ID);$d=$r['data'];$d['tokens']['expires_at']=time()-1;$s->change($r,'active',$d);`;
fs.writeFileSync(new URL('expire.php',root),expire);execFileSync('php',['-d','error_reporting=22527',dir+'/wp-cli.phar','--path='+dir+'/wordpress','eval-file',dir+'/expire.php'],{stdio:'pipe'});
const results=await Promise.all(Array.from({length:12},()=>client('/?rest_route=/frameleaf-fixture/v1/refresh',json({}))));assert.ok(results.every(r=>r.status===200),JSON.stringify(results.map(r=>({status:r.status,text:r.text}))));
const counts=(await client(providerOrigin+'/fixture-counts')).json();assert.equal(counts.rotations,1);assert.equal(counts.reused,0);console.log('PASS 12 concurrent native PHP requests: one rotation, zero reuse');



// Concurrent import requests may return a bounded in-progress conflict; all successful retries resolve one copy.
const assetId='00000000-0000-4000-8000-000000000001';
assert.equal((await client('/?rest_route=/frameleaf-connect/v1/import',json({id:assetId,copyAcknowledged:false}))).status,400);
const copies=await Promise.all(Array.from({length:12},()=>client('/?rest_route=/frameleaf-connect/v1/import',json({id:assetId,copyAcknowledged:true}))));
const ids=[];
for(const copy of copies){assert.ok([200,409].includes(copy.status),copy.text);const result=copy.status===409?await client('/?rest_route=/frameleaf-connect/v1/import',json({id:assetId,copyAcknowledged:true})):copy;assert.equal(result.status,200,result.text);ids.push(result.json().id);}
assert.equal(new Set(ids).size,1);console.log('PASS 12 concurrent native imports resolve one permanent attachment');

const mediaOutput=execFileSync('php',['-d','error_reporting=22527',dir+'/wp-cli.phar','--path='+dir+'/wordpress','eval-file',fileURLToPath(new URL('media.php',import.meta.url))],{encoding:'utf8'});
console.log(mediaOutput.trim());

// A different logged-in user cannot reuse another user's pending or established connection.
const stranger=agent();await stranger('/wp-login.php');
await stranger('/wp-login.php',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({log:'fixture-admin',pwd:pass,'wp-submit':'Log In',testcookie:'1'}).toString()});
assert.equal((await stranger(callback.href)).status,400);
const otherPage=await stranger('/wp-admin/upload.php?page=frameleaf-connect');
const otherNonce=otherPage.text.match(/createNonceMiddleware\(\s*"([a-f0-9]+)"/)?.[1];
const otherState=await stranger('/?rest_route=/frameleaf-connect/v1/connection',{headers:{'X-WP-Nonce':otherNonce}});
assert.equal(otherState.json().state,'disconnected');console.log('PASS independent WordPress users and callback ownership');
const anonymous=await agent()('/?rest_route=/frameleaf-connect/v1/albums');assert.equal(anonymous.status,401);
const missingNonce=await client('/?rest_route=/frameleaf-connect/v1/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(missingNonce.status,401);console.log('PASS anonymous and missing REST nonce denied');
// Force an uncertain refresh response after provider rotation. Never replay its spent token.
fs.writeFileSync(new URL('uncertain-refresh',root),'1');
execFileSync('php',['-d','error_reporting=22527',dir+'/wp-cli.phar','--path='+dir+'/wordpress','eval-file',dir+'/expire.php'],{stdio:'pipe'});
const uncertain=await client('/?rest_route=/frameleaf-fixture/v1/refresh',json({}));assert.equal(uncertain.status,400);
fs.unlinkSync(new URL('uncertain-refresh',root));
const quarantine=await client('/?rest_route=/frameleaf-connect/v1/connection',{headers:{'X-WP-Nonce':nonce}});assert.equal(quarantine.json().state,'quarantined');
for(let i=0;i<3;i++)assert.equal((await client('/?rest_route=/frameleaf-fixture/v1/refresh',json({}))).status,400);
const after=(await client(providerOrigin+'/fixture-counts')).json();assert.equal(after.rotations,2);assert.equal(after.reused,0);console.log('PASS uncertain rotated refresh quarantined without token reuse');
fs.writeFileSync(new URL('offline-revoke',root),'1');
assert.equal((await client('/?rest_route=/frameleaf-connect/v1/connection',{method:'DELETE',headers:{'X-WP-Nonce':nonce}})).status,400);
assert.equal((await client('/?rest_route=/frameleaf-connect/v1/connection',{headers:{'X-WP-Nonce':nonce}})).json().state,'revoking');
fs.unlinkSync(new URL('offline-revoke',root));
assert.equal((await client('/?rest_route=/frameleaf-connect/v1/connection',{method:'DELETE',headers:{'X-WP-Nonce':nonce}})).json().state,'disconnected');
console.log('PASS disconnect retains credentials until revocation retry succeeds');
