import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
const root = pathToFileURL(process.env.FRAMELEAF_FIXTURE_DIR.replace(/\/$/, '') + '/');
const tls = {key:fs.readFileSync(new URL('certs/server.key', root)),cert:fs.readFileSync(new URL('certs/server.pem',root))};
const providerPort=Number(process.env.FRAMELEAF_FIXTURE_PROVIDER_PORT||39444);
const webPort=Number(process.env.FRAMELEAF_FIXTURE_WEB_PORT||39443);
const phpPort=Number(process.env.FRAMELEAF_FIXTURE_PHP_PORT||39080);
const issuer=`https://localhost:${providerPort}`;
const callback=`https://localhost:${webPort}/wp-admin/admin-post.php?action=frameleaf_connect_callback`;
const codes=new Map(); const refresh=new Map(); const access=new Set(); let issued=0, rotations=0, reused=0, revoked=0;
const random=()=>randomBytes(32).toString('base64url');
const send=(res,n,body)=>{res.writeHead(n,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
https.createServer(tls,async(req,res)=>{
  const url=new URL(req.url,issuer); let text='';for await(const chunk of req){text+=chunk;if(text.length>30000){send(res,413,{});return;}}
  const form=new URLSearchParams(text);
  if(url.pathname==='/.well-known/oauth-authorization-server') return send(res,200,{issuer,authorization_endpoint:issuer+'/api/oauth/apps/authorize',token_endpoint:issuer+'/api/oauth/apps/token',revocation_endpoint:issuer+'/api/oauth/apps/revoke',registration_endpoint:issuer+'/api/oauth/apps/register',code_challenge_methods_supported:['S256']});
  if(url.pathname==='/api/oauth/apps/register') { const body=JSON.parse(text);if(body.redirect_uris?.[0]!==callback) return send(res,400,{});return send(res,201,{client_id:'synthetic-wordpress-client'}); }
  if(url.pathname==='/api/oauth/apps/authorize') {
    const p=url.searchParams;
    if(p.get('resource')!==issuer+'/api/connect'||p.get('scope')!=='library:read'||p.get('code_challenge_method')!=='S256'||p.get('redirect_uri')!==callback)return send(res,400,{});
    const code=random();codes.set(code,{challenge:p.get('code_challenge'),redirect:p.get('redirect_uri'),client:p.get('client_id')});
    const redirect=new URL(p.get('redirect_uri'));redirect.searchParams.set('state',p.get('state'));redirect.searchParams.set('code',code);res.writeHead(302,{Location:redirect.href});res.end();return;
  }
  if(url.pathname==='/api/oauth/apps/token') {
    if(form.get('resource')!==issuer+'/api/connect')return send(res,400,{});
    if(form.get('grant_type')==='authorization_code') {const entry=codes.get(form.get('code'));codes.delete(form.get('code'));if(!entry||createHash('sha256').update(form.get('code_verifier')||'').digest('base64url')!==entry.challenge||entry.redirect!==form.get('redirect_uri')||entry.client!==form.get('client_id'))return send(res,400,{});issued++;}
    else {const old=form.get('refresh_token');if(refresh.get(old)!=='valid'){reused++;return send(res,400,{error:'invalid_grant'});}refresh.set(old,'spent');rotations++;await new Promise(r=>setTimeout(r,250));if(fs.existsSync(new URL('uncertain-refresh',root)))return send(res,500,{});}
    const at=random(),rt=random();access.add(at);refresh.set(rt,'valid');return send(res,200,{access_token:at,refresh_token:rt,expires_in:3600,token_type:'Bearer',scope:'library:read'});
  }
  if(url.pathname==='/api/oauth/apps/revoke') {if(fs.existsSync(new URL('offline-revoke',root)))return send(res,503,{});refresh.set(form.get('token'),'revoked');revoked++;return send(res,200,{});}
  if(url.pathname==='/api/connect/capabilities') {if(!access.has(req.headers.authorization?.slice(7)))return send(res,401,{});return send(res,200,{protocolVersion:1,server:{id:'synthetic-library'},scopes:['library:read']});}
  if(url.pathname.startsWith('/api/connect/assets')) {
    if(!access.has(req.headers.authorization?.slice(7)))return send(res,401,{});
    const id='00000000-0000-4000-8000-000000000001';
    if(url.pathname.endsWith('/rendition')){const version=fs.existsSync(new URL('version2',root))?'2':'1';const bytes=fs.readFileSync(new URL('image'+version+'.png',root));res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store','Content-Length':bytes.length});res.end(bytes);return;}
    const asset={id,type:'IMAGE',title:'Synthetic shapes',description:'Synthetic fixture only',width:120,height:80,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};
    return send(res,200,url.pathname==='/api/connect/assets'?{items:[asset],total:1,page:1,size:40}:asset);
  }
  if(url.pathname==='/api/connect/albums')return send(res,200,{items:[{id:'00000000-0000-4000-8000-000000000002',name:'Synthetic album',workspace:'photo',canRead:true,canWrite:false}]});
  if(url.pathname==='/fixture-counts')return send(res,200,{issued,rotations,reused,revoked});
  send(res,404,{});
}).listen(providerPort,'127.0.0.1');
https.createServer(tls,(req,res)=>{
 const proxy=http.request({hostname:'127.0.0.1',port:phpPort,path:req.url,method:req.method,headers:{...req.headers,'x-frameleaf-fixture-tls':'1'}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});proxy.on('error',()=>{res.writeHead(502);res.end();});req.pipe(proxy);
}).listen(webPort,'127.0.0.1');
console.log('Task-only TLS WordPress proxy and OAuth provider ready');
