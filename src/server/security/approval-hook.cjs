// Claude PreToolUse: approval is single-use; errors and timeouts block the call.
// 同一支 hook 也負責 AskUserQuestion：伺服器回 updatedInput（含使用者的 answers）時一併交回 CLI。
// passthrough 代表這次呼叫不歸 hook 管（例如只掛來接提問的模式），不表態、交回 CLI 原本的權限流程。
const http=require('http');
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>input+=chunk);
function deny(message){process.stderr.write(message);process.exit(2);}
process.stdin.on('end',()=>{
  let event;try{event=JSON.parse(input);}catch{deny('Invalid approval input');}
  const body=JSON.stringify({token:process.env.RPG_APPROVAL_TOKEN,event});
  const req=http.request({hostname:'127.0.0.1',port:process.env.RPG_APPROVAL_PORT,path:'/api/tool-approval',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
    let data='';res.on('data',d=>data+=d);res.on('end',()=>{
      let decision;
      try{decision=JSON.parse(data);if(res.statusCode!==200 || !(decision.approved || decision.passthrough))return deny(decision.reason || '此操作未核准。');}
      catch{return deny('Approval response invalid');}
      if(decision.passthrough)return process.exit(0);
      const output={hookEventName:'PreToolUse',permissionDecision:'allow',permissionDecisionReason:decision.updatedInput?'使用者已回答問題。':'操作符合專案自動執行設定或已由使用者核准。'};
      if(decision.updatedInput)output.updatedInput=decision.updatedInput;
      process.stdout.write(JSON.stringify({hookSpecificOutput:output}));
    });
  });
  req.setTimeout(Number(process.env.RPG_HOOK_TIMEOUT_MS)||310000,()=>req.destroy(new Error('Approval timed out')));
  req.on('error',()=>deny('Approval service unavailable; operation blocked'));
  req.end(body);
});
