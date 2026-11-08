const {spawn} = require('child_process');
const readline = require('readline');

// All user-controlled content travels over JSON-RPC stdin, never shell argv.
function connect({bin, shell = false, cwd, env, kill = p => p.kill(), spawnProcess = spawn,
  onNotification = () => {}, onRequest = async () => { throw Error('不支援的 Codex 請求'); },
  onError = () => {}, onClose = () => {}, timeoutMs = 30000}) {
  if (shell && /["%\r\n&|<>^]/.test(bin)) throw Error('Codex 執行檔路徑含不支援的 shell 字元');
  const proc = spawnProcess(shell ? `"${bin}"` : bin, ['app-server'], {cwd, env, shell, windowsHide:true});
  const pending = new Map();
  let sequence = 0, closed = false, stderr='';
  proc.stderr.on('data',d=>{stderr=(stderr+d).slice(-4000);});
  function send(message) { if (!closed && !proc.stdin.destroyed) proc.stdin.write(JSON.stringify(message)+'\n'); }
  function rejectAll(error) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); }
  function request(method, params) {
    if (closed) return Promise.reject(Error('Codex 連線已關閉'));
    return new Promise((resolve,reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`Codex ${method} 逾時`)); }, timeoutMs);
      pending.set(id,{resolve,reject,timer}); send({id,method,params});
    });
  }
  const lines = readline.createInterface({input:proc.stdout});
  lines.on('line', line => {
    let msg; try { msg=JSON.parse(line); } catch { return; }
    if (msg.method && msg.id != null) {
      Promise.resolve().then(()=>onRequest(msg.method,msg.params || {})).then(
        result=>send({id:msg.id,result}), error=>send({id:msg.id,error:{code:-32601,message:error.message}}));
    } else if (msg.method) onNotification(msg.method,msg.params || {});
    else if (pending.has(msg.id)) {
      const p=pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
      msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result);
    }
  });
  proc.stdin.on('error', error=>{rejectAll(error);onError(error);});
  proc.on('error', error=>{rejectAll(error);onError(error);});
  proc.on('close', code=>{closed=true;rejectAll(Error(stderr.trim() || 'Codex 程序已結束'));onClose(code);});
  const ready = request('initialize',{clientInfo:{name:'pixeloffice',title:'PixelOffice',version:'1.0.0'}})
    .then(()=>send({method:'initialized',params:{}}));
  return {proc,ready,request,close(){if(!closed){closed=true;rejectAll(Error('Codex 連線已關閉'));kill(proc);}}};
}

function runCodex(options) {
  const {emit, done, prompt, resumeFrom, model, cwd, approve = async()=>false, readOnly=false, permissionMode='auto'} = options;
  let client, settled=false, sessionId='', answer='', finished=false;
  const items=new Map(), started=Date.now();
  function finish(code, error) {
    if(settled)return; settled=true;
    if(error)emit({kind:'raw',stream:'stderr',text:error.message});
    if(!finished)emit({kind:'result',isError:true,sessionId,text:error?.message || 'Codex 在回合完成前結束'});
    client?.close(); emit({kind:'exit',code}); done(code);
  }
  client=connect({...options,
    onError:error=>finish(1,error), onClose:code=>finish(code || 1),
    onRequest:async(method,params)=>{
      if(settled)return {decision:'decline'};
      if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method)) {
        const allowed=!readOnly && await approve(method,params,items.get(params.itemId));
        return {decision:!settled && allowed ? 'accept' : 'decline'};
      }
      if(method==='item/permissions/requestApproval')return {permissions:{},scope:'turn'};
      if(method==='item/tool/requestUserInput')throw Error('此操作需要互動輸入，請透過任務回饋提供資訊');
      throw Error(`尚未支援的 Codex 請求：${method}`);
    },
    onNotification:(method,p)=>{
      if(settled)return;
      if(method==='item/started') {
        const i=p.item; if(!i)return; items.set(i.id,i);
        if(['commandExecution','fileChange','mcpToolCall'].includes(i.type))
          emit({kind:'tool_use',id:i.id,name:i.type==='commandExecution'?'Bash':i.type==='fileChange'?'Edit':i.tool,text:JSON.stringify(i)});
      }
      if(method==='item/completed') {
        const i=p.item; if(!i)return; items.set(i.id,i);
        if(i.type==='agentMessage') {answer=i.text || '';emit({kind:'text',role:'assistant',text:answer});}
        if(i.type==='reasoning' && i.summary?.length)emit({kind:'thinking',text:i.summary.join('\n')});
        if(['commandExecution','fileChange','mcpToolCall'].includes(i.type))
          emit({kind:'tool_result',id:i.id,isError:['failed','declined'].includes(i.status),text:i.aggregatedOutput || JSON.stringify(i.changes || i.result || i.error || i.status)});
      }
      if(method==='error')emit({kind:'raw',stream:'stderr',text:p.error?.message || 'Codex 執行錯誤'});
      if(method==='turn/completed') {
        finished=true;
        const isError=p.turn?.status!=='completed';
        emit({kind:'result',isError,sessionId,text:p.turn?.error?.message || answer,durationMs:Date.now()-started,numTurns:1,costUsd:null});
        finish(isError?1:0);
      }
    }
  });
  client.proc.stderr.on('data',d=>emit({kind:'raw',stream:'stderr',text:d.toString().slice(-4000)}));
  options.onProcess?.(client.proc);
  client.ready.then(async()=>{
    const profile=readOnly
      ? {approvalPolicy:'never',approvalsReviewer:'user',sandbox:'read-only'}
      : permissionMode==='full'
        ? {approvalPolicy:'never',approvalsReviewer:'user',sandbox:'danger-full-access'}
        : {approvalPolicy:'on-request',approvalsReviewer:permissionMode==='auto'?'auto_review':'user',sandbox:'workspace-write'};
    const params={cwd,...profile,...(model?{model}:{})};
    const result=await client.request(resumeFrom?'thread/resume':'thread/start',{...params,...(resumeFrom?{threadId:resumeFrom}:{})});
    sessionId=result.thread.id;
    emit({kind:'system',subtype:'init',provider:'codex',sessionId,model:result.model || model || '',cwd});
    await client.request('turn/start',{threadId:sessionId,input:[{type:'text',text:prompt}],...params});
  }).catch(error=>finish(1,error));
  return client;
}

async function listModels(options) {
  const client=connect(options);
  try {
    await client.ready;
    const models=[]; let cursor;
    do {
      const page=await client.request('model/list',{...(cursor?{cursor}:{}),limit:100});
      models.push(...(page.data || []).map(m=>({id:m.model,displayName:m.displayName || m.model})));
      cursor=page.nextCursor;
    } while(cursor);
    return models;
  } finally { client.close(); }
}
module.exports={connect,runCodex,listModels};
