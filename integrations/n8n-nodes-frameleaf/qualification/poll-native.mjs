import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire('/usr/local/lib/node_modules/n8n/package.json');
const {Container}=require('@n8n/di');
const {SchedulerConfig,WorkflowsConfig}=require('@n8n/config');
const {PollCursorService}=require('/usr/local/lib/node_modules/n8n/dist/workflows/triggers/poll-cursor.service.js');
const {TriggerExecutionContextFactory}=require('/usr/local/lib/node_modules/n8n/dist/workflows/triggers/trigger-execution-context.factory.js');
const {PollTriggerExecutor}=require(require.resolve('n8n-core').replace('index.js','execution-engine/poll-trigger-executor.js'));
const {FrameleafTrigger}=require('/qualification/dist/nodes/FrameleafTrigger/FrameleafTrigger.node.js');
const logger={debug(){},warn(){},error(){},scoped(){return this;}};
let durable={},saves=0,initializations=0,executions=0,failedHandoffs=0;
let phase='empty';
const scheduler=Container.get(SchedulerConfig),workflows=Container.get(WorkflowsConfig);
const cursorService=new PollCursorService(logger,{findCursor:async()=>null,advanceCursor:async()=>{throw Error('Unexpected durable cursor commit under native defaults');}}, {}, {},scheduler,workflows,{emit(){}});
const node={id:'synthetic-poll-node',name:'Frameleaf Trigger',type:'n8n-nodes-frameleaf.frameleafTrigger',typeVersion:1,position:[0,0],parameters:{},credentials:{frameleafOAuth2Api:{id:'synthetic',name:'Synthetic'}}};
const credential={libraryUrl:'https://library.example',permissionProfile:'library:read events:read',oauthTokenData:{scope:'library:read events:read',resource:'https://library.example/api/connect'}};
function tickAfterRestart(){
 const staticData=structuredClone(durable);
 const workflow={id:'synthetic-workflow',name:'Synthetic',getStaticData:()=>staticData,expression:{acquireIsolate:async()=>{},releaseIsolate:async()=>{}}};
 const factory=Object.create(TriggerExecutionContextFactory.prototype);
 Object.assign(factory,{logger,pollCursorService:cursorService,workflowStaticDataService:{saveStaticData:async()=>{saves++;durable=structuredClone(staticData);}},engineV2ActiveTriggers:{handles:()=>false},attributeToPublisher:async()=>({}),workflowExecutionService:{runWorkflow:async()=>{if(phase==='handoff-fails')throw Error('Synthetic unavailable execution creation');executions++;return{};}},recordTriggerFailure:()=>{},logTriggerExecutionFailure:()=>{failedHandoffs++;}});
 const context=factory.getExecutePollFunctions({id:workflow.id},{},'trigger','update',async()=>({id:workflow.id}))(workflow,node);
 context.getCredentials=async()=>credential;
 context.getNodeParameter=(name,fallback)=>({event:'asset.ready',albumId:'',checkpoint:'initial'}[name]??fallback);
 context.helpers.httpRequestWithAuthentication=async(_type,options)=>{
  if(options.qs.start==='now'){initializations++;return {items:[],nextCursor:'c0',hasMore:false};}
  if(phase==='later-page-fails'){if(options.qs.cursor==='c0')return {items:[{deliveryId:'page-one'}],nextCursor:'c-half',hasMore:true};throw Error('Synthetic page two unavailable');}
  if(phase==='handoff-fails')return {items:[{deliveryId:'synthetic-event'}],nextCursor:'c1',hasMore:false};
  throw Error('Unexpected fixture request');
 };
 const tracer={pickWorkflowAttributes:()=>({}),pickNodeAttributes:()=>({}),startSpan:async(_opts,fn)=>fn({setStatus(){}}),startNewTraceSpan:async(_opts,fn)=>fn({setStatus(){}})};
 const executor=new PollTriggerExecutor(logger,{runPollFunction:async(_w,_n,pf)=>new FrameleafTrigger().poll.call(pf)},tracer,{error(){}});
 return executor.create(workflow,node,context,()=>true);
}
await tickAfterRestart()();
const empty={nativeSchedulerPolls:scheduler.enabledForPollTriggers,nativeDurableCursors:scheduler.durableCursorsEnabled,saves,durableCursor:durable.cursor??null};
await tickAfterRestart()();
const restarted={initializations,saves,durableCursor:durable.cursor??null};
durable={cursor:'c0',checkpoint:'initial',filters:JSON.stringify({type:'asset.ready'})};phase='later-page-fails';
await tickAfterRestart()();
const laterPageFailure={durableCursor:durable.cursor,saves};
phase='handoff-fails';
await tickAfterRestart()();await new Promise(resolve=>setImmediate(resolve));
console.log(JSON.stringify({emptyPoll:empty,restart:restarted,laterPageFailure,failedExecutionCreation:{durableCursor:durable.cursor,saves,executions,failedHandoffs}}));
assert.equal(empty.durableCursor,'c0','A successful empty poll must persist its initial cursor before a restart.');
