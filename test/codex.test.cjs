const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('events');
const {PassThrough,Writable}=require('stream');
const {runCodex,listModels}=require('../src/server/integrations/codex');

function fakeServer(handle) {
  const proc=new EventEmitter();proc.stdout=new PassThrough();proc.stderr=new PassThrough();
  const sent=[];
  const notify=(method,params)=>proc.stdout.write(JSON.stringify({method,params})+'\n');
  const reply=(id,result)=>proc.stdout.write(JSON.stringify({id,result})+'\n');
  proc.stdin=new Writable({write(buffer,encoding,callback){
    const msg=JSON.parse(buffer.toString());sent.push(msg);
    setImmediate(()=>handle(msg,{notify,reply,proc}));callback();
  }});
  proc.kill=()=>{proc.stdout.end();setImmediate(()=>proc.emit('close',null));};
  return {proc,sent,spawnProcess:(bin,args,options)=>{
    assert.deepEqual(args,['app-server']);assert.equal(options.windowsHide,true);return proc;
  }};
}

test('Codex uses stdin RPC, resumes the correct thread, maps output and waits for approval',async()=>{
  let approve,requested=false;const events=[];
  const fake=fakeServer((msg,{reply,notify,proc})=>{
    if(msg.method==='initialize')reply(msg.id,{});
    if(msg.method==='thread/resume')reply(msg.id,{thread:{id:'codex-thread'},model:'test-model'});
    if(msg.method==='turn/start'){
      reply(msg.id,{turn:{id:'turn'}});
      notify('item/started',{item:{id:'edit',type:'fileChange',changes:[{path:'a.txt',diff:'+hello'}]}});
      proc.stdout.write(JSON.stringify({id:77,method:'item/fileChange/requestApproval',params:{itemId:'edit',threadId:'codex-thread',turnId:'turn'}})+'\n');
    }
    if(msg.id===77 && msg.result){
      assert.equal(msg.result.decision,'accept');
      notify('item/completed',{item:{id:'edit',type:'fileChange',status:'completed',changes:[]}});
      notify('item/completed',{item:{id:'answer',type:'agentMessage',text:'PIXELOFFICE_DONE: fixed'}});
      notify('turn/completed',{turn:{id:'turn',status:'completed'}});
    }
  });
  const completion=new Promise(resolve=>runCodex({bin:'codex',cwd:process.cwd(),spawnProcess:fake.spawnProcess,
    prompt:'特殊字元 & "quoted"\n下一行',resumeFrom:'codex-thread',permissionMode:'ask',emit:e=>events.push(e),done:resolve,
    approve:async(method,params,item)=>{requested=true;assert.equal(item.changes[0].path,'a.txt');return new Promise(r=>{approve=r;});}}));
  while(!requested)await new Promise(r=>setTimeout(r,5));
  assert.equal(fake.sent.some(m=>m.id===77),false);
  approve(true);assert.equal(await completion,0);
  const turn=fake.sent.find(m=>m.method==='turn/start');
  assert.equal(turn.params.input[0].text,'特殊字元 & "quoted"\n下一行');
  assert.equal(turn.params.approvalPolicy,'on-request');assert.equal(turn.params.approvalsReviewer,'user');
  assert.equal(fake.sent.find(m=>m.method==='thread/resume').params.sandbox,'workspace-write');
  assert.equal(events.find(e=>e.kind==='result').costUsd,null);
  assert.equal(events.find(e=>e.kind==='result').text,'PIXELOFFICE_DONE: fixed');
  assert.equal(events.filter(e=>e.kind==='exit').length,1);
});

test('Codex refuses approvals in read-only diagnostics and reports failed turns',async()=>{
  const events=[];let asked=false;
  const fake=fakeServer((msg,{reply,notify,proc})=>{
    if(msg.method==='initialize')reply(msg.id,{});
    if(msg.method==='thread/start')reply(msg.id,{thread:{id:'t'}});
    if(msg.method==='turn/start'){
      reply(msg.id,{});
      proc.stdout.write(JSON.stringify({id:80,method:'item/commandExecution/requestApproval',params:{command:'write file'}})+'\n');
    }
    if(msg.id===80){assert.equal(msg.result.decision,'decline');notify('turn/completed',{turn:{status:'failed',error:{message:'denied'}}});}
  });
  const code=await new Promise(done=>runCodex({bin:'codex',cwd:process.cwd(),spawnProcess:fake.spawnProcess,prompt:'hello',readOnly:true,
    approve:async()=>{asked=true;return true;},emit:e=>events.push(e),done}));
  assert.equal(code,1);assert.equal(asked,false);assert.equal(events.find(e=>e.kind==='result').isError,true);
  assert.equal(fake.sent.find(m=>m.method==='thread/start').params.approvalPolicy,'never');
});

test('Codex startup errors and early exit finish exactly once',async()=>{
  const events=[];
  const fake=fakeServer((msg,{proc})=>{if(msg.method==='initialize'){proc.emit('error',Error('missing executable'));proc.emit('close',1);}});
  let calls=0;
  await new Promise(done=>runCodex({bin:'codex',cwd:process.cwd(),spawnProcess:fake.spawnProcess,prompt:'hello',
    emit:e=>events.push(e),done:()=>{calls++;done();}}));
  await new Promise(r=>setImmediate(r));
  assert.equal(calls,1);assert.equal(events.filter(e=>e.kind==='result').length,1);
});

test('Codex handshake timeout terminates the process',async()=>{
  const fake=fakeServer(()=>{});let killed=false;const events=[];
  const code=await new Promise(done=>runCodex({bin:'codex',cwd:process.cwd(),spawnProcess:fake.spawnProcess,timeoutMs:10,prompt:'hello',
    kill:p=>{killed=true;p.kill();},emit:e=>events.push(e),done}));
  assert.equal(code,1);assert.equal(killed,true);assert.match(events.find(e=>e.kind==='raw').text,/initialize.*逾時/);
});

test('Codex models come from CLI with pagination rather than Claude aliases',async()=>{
  const fake=fakeServer((msg,{reply})=>{
    if(msg.method==='initialize')reply(msg.id,{});
    if(msg.method==='model/list')reply(msg.id,msg.params.cursor
      ? {data:[{model:'second',displayName:'Second'}],nextCursor:null}
      : {data:[{model:'first',displayName:'First'}],nextCursor:'next'});
  });
  const models=await listModels({bin:'codex',cwd:process.cwd(),spawnProcess:fake.spawnProcess});
  assert.deepEqual(models.map(m=>m.id),['first','second']);
});
