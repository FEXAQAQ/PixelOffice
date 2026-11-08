const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
const {runTaskWorkflow}=require('../src/server/workflow/runner');
const {normalizeAutomation}=require('../src/server/workflow/config');
const {execute}=require('../src/server/workflow/process');
function repo(t,prefix){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),prefix));t.after(()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),prefix)));fs.rmSync(root,{recursive:true,force:true});});
  const cwd=path.join(root,'repo'),directory=path.join(root,'TASK');fs.mkdirSync(cwd);fs.mkdirSync(directory);
  const git=args=>{const r=spawnSync('git',args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;};
  git(['init','-b','main']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);
  fs.writeFileSync(path.join(cwd,'value.cjs'),'module.exports=0;');git(['add','.']);git(['commit','-m','fixture']);
  git(['branch','develop']);
  const remote=path.join(root,'remote.git');git(['init','--bare',remote]);git(['remote','add','origin',remote]);git(['push','origin','develop']);
  return {cwd,directory,git};
}
test('prepares an isolated branch, develops once and leaves every commit to the user',async t=>{
  const {cwd,directory,git}=repo(t,'pixel-runner-');
  let developments=0;const stages=[],commands=[];
  const result=await runTaskWorkflow(
    {key:'TASK-1',summary:'Implement value',description:'value must be 2'},
    {cwd,directory,branchMode:'auto',branchName:'codex/TASK-1',config:normalizeAutomation({commands:'node verify.cjs'})},
    {checkCancelled(){},stage:async s=>stages.push(s),update:async()=>{},
     develop:async()=>{developments++;fs.writeFileSync(path.join(cwd,'value.cjs'),'module.exports=2;');fs.writeFileSync(path.join(cwd,'added.cjs'),'module.exports=true;');return {code:0,complete:true,summary:'value implemented'};},
     exec:async(file,args)=>{commands.push([file,...args]);return execute(file,args,{cwd,kill:p=>p.kill()});}});
  assert.equal(result.status,'done');assert.equal(result.summary,'value implemented');
  assert.equal(developments,1,'沒有系統驗證就沒有自動修復迴圈');
  assert.deepEqual(stages,['preparing','developing'],'不再有 validating／delivering 階段');
  // 交付是人工的：這支除了開任務分支以外，不該對 repository 做任何寫入。
  for(const forbidden of ['commit','push','add'])assert.ok(!commands.some(c=>c[0]==='git'&&c[1]===forbidden),`不該自行執行 git ${forbidden}`);
  assert.ok(!commands.some(c=>c[0]==='gh'),'不該自行建立 PR');
  assert.deepEqual(commands.filter(c=>c[0]==='git').slice(2,5),[
    ['git','checkout','develop'],['git','pull','--ff-only','origin','develop'],['git','rev-parse','HEAD']
  ],'自動分支必須先更新 develop，再記錄基準版本');
  assert.equal(git(['rev-parse','--abbrev-ref','HEAD']).trim(),'codex/TASK-1');
  assert.match(git(['status','--short']),/value\.cjs/,'已追蹤的修改留在工作目錄等人檢查');
  assert.match(git(['status','--short']),/\?\? added\.cjs/,'新檔案也留著，不會被自動加入 Git');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'workflow-result.json'))).status,'done');
  assert.equal(fs.existsSync(path.join(directory,'validation.json')),false,'不再產生系統驗證紀錄');
  assert.equal(fs.existsSync(path.join(directory,'delivery.md')),false,'不再產生自動交付報告');
});
test('refuses a dirty worktree and refuses to develop on the base branch',async t=>{
  const {cwd,directory}=repo(t,'pixel-guard-');
  const config=normalizeAutomation({commands:'node verify.cjs',baseBranch:'main'});
  const deps={checkCancelled(){},stage:async()=>{},update:async()=>{},
    develop:async()=>assert.fail('準備階段就該擋下，不該進入開發'),
    exec:(file,args)=>execute(file,args,{cwd,kill:p=>p.kill()})};
  const task={key:'TASK-2',summary:'x',description:'內文'};
  await assert.rejects(runTaskWorkflow(task,{cwd,directory,branchMode:'manual',config},deps),/獨立任務分支/);
  fs.writeFileSync(path.join(cwd,'value.cjs'),'module.exports=9;');
  await assert.rejects(runTaskWorkflow(task,{cwd,directory,branchMode:'auto',branchName:'codex/TASK-2',config},deps),/乾淨的工作目錄/);
});
test('manual mode accepts existing changes on a branch the user already prepared',async t=>{
  const {cwd,directory,git}=repo(t,'pixel-manual-');
  git(['checkout','-b','feature/TASK-3']);
  fs.writeFileSync(path.join(cwd,'mcp.json'),'{}');
  let developed=false;
  const result=await runTaskWorkflow({key:'TASK-3',summary:'x',description:'內文'},
    {cwd,directory,branchMode:'manual',config:normalizeAutomation({commands:'node verify.cjs'})},
    {checkCancelled(){},stage:async()=>{},update:async()=>{},
     develop:async()=>{developed=true;return {code:0,complete:true,summary:'ok'};},
     exec:(file,args)=>execute(file,args,{cwd,kill:p=>p.kill()})});
  assert.ok(developed,'手動模式不因既有的未追蹤檔案而擋下');
  assert.equal(result.status,'done');
  assert.equal(git(['rev-parse','--abbrev-ref','HEAD']).trim(),'feature/TASK-3','手動模式不切換分支');
});
test('process timeout and abort stop engineer subprocesses',async()=>{
  const timeout=await execute(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),timeoutMs:50,kill:p=>p.kill()});
  assert.equal(timeout.code,124);
  const controller=new AbortController();
  const pending=execute(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),signal:controller.signal,kill:p=>p.kill(),onProcess:p=>{if(p)setTimeout(()=>controller.abort(),30);}});
  await assert.rejects(pending,/中止/);
});
