const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('http'),path=require('path');
const {spawn}=require('child_process');
test('hook emits allow only for positive response; denial and service errors block',async()=>{
  let approved=true;
  const server=http.createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{assert.equal(JSON.parse(body).event.tool_name,'Bash');res.end(JSON.stringify({approved}));});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;
  const run=()=>new Promise(resolve=>{
    const p=spawn(process.execPath,[path.join(__dirname,'../src/server/security/approval-hook.cjs')],{env:{...process.env,RPG_APPROVAL_PORT:String(port),RPG_APPROVAL_TOKEN:'test'}});
    let out='';p.stdout.on('data',d=>out+=d);p.stderr.resume();p.on('close',code=>resolve({code,out}));
    p.stdin.end(JSON.stringify({tool_name:'Bash',tool_input:{command:'git status'}}));
  });
  try{let result=await run();assert.equal(result.code,0);assert.equal(JSON.parse(result.out).hookSpecificOutput.permissionDecision,'allow');approved=false;result=await run();assert.equal(result.code,2);assert.equal(result.out,'');}
  finally{await new Promise(r=>server.close(r));}
  assert.equal((await run()).code,2);
});
