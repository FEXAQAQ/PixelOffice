const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {spawn}=require('child_process');
const {isolatedConfigEnv}=require('./helpers/isolated-config.cjs');
const waitFor=async(label,fn,timeoutMs=20000)=>{
  const deadline=Date.now()+timeoutMs;
  for(;;){const value=await fn();if(value)return value;if(Date.now()>deadline)throw Error(`等待逾時（${timeoutMs}ms）：${label}`);await new Promise(r=>setTimeout(r,50));}
};
// mock 劇本要能完整預覽 AskUserQuestion：停在提問、等人回答、依答案繼續，最後正常完成。
test('mock run pauses on AskUserQuestion, resumes with the chosen answer, and skipping still finishes',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rpg-mock-ask-'));
  const taskDir=path.join(dir,'tasks');fs.mkdirSync(taskDir);
  fs.writeFileSync(path.join(dir,'engineers.json'),JSON.stringify({engineers:[{id:'devA',name:'Dev A'}]}));
  fs.writeFileSync(path.join(dir,'projects.json'),JSON.stringify({projects:[]}));
  const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:'3196',JIRA_MODE:'mock',CLAUDE_MODE:'mock',TASK_DIR:taskDir,...isolatedConfigEnv(dir)},stdio:'ignore'});
  const base='http://127.0.0.1:3196';
  const send=(url,body)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const task=key=>JSON.parse(fs.readFileSync(path.join(taskDir,key,'task.json'),'utf8'));
  const events=key=>fs.readFileSync(path.join(taskDir,key,'log.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
  const run=async(key,reply)=>{
    await send('/api/tasks/claim',{tasks:[{key,summary:'窄螢幕按鈕',description:'登入按鈕在手機上溢出'}]});
    assert.equal((await send('/api/assign',{taskKey:key,engineerId:'devA',branchMode:'manual'})).status,200);
    const [q]=await waitFor('mock 劇本送出提問',async()=>{const l=await (await fetch(base+'/api/approvals')).json();return l.length?l:null;});
    assert.equal(q.kind,'question');assert.equal(q.taskKey,key);assert.equal(q.questions[0].options.length,2);
    assert.ok(!events(key).some(e=>e.kind==='result'),'回答前劇本不該往下跑');
    await reply(q);
    await waitFor('任務跑完',()=>task(key).status==='done');
    return events(key);
  };
  try{
    await waitFor('測試用 server 回應',async()=>{try{return (await fetch(base+'/api/health')).ok;}catch{return false;}});
    const answered=await run('TEST-1',async q=>{
      assert.equal((await send('/api/approvals/'+q.id,{answers:{}})).status,400,'沒作答不能送出');
      assert.equal((await send('/api/approvals/'+q.id,{answers:{[q.questions[0].question]:{picked:['自動換行']}}})).status,200);
    });
    assert.ok(answered.some(e=>e.kind==='tool_use' && e.name==='AskUserQuestion'));
    assert.ok(answered.some(e=>e.kind==='tool_result' && /自動換行/.test(e.text)));
    assert.ok(answered.some(e=>e.kind==='tool_use' && e.name==='Edit' && /flex-wrap/.test(e.text)),'後續編輯要照選的答案');
    // 略過也要能把劇本跑完，而不是卡住
    const skipped=await run('TEST-2',q=>send('/api/approvals/'+q.id,{approved:false}));
    assert.ok(skipped.some(e=>e.kind==='text' && /沒有收到回答/.test(e.text)));
  }finally{child.kill();}
});
