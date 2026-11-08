const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {createTaskStore}=require('../src/server/task-store');
const {createAutomationHost}=require('../src/server/workflow/host');
function fixture(t,run){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pixel-host-'));t.after(()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'pixel-host-')));fs.rmSync(root,{recursive:true,force:true});});
  const store=createTaskStore(root),activeTasks=new Map(),state={status:'idle'},events=[];
  const deps={...store,activeTasks,stateOf:()=>state,pushEngineers(){},pushBoard(){},pushLocks(){},io:{emit:(name,data)=>events.push({name,data})},emitEvent(){},pmSay(){},killTree:p=>p?.kill(),runClaudeMock:run,runClaudeReal:run,lockedPaths:()=>({}),readEvents:()=>({events:[]}),eventSeq:new Map(),defaultWorkspace:root,mock:true,cancelApprovals(){}};
  return {...store,activeTasks,state,events,host:createAutomationHost(deps)};
}
test('host runs development, records the reported summary and releases the engineer',async t=>{
  const f=fixture(t,(task,id,cwd,done)=>setImmediate(()=>done(0)));
  f.saveTask({key:'TASK-1',summary:'test',description:'test',status:'backlog'});
  const result=f.host.start(f.readTask('TASK-1'),{id:'dev',name:'Dev',status:'idle'},null,{branchMode:'auto',branchName:'codex/TASK-1'});
  assert.equal(f.state.status,'working');await f.activeTasks.get(result.cardId).promise;
  assert.equal(f.readTask('TASK-1').status,'done');assert.equal(f.readTask('TASK-1').mock,true);assert.equal(f.readTask('TASK-1').resultSummary,'模擬開發完成');assert.match(f.readTask('TASK-1').resultReport,/模擬開發完成/);assert.equal(f.readTask('TASK-1').resultReportMock,true);assert.equal(f.activeTasks.size,0);assert.equal(f.state.status,'idle');
  assert.ok(f.events.some(e=>e.name==='task:workflow'&&e.data.phase==='developing'));
  assert.ok(!f.events.some(e=>e.name==='task:workflow'&&['validating','delivering'].includes(e.data.phase)),'不該再有驗證與交付階段');
});
test('host remembers the branch mode chosen at assignment so a later resume can reuse it',async t=>{
  const f=fixture(t,(task,id,cwd,done)=>setImmediate(()=>done(0)));
  f.saveTask({key:'TASK-4',summary:'test',description:'test',status:'backlog'});
  const {cardId}=f.host.start(f.readTask('TASK-4'),{id:'dev',name:'Dev',status:'idle'},null,{branchMode:'manual'});
  await f.activeTasks.get(cardId).promise;
  assert.equal(f.readTask('TASK-4').branchMode,'manual');assert.equal(f.readTask('TASK-4').branchName,null);
});
test('restart marks unfinished work interrupted and live workers cannot resume',t=>{
  const f=fixture(t,()=>{});
  f.saveTask({key:'TASK-2',summary:'test',status:'validating',workerPid:process.pid,projectPath:process.cwd(),automation:{enabled:true},branch:'codex/TASK-2'});
  f.host.recover();assert.equal(f.readTask('TASK-2').status,'interrupted');
  assert.throws(()=>f.host.start(f.readTask('TASK-2'),{id:'dev',status:'idle'},null,{resume:true}),/仍在執行/);
});
test('abort is persisted as interrupted and never records a completion summary',async t=>{
  let f;
  f=fixture(t,(task,id,cwd,done)=>{f.activeTasks.get(id).proc={mock:true,kill(){}};});
  f.saveTask({key:'TASK-3',summary:'test',status:'backlog'});
  const {cardId}=f.host.start(f.readTask('TASK-3'),{id:'dev',status:'idle'},null,{branchMode:'auto'});
  const entry=f.activeTasks.get(cardId);
  await new Promise(r=>setImmediate(r));entry.controller.abort();await entry.promise;
  assert.equal(f.readTask('TASK-3').status,'interrupted');assert.equal(f.readTask('TASK-3').resultSummary,null);assert.equal(f.activeTasks.size,0);
});
