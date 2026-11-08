const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createTaskStore}=require('../src/server/task-store');
const {installTaskReset}=require('../src/server/features/task-reset');

const RUN={key:'T-1',summary:'Fix',description:'需求',type:'Task',priority:'High',sprint:null,source:'mcp',status:'failed',
  cardId:'T-1-e1-1',engineerId:'e1',engineerName:'Eng',projectId:'p1',projectPath:'',sessionId:'sess',costUsd:1.2,branch:'claude/T-1',baseCommit:'abc',resultSummary:'壞掉了',automation:{baseBranch:'develop'}};

function fixture(t,{task={},git={},active=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rpg-reset-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=createTaskStore(path.join(dir,'task'));const projectPath=path.join(dir,'repo');
  store.saveTask({...RUN,projectPath,...task});
  fs.writeFileSync(store.eventsFile('T-1'),'{"seq":1}\n');fs.writeFileSync(path.join(path.dirname(store.eventsFile('T-1')),'workflow-result.json'),'{}');
  const routes={},writes=[],emitted=[],locks=new Map(),eventSeq=new Map([['T-1-e1-1',5]]),cancelled=[];
  const head=git.head||'other';
  installTaskReset({post:(p,h)=>routes[p]=h},{...store,eventsFile:store.eventsFile,
    activeTasks:new Map(active?[['x',{info:{key:'T-1'}}]]:[]),lockedPaths:()=>Object.fromEntries(locks),actionLocks:locks,pushLocks:()=>{},
    readGit:async args=>args[0]==='show-ref'?{code:git.exists===false?1:0,out:''}:args[0]==='status'?{code:0,out:git.dirty||''}:{code:0,out:head},
    runGit:git.runGit||(async(args,cwd,id,options)=>{writes.push({args,options});return {code:0,out:''};}),
    baseBranchOf:t=>t.automation.baseBranch,eventSeq,cancelApprovals:id=>cancelled.push(id),pushBoard:()=>{},io:{emit:(...a)=>emitted.push(a)},pmSay:()=>{},now:()=>42});
  return {store,dir,writes,emitted,locks,eventSeq,cancelled,async reset(body={}){let status=200,result;await routes['/api/tasks/:key/reset']({params:{key:'T-1'},body},{status(v){status=v;return this;},json(v){result=v;return this;}});return {status,...result};}};
}

test('reset wipes run fields, keeps Jira fields and archives old logs instead of deleting them',async t=>{
  const f=fixture(t);const r=await f.reset();assert.equal(r.status,200);
  const saved=f.store.readTask('T-1');
  assert.equal(saved.status,'backlog');assert.equal(saved.description,'需求');assert.equal(saved.source,'mcp');assert.equal(saved.resetCount,1);
  for(const k of ['sessionId','cardId','branch','baseCommit','costUsd','engineerId','projectPath','resultSummary','automation'])assert.ok(!(k in saved),`${k} 應被清掉`);
  assert.deepEqual(saved.statusHistory.map(h=>h.status),['failed','backlog']);
  const files=fs.readdirSync(path.dirname(f.store.eventsFile('T-1')));
  assert.ok(!files.includes('log.jsonl') && files.includes('log.reset-42.jsonl'));assert.ok(files.includes('workflow-result.reset-42.json'));
  assert.equal(f.eventSeq.size,0);assert.deepEqual(f.cancelled,['T-1-e1-1']);assert.deepEqual(f.emitted[0],['task:requeued',{key:'T-1'}]);
  assert.equal(f.writes.length,0,'沒勾選就不該碰 Git');
});

test('running, backlog and accepted tasks cannot be reset',async t=>{
  assert.match((await fixture(t,{active:true}).reset()).error,/正在執行/);
  for(const status of ['backlog','accepted','in_progress']){const f=fixture(t,{task:{status}});const r=await f.reset();assert.equal(r.status,400,status);assert.equal(f.store.readTask('T-1').status,status);}
});

test('deleteBranch switches off the task branch when clean, then force-deletes it with approval details',async t=>{
  const f=fixture(t,{git:{head:'claude/T-1'}});const r=await f.reset({deleteBranch:true});assert.equal(r.status,200);
  assert.deepEqual(f.writes.map(w=>w.args),[['checkout','develop'],['branch','-D','claude/T-1']]);
  assert.match(f.writes[1].options.approvalDetails,/遠端分支不受影響/);assert.match(r.git,/已刪除/);assert.equal(f.locks.size,0);
});

test('dirty worktree on the task branch blocks the reset and leaves the task untouched',async t=>{
  const f=fixture(t,{git:{head:'claude/T-1',dirty:' M a.txt'}});const r=await f.reset({deleteBranch:true});
  assert.equal(r.status,400);assert.match(r.error,/未提交的修改/);assert.equal(f.writes.length,0);
  assert.equal(f.store.readTask('T-1').sessionId,'sess');assert.ok(fs.existsSync(f.store.eventsFile('T-1')));assert.equal(f.locks.size,0);
});

test('denied Git approval keeps the task as it was',async t=>{
  const f=fixture(t,{git:{runGit:async()=>{throw Error('Git 操作未核准，已停止。');}}});const r=await f.reset({deleteBranch:true});
  assert.match(r.error,/未核准/);assert.equal(f.store.readTask('T-1').status,'failed');assert.equal(f.locks.size,0);
});

test('missing branch, mock task and protected branch names are handled without deleting anything',async t=>{
  const gone=fixture(t,{git:{exists:false}});const r=await gone.reset({deleteBranch:true});assert.equal(r.status,200);assert.match(r.git,/已不存在/);assert.equal(gone.writes.length,0);
  const mock=fixture(t,{task:{mock:true}});assert.match((await mock.reset({deleteBranch:true})).git,/模擬/);assert.equal(mock.writes.length,0);
  const base=fixture(t,{task:{branch:'develop'}});assert.match((await base.reset({deleteBranch:true})).error,/不允許刪除/);assert.equal(base.writes.length,0);
});

test('busy project refuses to delete the branch',async t=>{
  const f=fixture(t);f.locks.set(path.resolve(f.store.readTask('T-1').projectPath),{taskKey:'other'});
  assert.match((await f.reset({deleteBranch:true})).error,/正在執行任務或其他操作/);assert.equal(f.writes.length,0);assert.equal(f.locks.size,1);
});
