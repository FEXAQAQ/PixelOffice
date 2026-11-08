const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {spawn}=require('child_process');
const {isolatedConfigEnv}=require('./helpers/isolated-config.cjs');
// 這個測試會另外 spawn 一個 server，而 npm test 是多檔平行執行的，所以輪詢不能用
// 「固定次數 × 固定間隔」當預算 —— 機器一忙就會假性失敗。改成以時間為準，並在逾時時
// 說明卡在哪一步，而不是讓後面的斷言收到 undefined、丟出看不懂的 TypeError。
const waitFor=async(label,fn,timeoutMs=15000)=>{
  const deadline=Date.now()+timeoutMs;
  for(;;){
    const value=await fn();
    if(value)return value;
    if(Date.now()>deadline)throw Error(`等待逾時（${timeoutMs}ms）：${label}`);
    await new Promise(r=>setTimeout(r,25));
  }
};
test('engineer limit, failed-task recovery, pending review preservation and Git denial',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rpg-workflow-test-'));
  const taskDir=path.join(dir,'tasks');fs.mkdirSync(taskDir);
  fs.writeFileSync(path.join(dir,'engineers.json'),JSON.stringify({engineers:[{id:'devA',name:'Dev A'}]}));
  fs.writeFileSync(path.join(dir,'projects.json'),JSON.stringify({projects:[]}));
  for(const [key,status] of [['TEST-1','failed'],['TEST-2','done'],['TEST-3','accepted'],['TEST-4','failed']])
    fs.writeFileSync(path.join(taskDir,key+'.json'),JSON.stringify({key,status,summary:key,cardId:key+'-card',projectPath:dir}));
  const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:'3198',JIRA_MODE:'mock',CLAUDE_MODE:'mock',TASK_DIR:taskDir,...isolatedConfigEnv(dir)},stdio:'ignore'});
  const base='http://127.0.0.1:3198';
  const send=(url,body,method='POST')=>fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    await waitFor('測試用 server 在 3198 埠回應 /api/health',async()=>{try{return (await fetch(base+'/api/health')).ok;}catch{return false;}});
    for(const [key,status] of [['JIRA-101','accepted'],['JIRA-102','done'],['JIRA-103','backlog']])fs.writeFileSync(path.join(taskDir,key+'.json'),JSON.stringify({key,status,summary:key}));
    const listing=await (await fetch(base+'/api/jira/tasks')).json();assert.deepEqual(listing.tasks.map(t=>t.key),['JIRA-104']);
    assert.equal(listing.sprint.name,'示範 Sprint（模擬資料）');
    const sprintClaim=await (await send('/api/tasks/claim',{tasks:listing.tasks})).json();
    assert.equal(sprintClaim.claimed[0].sprint.id,listing.sprint.id);
    assert.match(fs.readFileSync(path.join(taskDir,'JIRA-104','JIRA-104.md'),'utf8'),/示範 Sprint/);
    assert.equal((await send('/api/engineers',{engineers:Array.from({length:7},(_,i)=>({id:'e'+i,name:'D'+i}))},'PUT')).status,400);
    assert.equal((await send('/api/engineers',{engineers:Array.from({length:6},(_,i)=>({id:'e'+i,name:'D'+i}))},'PUT')).status,200);
    assert.equal((await send('/api/tasks/accept',{key:'TEST-4'})).status,400,'失敗任務不能驗收完成');
    const cleared=await (await send('/api/tasks/clear-finished',{keys:['TEST-1','TEST-2','TEST-3']})).json();
    assert.deepEqual(cleared.cleared,['TEST-1','TEST-3']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(taskDir,'TEST-1','task.json'))).status,'backlog');
    assert.equal(JSON.parse(fs.readFileSync(path.join(taskDir,'TEST-2','task.json'))).status,'done');
    const claimed=await (await send('/api/tasks/claim',{tasks:[{key:'TEST-4',summary:'Retry',description:'重跑失敗的任務'}]})).json();
    assert.equal(claimed.claimed?.[0]?.key,'TEST-4');
    const batch=await (await send('/api/tasks/claim',{tasks:[{key:'TEST-1'},{key:'TEST-2'},{key:'TEST-3'},{key:'TEST-5',summary:'New',description:'新單的需求描述'}]})).json();
    assert.deepEqual(batch.claimed.map(t=>t.key),['TEST-5']);assert.equal(batch.skipped.length,3);assert.equal(batch.skipped.find(t=>t.key==='TEST-2').reason,'待驗收');
    assert.equal((await send('/api/assign',{taskKey:'TEST-1',engineerId:'e0'})).status,400);
    const review=fetch(base+'/api/tasks/TEST-2/review');
    const pending=await waitFor('PreToolUse 把 git 指令送進核准佇列',async()=>{const list=await (await fetch(base+'/api/approvals')).json();return list.length?list:null;});
    assert.equal(pending[0].command,'"git" "rev-parse" "--is-inside-work-tree"');
    await send('/api/approvals/'+pending[0].id,{approved:false});assert.equal((await review).status,500);
    assert.equal((await send('/api/tool-approval',{token:'invalid',event:{tool_name:'Bash'}})).status,403);

    // 沒有需求描述的單不建檔：以前會照樣接取，一路帶著空描述到派工才被擋成
    // blocked，而 blocked 當時是死路（不能重接、不能放棄、不能退回）。
    const noDesc=await (await send('/api/tasks/claim',{tasks:[{key:'TEST-6',summary:'沒寫需求'},{key:'TEST-7',summary:'有寫需求',description:'內文'}]})).json();
    assert.deepEqual(noDesc.claimed.map(t=>t.key),['TEST-7'],'沒描述的單不該被接取，但同批其他單要照常接取');
    assert.equal(noDesc.skipped.find(t=>t.key==='TEST-6').reason,'Jira 上沒有需求描述');
    assert.equal(fs.existsSync(path.join(taskDir,'TEST-6')),false,'沒描述的單不該在 task/ 底下留下檔案');

    // blocked 不是死路：可以退回待指派重跑
    fs.mkdirSync(path.join(taskDir,'TEST-8'),{recursive:true});
    fs.writeFileSync(path.join(taskDir,'TEST-8','task.json'),JSON.stringify({key:'TEST-8',status:'blocked',summary:'卡住的單',description:'內文',blockedReason:'需求描述為空，請先補齊需求再開發'}));
    const unblocked=await (await send('/api/tasks/clear-finished',{keys:['TEST-8']})).json();
    assert.deepEqual(unblocked.cleared,['TEST-8'],'blocked 必須能退回待指派');
    const revived=JSON.parse(fs.readFileSync(path.join(taskDir,'TEST-8','task.json')));
    assert.equal(revived.status,'backlog');
    assert.equal(revived.blockedReason,null,'退回待指派時要清掉舊的受阻原因');
  }finally{
    child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
    assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'rpg-workflow-test-')));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

