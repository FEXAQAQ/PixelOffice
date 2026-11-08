const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('http'),path=require('path');
const {spawn}=require('child_process');
const {parseQuestions,normalizeAnswers}=require('../src/server/security/ask-user-question');
const {ApprovalGate}=require('../src/server/security/approval-gate');

const INPUT={questions:[
  {question:'要用哪種快取？',header:'快取',multiSelect:false,options:[{label:'Redis',description:'分散式'},{label:'MemoryCache',description:'單機'}]},
  {question:'要補哪些測試？',header:'測試',multiSelect:true,options:[{label:'單元'},{label:'整合'},{label:'E2E'}]},
]};

test('questions keep only the fields the UI needs and reject malformed input',()=>{
  const qs=parseQuestions({questions:[{...INPUT.questions[0],extra:'<script>'}]});
  assert.deepEqual(qs[0],{question:'要用哪種快取？',header:'快取',multiSelect:false,options:[{label:'Redis',description:'分散式'},{label:'MemoryCache',description:'單機'}]});
  for(const bad of [null,{},{questions:[]},{questions:[{question:'只有一個選項',options:[{label:'A'}]}]},{questions:[{options:[{label:'A'},{label:'B'}]}]}])
    assert.throws(()=>parseQuestions(bad));
});

test('answers follow the CLI format: keyed by question text, multi-select joined, free text wins for single select',()=>{
  const qs=parseQuestions(INPUT);
  assert.deepEqual(normalizeAnswers(qs,{'要用哪種快取？':{picked:['Redis']},'要補哪些測試？':{picked:['單元','E2E'],other:'壓測'}}),
    {'要用哪種快取？':'Redis','要補哪些測試？':'單元, E2E, 壓測'});
  assert.equal(normalizeAnswers(qs,{'要用哪種快取？':{picked:['Redis'],other:'都不要，用檔案快取'},'要補哪些測試？':{picked:['單元']}})['要用哪種快取？'],'都不要，用檔案快取');
});

test('every question needs an answer and unknown labels are dropped',()=>{
  const qs=parseQuestions(INPUT);
  assert.throws(()=>normalizeAnswers(qs,{'要用哪種快取？':{picked:['Redis']}}),/還沒有回答/);
  assert.throws(()=>normalizeAnswers(qs,{'要用哪種快取？':{picked:['偽造選項']},'要補哪些測試？':{picked:['單元']}}),/還沒有回答/);
});

test('only question requests can be answered with a payload; skipping or timeout resolves false',async()=>{
  const gate=new ApprovalGate(()=>{});
  const tool=gate.request({kind:'tool',command:'Bash'});
  assert.equal(gate.answer(gate.list()[0].id,{answers:{}}),false,'核准請求不能被答案物件當成允許');
  gate.decide(gate.list()[0].id,false);assert.equal(await tool,false);
  const q=gate.request({kind:'question',questions:[]});gate.answer(gate.list()[0].id,{answers:{a:'b'}});
  assert.deepEqual(await q,{answers:{a:'b'}});
  const skipped=gate.request({kind:'question'});gate.decide(gate.list()[0].id,false);assert.equal(await skipped,false);
  assert.equal(await new ApprovalGate(()=>{},10).request({kind:'question'},{timeout:5}),false);
});

test('hook hands updatedInput back to the CLI and stays silent on passthrough',async()=>{
  let reply;
  const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>res.end(JSON.stringify(reply)));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const run=()=>new Promise(resolve=>{
    const p=spawn(process.execPath,[path.join(__dirname,'../src/server/security/approval-hook.cjs')],{env:{...process.env,RPG_APPROVAL_PORT:String(server.address().port),RPG_APPROVAL_TOKEN:'t'}});
    let out='';p.stdout.on('data',d=>out+=d);p.stderr.resume();p.on('close',code=>resolve({code,out}));
    p.stdin.end(JSON.stringify({tool_name:'AskUserQuestion',tool_input:INPUT}));
  });
  try{
    reply={approved:true,updatedInput:{...INPUT,answers:{'要用哪種快取？':'Redis'}}};
    let r=await run();assert.equal(r.code,0);const out=JSON.parse(r.out).hookSpecificOutput;
    assert.equal(out.permissionDecision,'allow');assert.deepEqual(out.updatedInput.questions,INPUT.questions);assert.equal(out.updatedInput.answers['要用哪種快取？'],'Redis');
    reply={passthrough:true};r=await run();assert.equal(r.code,0);assert.equal(r.out,'');
    reply={approved:false,reason:'使用者沒有回答'};r=await run();assert.equal(r.code,2);
  }finally{await new Promise(r=>server.close(r));}
});
