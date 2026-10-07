import test from 'node:test';
import assert from 'node:assert/strict';
import {createSetup, readiness, linkDemoPhone, advanceSetup, setupStatusResponse} from '../setup-status.mjs';

test('new imports are distinct from restored and fresh libraries', () => {
  assert.equal(createSetup().kind, 'new_import');
  assert.equal(createSetup('install').kind, 'new_library');
  assert.equal(createSetup('restore').kind, 'restored_library');
});
test('phone catalog sync runs before server rescan completes without early finish', () => {
  const setup = createSetup(); linkDemoPhone(setup);
  for (let i=0;i<12;i++) advanceSetup(setup);
  assert.equal(setup.mobile.progress, 90);
  assert.equal(setup.rescanComplete, false);
  assert.equal(readiness(setup).canFinish, false);
  for (let i=0;i<10;i++) advanceSetup(setup);
  assert.deepEqual(readiness(setup), {serverReady:true,phoneReady:true,canFinish:true});
});
test('server completion alone does not mark a newly linked phone ready', () => {
  const setup = createSetup();
  for(let i=0;i<20;i++) advanceSetup(setup);
  assert.equal(readiness(setup).serverReady,true);
  assert.equal(readiness(setup).canFinish,false);
  linkDemoPhone(setup); advanceSetup(setup);
  assert.equal(readiness(setup).canFinish,false);
});
test('stale revision, wrong library, unauthenticated or incomplete phone never permits finish', () => {
  const setup=createSetup();linkDemoPhone(setup);
  for(let i=0;i<25;i++)advanceSetup(setup);
  for(const patch of [{syncedRevision:'old'},{libraryId:'other-library'},{authenticated:false},{previewsReady:false},{catalogComplete:false}]) {
    const candidate=structuredClone(setup);Object.assign(candidate.mobile,patch);
    assert.equal(readiness(candidate).canFinish,false);
  }
  setup.verificationPassed=false;
  assert.equal(readiness(setup).canFinish,false);
});
test('pause and failure hold progress; resumption reaches the same ready state', () => {
  const setup=createSetup();linkDemoPhone(setup);advanceSetup(setup);
  setup.paused=true;advanceSetup(setup);assert.equal(setup.progress,5);
  setup.paused=false;setup.error='sample_error';advanceSetup(setup);assert.equal(setup.progress,5);
  setup.error=null;for(let i=0;i<25;i++)advanceSetup(setup);
  assert.equal(readiness(setup).canFinish,true);
});
test('unauthenticated setup status discloses no import or library details', () => {
  const setup=createSetup();
  assert.deepEqual(setupStatusResponse(setup), {setupRequired:true});
  assert.equal(setupStatusResponse(setup,{authenticated:true}).kind,'new_import');
  assert.equal(setupStatusResponse(setup,{authenticated:true}).libraryRevision,null);
});
