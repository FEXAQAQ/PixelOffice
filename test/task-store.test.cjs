const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {createTaskStore}=require('../src/server/task-store');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pixel-store-'));
  t.after(()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'pixel-store-')));fs.rmSync(root,{recursive:true,force:true});});
  return {root,store:createTaskStore(root)};
}
test('legacy task and event log migrate once, preserve history and remove without resurrection',t=>{
  const {root,store}=fixture(t);
  const log='{"kind":"raw","text":"old log"}\n';
  fs.writeFileSync(path.join(root,'ABC-1.json'),JSON.stringify({key:'ABC-1',summary:'舊單',description:'完整內文\n第二行',status:'done',sessionId:'session'}));
  fs.writeFileSync(path.join(root,'ABC-1.events.jsonl'),log);
  assert.equal(store.listTasks()[0].sessionId,'session');
  assert.equal(fs.readFileSync(store.eventsFile('ABC-1'),'utf8'),log);
  fs.appendFileSync(store.eventsFile('ABC-1'),'{}\n');
  store.readTask('ABC-1');
  assert.equal(fs.readFileSync(store.eventsFile('ABC-1'),'utf8'),log+'{}\n');
  assert.match(fs.readFileSync(store.markdownFile('ABC-1'),'utf8'),/完整內文\n第二行/);
  assert.ok(fs.existsSync(path.join(root,'ABC-1','legacy.task.json')));
  store.removeTask('ABC-1');
  assert.equal(store.readTask('ABC-1'),null);
  assert.deepEqual(store.listTasks(),[]);
});
test('status changes update JSON, Markdown and status history together',t=>{
  const {store}=fixture(t);
  store.saveTask({key:'ABC-2',summary:'需求',description:'描述',status:'backlog',sprint:{id:4,name:'Sprint 4'}});
  store.updateTask('ABC-2',{status:'in_progress',engineerName:'Engineer A'});
  assert.match(fs.readFileSync(store.markdownFile('ABC-2'),'utf8'),/開發中 \(in_progress\)/);
  assert.match(fs.readFileSync(store.markdownFile('ABC-2'),'utf8'),/Sprint 4/);
  store.updateTask('ABC-2',{status:'done'});
  store.updateTask('ABC-2',{status:'accepted'});
  store.updateTask('ABC-2',{archived:true});
  const task=store.readTask('ABC-2');
  assert.equal(task.statusLabel,'已封存');
  assert.deepEqual(task.statusHistory.map(h=>h.status),['backlog','in_progress','done','accepted','accepted']);
  assert.throws(()=>store.readTask('../outside'),/格式/);
  assert.throws(()=>store.saveTask({key:'ABC-3',status:'typo'}),/未知任務狀態/);
});
