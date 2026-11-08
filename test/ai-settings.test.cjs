const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {spawn}=require('child_process');
const {isolatedConfigEnv}=require('./helpers/isolated-config.cjs');
const {createSettings}=require('../src/server/ai-settings');

test('AI settings default to Claude, persist Codex and reject invalid values without overwriting',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pixeloffice-ai-settings-'));
  try {
    const file=path.join(dir,'ai.json'),settings=createSettings(file);
    assert.equal(settings.get(),'claude');settings.set('codex');
    assert.equal(createSettings(file).get(),'codex');
    assert.throws(()=>settings.set('unknown'));
    assert.equal(createSettings(file).get(),'codex');
    assert.equal(createSettings(path.join(dir,'env.json'),'codex').get(),'codex');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('platform API isolates models, pins new tasks and resumes legacy Claude tasks after switching',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pixeloffice-ai-api-'));
  const tasks=path.join(dir,'tasks');fs.mkdirSync(tasks);
  fs.writeFileSync(path.join(dir,'engineers.json'),JSON.stringify({engineers:[{id:'devA',name:'Dev A',model:'sonnet',codexModel:'codex-test'}]}));
  fs.writeFileSync(path.join(dir,'projects.json'),JSON.stringify({projects:[]}));
  fs.writeFileSync(path.join(tasks,'TEST-1.json'),JSON.stringify({key:'TEST-1',summary:'New task',status:'backlog'}));
  fs.writeFileSync(path.join(tasks,'OLD-1.json'),JSON.stringify({key:'OLD-1',summary:'Legacy',status:'done',engineerId:'devA',sessionId:'old-session',cardId:'old-card',projectPath:dir}));
  const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:'3197',HOST:'127.0.0.1',AI_PROVIDER:'claude',JIRA_MODE:'mock',CLAUDE_MODE:'mock',CODEX_MODE:'mock',CODEX_BIN:path.join(dir,'missing-codex'),WORKSPACE_DIR:dir,TASK_DIR:tasks,...isolatedConfigEnv(dir)},stdio:'ignore'});
  const base='http://127.0.0.1:3197';
  const get=async url=>(await fetch(base+url)).json();
  const send=(url,body,method='POST')=>fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
    assert.equal((await get('/api/ai')).provider,'claude');
    assert.equal((await send('/api/ai',{provider:'wrong'},'PUT')).status,400);
    assert.equal((await send('/api/ai',{provider:'codex'},'PUT')).status,200);
    assert.equal((await get('/api/health')).aiProvider,'codex');
    const models=await get('/api/models');assert.deepEqual(models.aliases,[]);assert.ok(models.error);
    const diag=await get('/api/diag');assert.equal(diag.ai.provider,'codex');assert.equal(diag.ai.found,false);
    assert.equal((await send('/api/chat',{message:'hello'})).status,400);
    const engineers=await get('/api/engineers');assert.equal(engineers.devA.model,'sonnet');assert.equal(engineers.devA.codexModel,'codex-test');
    assert.equal((await send('/api/assign',{taskKey:'TEST-1',engineerId:'devA',branchMode:'manual'})).status,200);
    await send('/api/ai',{provider:'claude'},'PUT');
    await new Promise(r=>setTimeout(r,1500));
    const task=JSON.parse(fs.readFileSync(path.join(tasks,'TEST-1','task.json')));
    assert.equal(task.provider,'codex');
    const events=(await get('/api/tasks/TEST-1/events')).events;
    assert.equal(events.find(e=>e.kind==='system' && e.subtype==='init').provider,'codex');
    await send('/api/tasks/abort',{cardId:task.cardId});
    // 自動化流程的中止存成 interrupted（中斷待恢復，可用送回饋 --resume 接續）。
    // 非自動化流程走 app.js 的 finishTask，存成 aborted —— 兩者是不同語意，不是不一致。
    // 共同要求：狀態誠實落地、cardId 留著，重整後還點得回中止那段對話。
    const stopped=await (async()=>{
      for(let i=0;i<40;i++){
        const t=JSON.parse(fs.readFileSync(path.join(tasks,'TEST-1','task.json')));
        if(t.status!=='in_progress')return t;
        await new Promise(r=>setTimeout(r,50));
      }
      throw Error('中止後任務狀態沒有落地');
    })();
    assert.equal(stopped.status,'interrupted');
    assert.equal(stopped.cardId,task.cardId,'中止後要留著 cardId 才點得回對話');
    await send('/api/ai',{provider:'codex'},'PUT');
    assert.equal((await send('/api/tasks/feedback',{key:'OLD-1',message:'Fix this'})).status,200);
    await new Promise(r=>setTimeout(r,1500));
    const oldEvents=(await get('/api/tasks/OLD-1/events')).events;
    const init=oldEvents.find(e=>e.kind==='system' && e.subtype==='init');
    assert.equal(init.provider,'claude');assert.equal(init.sessionId,'old-session');
    await send('/api/tasks/abort',{cardId:'old-card'});
    assert.equal(createSettings(path.join(dir,'ai.json')).get(),'codex');
  } finally {
    child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
