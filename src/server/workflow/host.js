const path=require('path');
const {normalizeAutomation}=require('./config');
const {runTaskWorkflow}=require('./runner');
const {execute}=require('./process');
const {parseOutcome}=require('./pipeline');
const {PONYTAIL_GUIDANCE}=require('../ponytail-guidance');
const {buildResultReport}=require('../features/engineer-actions');
const {ACTIVE,toCardStatus}=require('../../../public/js/task-status');
function processAlive(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
function createAutomationHost(deps) {
  const {readTask,updateTask,listTasks,activeTasks,stateOf,pushEngineers,pushBoard,pushLocks,io,emitEvent,pmSay,killTree,runClaudeReal,runClaudeMock,markdownFile,lockedPaths,readEvents,eventSeq}=deps;
  let shuttingDown=false;
  function recover() {
    for(const task of listTasks())if(ACTIVE.includes(task.status))updateTask(task.key,{status:'interrupted',phase:'interrupted',blockedReason:'伺服器曾中斷；確認原程序停止後，可從任務面板恢復。',finishedAt:Date.now()});
  }
  function start(task,eng,project,options={}) {
    const mock=deps.isMock ? deps.isMock(task) : deps.mock;
    const config=normalizeAutomation(project?.automation || (options.resume ? task.automation : undefined));
    if(!config.enabled)throw Error('請先在專案設定啟用自動開發，再恢復此任務');
    const cwd=path.resolve(options.resume ? task.projectPath : project?.path || deps.defaultWorkspace);
    if(shuttingDown)throw Error('伺服器正在停止');
    if(lockedPaths()[cwd] || eng.status!=='idle')throw Error('工程師或專案仍有執行中的任務');
    if(options.resume && processAlive(task.workerPid))throw Error('原任務程序仍在執行，請先停止該程序再恢復，避免重複開發');
    const cardId=options.resume && task.cardId || `${task.key}-${eng.id}-${Date.now()}`;
    const controller=new AbortController();
    const info={provider:task.provider || 'claude',cardId,key:task.key,summary:task.summary,engineerId:eng.id,engineerName:eng.name,projectId:project?.id || task.projectId,projectName:project?.name || task.projectName,projectPath:cwd,status:'running',phase:'preparing',startedAt:Date.now(),automation:config};
    const entry={info,proc:null,autonomous:true,controller};
    activeTasks.set(cardId,entry);
    if(options.resume){const prev=readEvents(task.key);eventSeq.set(cardId,Math.max(eventSeq.get(cardId)||0,...prev.events.filter(e=>e.cardId===cardId).map(e=>e.seq||0)));}
    Object.assign(stateOf(eng.id),{status:'working',task:{key:task.key,summary:task.summary,cardId}});
    updateTask(task.key,{...info,status:'preparing',blockedReason:null,policyNotice:null,finishedAt:null,validation:null,...(!options.resume?{delivery:null,sessionId:null,model:eng.model || '',costUsd:null,branchMode:options.branchMode || null,branchName:options.branchName || null}:{}),automation:config});
    io.emit('task:started',info);pushBoard();pushEngineers();pushLocks();
    const checkCancelled=()=>{if(controller.signal.aborted || shuttingDown)throw Error('任務已中止');};
    const update=async patch=>{checkCancelled();updateTask(task.key,patch);Object.assign(info,patch,{status:toCardStatus(patch.status || readTask(task.key).status)});io.emit('task:workflow',{cardId,...patch,status:info.status});};
    const stage=async(phase,extra={})=>{
      const status=phase==='developing'?'in_progress':phase;
      await update({status,phase,...extra});
      emitEvent(cardId,{kind:'system',subtype:'workflow',text:`${phase}${extra.attempt ? ` · 修復第 ${extra.attempt} 次` : ''}`});
    };
    const setProcess=proc=>{entry.proc=proc;if(!shuttingDown)updateTask(task.key,{workerPid:proc?.pid || null});};
    const exec=(file,args)=>execute(file,args,{cwd,timeoutMs:config.timeoutMinutes*60000,signal:controller.signal,kill:killTree,onProcess:setProcess,onOutput:(text,stream)=>emitEvent(cardId,{kind:'raw',stream,text:text.slice(-8000)})});
    const develop=(prompt,attempt)=>new Promise(resolve=>{
      let settled=false,timedOut=false;
      entry.cliOutcome=null;entry.policyDenial=null;
      const complete=code=>{
        if(settled)return;settled=true;clearTimeout(timer);controller.signal.removeEventListener('abort',stop);setProcess(null);
        const parsed=mock ? {complete:true,summary:'模擬開發完成'} : parseOutcome(entry.cliOutcome?.text,entry.cliOutcome?.isError);
        // 「中途有命令被政策擋下」和「任務沒完成」是兩件事。
        // 以前 policyDenial 無條件覆蓋 parsed，工程師明確回報 PIXELOFFICE_DONE
        // 也會被判 blocked —— 即使它已經在摘要裡說明了限制並改用其他做法。
        // 現在只有「沒回報完成」時才用被擋的命令當停住的理由；有回報完成就照常
        // 往下走驗證，被擋的命令改以 policyNotice 附在結果上提醒人看。
        resolve({
          code:timedOut?124:code,
          ...parsed,
          ...(timedOut?{reason:'工程師執行逾時'}:{}),
          ...(entry.policyDenial && !parsed.complete ? {blocked:entry.policyDenial} : {}),
          ...(entry.policyDenial ? {policyNotice:entry.policyDenial} : {}),
        });
      };
      const stop=()=>{killTree(entry.proc);if(entry.proc?.mock)complete(130);};
      const timer=setTimeout(()=>{timedOut=true;stop();},config.timeoutMinutes*60000);
      controller.signal.addEventListener('abort',stop,{once:true});
      const current=readTask(task.key);
      // 沒有外部驗證關卡了，成果是否可信只剩這段摘要，所以要求它明講跑了什麼、結果如何。
      const instructions=`需求檔：${markdownFile(task.key)}\n請讀取需求後完成開發。需求不明確時停止並提出具體問題，不要猜測重要規格。禁止自行提交、推送、部署或更改任務系統檔；提交與推送由使用者手動處理。\n${PONYTAIL_GUIDANCE}\n完成前請自行執行建置或測試確認成果，並在完成摘要中說明你實際跑了哪些命令、結果如何。若未能執行或未通過，如實寫出，不得宣稱通過，也不能刪除測試或降低斷言來讓它過。\n最後一行必須為 PIXELOFFICE_DONE: 完成摘要，或 PIXELOFFICE_BLOCKED: 問題。\n${prompt || ''}`;
      const opts={provider:info.provider,model:eng.model || '',stdinText:instructions,onProcess:setProcess,...((attempt || options.resume) && current.sessionId ? {resumeFrom:current.sessionId} : {})};
      try{(mock?runClaudeMock:runClaudeReal)(current,cardId,cwd,complete,opts);}catch(error){entry.cliOutcome={isError:true,text:error.message};complete(1);}
    });
    const finish=async outcome=>{
      if(shuttingDown)return;
      const status=controller.signal.aborted?'interrupted':outcome.status;
      let resultReport=null,resultReportMock=false,resultReportError=null;
      if(status==='done'){
        try{
          const reportTask={...task,resultSummary:outcome.summary||null};
          const git=async args=>{const r=await exec('git',args);if(r.code!==0)throw Error(r.err||r.out||'Git 執行失敗');return r.out;};
          const report=await buildResultReport({cwd,task:reportTask,git,generate:deps.generate,model:eng.model||'',provider:info.provider,mock});
          resultReport=report.text;resultReportMock=!!report.mock;
        }catch(error){resultReport=`- ${outcome.summary||'工程師已回報完成。'}`;resultReportError=`成果報告自動生成失敗：${error.message}`;}
      }
      const patch={status,phase:status,blockedReason:controller.signal.aborted?'手動中止，可補充指示後恢復。':outcome.reason || null,finishedAt:Date.now(),workerPid:null,policyNotice:outcome.policyNotice || null,resultSummary:outcome.summary || null,resultReport,resultReportMock,resultReportError,mock:mock};
      updateTask(task.key,patch);Object.assign(info,patch);
      Object.assign(stateOf(eng.id),{status:'idle',task:null});
      activeTasks.delete(cardId);deps.cancelApprovals(cardId);pushEngineers();pushBoard();pushLocks();
      io.emit('task:workflow',{cardId,...patch});
      io.emit('task:finished',{cardId,key:task.key,engineerId:eng.id,status,exitCode:status==='done'?0:1,finishedAt:patch.finishedAt});
      const notice=patch.policyNotice?`（過程中有操作被自動模式擋下：${patch.policyNotice}）`:'';
      pmSay(status==='done'?`[${task.key}] ${mock?'模擬流程結束（未實際開發）':'開發完成'}，請檢視變更後自行提交與推送。${notice}`:`[${task.key}] ${patch.blockedReason || '執行失敗，請查看執行紀錄。'}${notice}`,status==='done'?'success':'warn');
    };
    // Catch background failures so a stage error always releases locks and leaves a recoverable task.
    entry.promise=runTaskWorkflow(task,{config,cwd,directory:path.dirname(markdownFile(task.key)),mock:mock,...options},{exec,stage,update,develop,checkCancelled})
      .then(finish).catch(error=>finish({status:'blocked',reason:error.message}));
    return {ok:true,cardId,key:task.key};
  }
  function shutdown(){
    shuttingDown=true;
    for(const [id,entry] of activeTasks){
      if(entry.autonomous){updateTask(entry.info.key,{status:'interrupted',phase:'interrupted',blockedReason:'伺服器停止，等待恢復。'});entry.controller.abort();killTree(entry.proc);deps.cancelApprovals(id);}
    }
  }
  return {start,recover,shutdown};
}
module.exports={createAutomationHost,processAlive};
