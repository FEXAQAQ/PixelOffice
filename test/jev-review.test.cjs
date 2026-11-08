const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {buildQuestions,scoreAnswers,mockReview,readEvidence,evaluate,testConnection,installJevReview}=require('../src/server/features/jev-review');

test('Mock review displays a labelled fixed score without an API key or Git read',async()=>{
  const sample=mockReview();
  assert.equal(sample.total,80);assert.equal(sample.qualified,true);assert.equal(sample.mock,true);
  assert.equal(sample.items.length,5);
  assert.deepEqual(sample.items.map(i=>i.verdict),['通過','通過','通過','未通過','通過']);
  const routes={};const app={post:(url,handler)=>routes[url]=handler,get:(url,handler)=>routes[url]=handler};
  installJevReview(app,{readTask:()=>({key:'ABC-1',status:'done',mock:true}),markdownFile:()=>{throw Error('should not read');},readGit:()=>{throw Error('should not read');},apiKey:'',isMock:()=>true});
  let output;await routes['/api/tasks/:key/jev-review']({params:{key:'ABC-1'}},{json:value=>{output=value;}});
  assert.equal(output.total,80);assert.equal(output.mock,true);
  await routes['/api/jev/test']({}, {json:value=>{output=value;}});
  assert.equal(output.mock,true);
});

test('configured key performs a live Jev connection test even in Mock mode',async()=>{
  const routes={};const app={post:(url,handler)=>routes[url]=handler,get:(url,handler)=>routes[url]=handler};
  let called=false;
  installJevReview(app,{readTask:()=>null,markdownFile:()=>'',readGit:()=>{},apiKey:'test-key',isMock:()=>true,fetchImpl:async()=>{called=true;return {ok:true,json:async()=>({model:'jev-test',answers:{connection:{type:'noul',noul:1}}})};}});
  let output;await routes['/api/jev/test']({}, {json:value=>{output=value;}});
  assert.equal(called,true);assert.equal(output.ok,true);assert.equal(output.mock,undefined);
});

test('Jev connection test sends a small Noul request and validates its response',async()=>{
  let payload;
  const fetchImpl=async(_url,options)=>{payload=JSON.parse(options.body);return {ok:true,json:async()=>({model:'jev-1.13.0',answers:{connection:{type:'noul',noul:.99}}})};};
  const result=await testConnection({apiKey:'test-key',fetchImpl});
  assert.equal(result.ok,true);assert.equal(payload.questions.connection.type,'noul');
  assert.equal(payload.state,'PixelOffice Jev 連線測試');
  await assert.rejects(testConnection({apiKey:'',fetchImpl}),/TYPESAFE_API_KEY/);
});

test('Jev asks five yes/no questions worth 20 points each',async()=>{
  const questions=buildQuestions();
  assert.deepEqual(Object.keys(questions),['correctness','security','reliability','testQuality','maintainability']);
  assert.ok(Object.values(questions).every(q=>q.type==='noul'&&q.criteria.true&&q.criteria.false));
  let request;
  const fetchImpl=async(url,options)=>{request={url,...options};return {ok:true,json:async()=>({model:'jev-1.13.0',answers:Object.fromEntries(Object.keys(questions).map((key,i)=>[key,{type:'noul',noul:i===0?.49:.8}]))})};};
  const result=await evaluate({state:{jiraTask:'需求',gitDiff:'改動'},apiKey:'test-key',fetchImpl});
  assert.equal(request.url,'https://api.typesafe.ai/v1/systemone');
  assert.equal(JSON.parse(request.body).model,'jev-latest');
  assert.equal(result.total,80);assert.equal(result.qualified,true);
  assert.deepEqual(result.items.map(i=>i.verdict),['未通過','通過','通過','通過','通過']);
  const threshold=scoreAnswers(Object.fromEntries(Object.keys(questions).map((key,i)=>[key,{type:'noul',noul:i===0?.49:.5}])));
  assert.equal(threshold.total,80);assert.equal(threshold.qualified,true);
  const below=scoreAnswers(Object.fromEntries(Object.keys(questions).map((key,i)=>[key,{type:'noul',noul:i<2?.49:.5}])));
  assert.equal(below.total,60);assert.equal(below.qualified,false);
  assert.throws(()=>scoreAnswers({}),/缺少有效/);
});

test('review reads local task and changed files, and refuses another branch',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pixel-jev-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const taskFile=path.join(root,'task.md');fs.writeFileSync(taskFile,'Jira 需求');
  fs.writeFileSync(path.join(root,'new.js'),'module.exports = true;');
  const commands=[];
  const readGit=async args=>{commands.push(args);if(args[0]==='rev-parse')return {code:0,out:'task-branch\n'};if(args[0]==='diff')return {code:0,out:'diff --git a/a.js b/a.js\n+new code\n'};return {code:0,out:'new.js\0'};};
  const input={task:{key:'ABC-1',branch:'task-branch',baseCommit:'a'.repeat(40)},cwd:root,markdownFile:()=>taskFile,readGit};
  const {state}=await readEvidence(input);
  assert.match(state.jiraTask,/Jira/);assert.match(state.untrackedFiles,/module.exports/);
  assert.equal(commands[1].at(-1),'a'.repeat(40));
  await assert.rejects(readEvidence({...input,task:{...input.task,branch:'other'}}),/分支/);
});

test('disabled Jev module refuses review and connection test but still reports diag',async()=>{
  const routes={};const app={post:(url,handler)=>routes[url]=handler,get:(url,handler)=>routes[url]=handler};
  let enabled=false,fetched=false;
  installJevReview(app,{readTask:()=>({key:'ABC-1',status:'done',mock:true}),markdownFile:()=>'',readGit:()=>{},apiKey:'test-key',isMock:()=>true,isEnabled:()=>enabled,
    fetchImpl:async()=>{fetched=true;return {ok:true,json:async()=>({model:'jev-test',answers:{connection:{type:'noul',noul:1}}})};}});
  const call=async(url,req={})=>{const out={};await routes[url](req,{status(code){out.code=code;return this;},json(value){out.body=value;}});return out;};
  for(const url of ['/api/jev/test','/api/tasks/:key/jev-review']){
    const out=await call(url,{params:{key:'ABC-1'}});
    assert.equal(out.code,403);assert.equal(out.body.disabled,true);
  }
  assert.equal(fetched,false);
  assert.equal((await call('/api/jev/diag')).body.enabled,false);
  enabled=true;
  assert.equal((await call('/api/jev/diag')).body.enabled,true);
  assert.equal((await call('/api/tasks/:key/jev-review',{params:{key:'ABC-1'}})).body.mock,true);
});
