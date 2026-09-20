import test from 'node:test';
import assert from 'node:assert/strict';
import { exportConfiguration, importConfiguration, previewStoragePath } from '../src/configuration-transfer.mjs';
import { defaultSettings, allSettings } from '../src/settings-catalog.mjs';
import { parseCommandCenter } from '../src/settings-state.mjs';
test('settings transfer stages validated settings, excluding locked policy and credentials',()=>{
 const exported=exportConfiguration({...defaultSettings,serverName:'My archive',smtpPassword:'secret'});
 assert.equal(exported.values.serverName,'My archive');
 assert.equal('smtpPassword' in exported.values,false);
 for(const field of allSettings.filter(field=>field.locked))assert.equal(field.id in exported.values,false);
 const original={...defaultSettings};const imported=importConfiguration(JSON.stringify(exported),original);
 assert.equal(imported.serverName,'My archive');assert.equal(original.serverName,defaultSettings.serverName);
});
test('settings import rejects unknown fields, bad values and sign-in lockout atomically',()=>{
 const current={...defaultSettings};
 for(const values of [{unknown:true},{thumbnailConcurrency:0},{passwordLogin:false,oauthEnabled:false},{serverName:[]}])assert.throws(()=>importConfiguration({format:'frameleaf-settings',version:1,values},current));
 assert.deepEqual(current,defaultSettings);
 assert.throws(()=>importConfiguration({version:99,values:{}},current));
});
test('previous display labels migrate without losing saved or pending choices',()=>{
 const fields=allSettings.filter(field=>field.legacyValues);
 assert.ok(fields.length>0);
 for(const field of fields){
  for(const [label,canonical] of Object.entries(field.legacyValues)){
   const state=parseCommandCenter({version:1,settings:{[field.id]:label},draft:{[field.id]:label}},defaultSettings,allSettings,{});
   assert.equal(state.settings[field.id],canonical,field.id);
   assert.equal(state.draft[field.id],canonical,field.id);
  }
 }
});
test('storage path sample rejects traversal and reports unsupported tokens',()=>{
 assert.equal(previewStoragePath('{{y}}/{{MM}}/{{filename}}').path,'taylor/2026/09/Moraine Lake.jpg');
 assert.ok(previewStoragePath('../../{{filename}}').error);
 assert.ok(previewStoragePath('{{unknown}}').error);
});
