const fs=require('fs'),path=require('path');
const {STATUS,RESETTABLE,label}=require('../../../public/js/task-status');
const {refOK}=require('./engineer-actions');

// 重置後只留下從 Jira 接單時就有的欄位；其餘（session、分支、成本、成果…）全部清掉。
const KEEP=['key','summary','description','type','priority','sprint','source'];

/**
 * 重置進度：把一張已停下的任務還原成「剛接單」的樣子，可選擇一併刪除任務分支。
 *
 * 跟「退回待指派」的差別：退回只改狀態，下次派工會帶著舊 sessionId 與舊分支接著跑；
 * 重置是真的從頭來。舊的對話紀錄與成果檔改名封存，不直接刪，事後還查得到。
 *
 * 順序是「先 Git、後清狀態」：分支刪除被拒絕或失敗時，任務紀錄維持原樣，不會只做一半。
 */
function installTaskReset(app, deps){
  const {readTask,saveTask,eventsFile,activeTasks,lockedPaths,actionLocks,pushLocks,runGit,readGit,baseBranchOf,eventSeq,cancelApprovals,pushBoard,io,pmSay,now=Date.now}=deps;

  async function deleteBranch(task){
    const branch=task.branch,base=baseBranchOf(task);
    if(!branch)return '這張單沒有記錄任務分支，略過刪除';
    if(task.mock)return '模擬任務沒有實際分支，略過刪除';
    if(!refOK(branch) || ['HEAD','main','master',base].includes(branch))throw Error(`不允許刪除分支 ${branch}`);
    if(!task.projectPath)throw Error('任務缺少專案路徑，無法刪除分支');
    const cwd=path.resolve(task.projectPath);
    if(lockedPaths()[cwd])throw Error('專案正在執行任務或其他操作，請稍後再試');
    actionLocks.set(cwd,{engineerName:task.engineerName||'',taskKey:task.key});pushLocks();
    try{
      const read=async args=>{const r=await readGit(args,cwd,null,{quiet:true});if(r.code!==0)throw Error(r.err||r.out||'Git 讀取失敗');return r.out.trim();};
      const write=async(args,approvalDetails)=>{const r=await runGit(args,cwd,null,{quiet:true,approvalDetails});if(r.code!==0)throw Error(r.err||r.out||'Git 操作失敗');};
      const exists=await readGit(['show-ref','--verify','--quiet',`refs/heads/${branch}`],cwd,null,{quiet:true});
      if(exists.code===1)return `分支 ${branch} 已不存在，略過刪除`;
      if(exists.code!==0)throw Error(exists.err||'無法檢查任務分支');
      if(await read(['rev-parse','--abbrev-ref','HEAD'])===branch){
        // 站在要刪的分支上就得先切走。有未提交的修改時不替使用者決定去留，直接擋下。
        if(await read(['status','--porcelain']))throw Error(`目前在任務分支 ${branch} 上且有未提交的修改，請先在「進階 Git 操作」還原或自行處理後再重置`);
        await write(['checkout',base],`切回基底分支 ${base}，才能刪除任務分支 ${branch}。`);
      }
      await write(['branch','-D',branch],`強制刪除本機任務分支 ${branch}（含未合併的 commit）；遠端分支不受影響。`);
      return `已刪除本機分支 ${branch}`;
    }finally{actionLocks.delete(cwd);pushLocks();}
  }

  // 舊紀錄改名封存而不是刪掉：重置是要重跑，不是要湮滅證據。
  function archiveRunFiles(task){
    const stamp=now(),dir=path.dirname(eventsFile(task.key));
    for(const [file,archived] of [[eventsFile(task.key),`log.reset-${stamp}.jsonl`],[path.join(dir,'workflow-result.json'),`workflow-result.reset-${stamp}.json`]]){
      if(fs.existsSync(file))fs.renameSync(file,path.join(dir,archived));
    }
  }

  app.post('/api/tasks/:key/reset',async(req,res)=>{
    try{
      const task=readTask(req.params.key);
      if(!task)return res.status(404).json({error:'找不到任務'});
      if([...activeTasks.values()].some(a=>a.info.key===task.key))throw Error(`${task.key} 正在執行，請先中止再重置`);
      if(!RESETTABLE.includes(task.status))throw Error(`${task.key} 目前是「${label(task.status,task.archived)}」，無法重置進度`);
      const gitNote=req.body && req.body.deleteBranch===true ? await deleteBranch(task) : null;
      archiveRunFiles(task);
      if(task.cardId){eventSeq.delete(task.cardId);cancelApprovals(task.cardId);}
      const fresh=Object.fromEntries(KEEP.filter(k=>k in task).map(k=>[k,task[k]]));
      // statusHistory 由 saveTask 自動沿用，重置本身也會留下一筆 backlog 紀錄
      saveTask({...fresh,status:STATUS.BACKLOG,claimedAt:now(),resetAt:now(),resetCount:(task.resetCount||0)+1});
      io.emit('task:requeued',{key:task.key});pushBoard();
      pmSay(`[${task.key}] 已重置進度，回到待指派${gitNote?`（${gitNote}）`:''}。舊對話紀錄已封存在 task/${task.key}/。`,'warn');
      res.json({ok:true,key:task.key,git:gitNote});
    }catch(e){res.status(400).json({error:e.message});}
  });
}
module.exports={installTaskReset,KEEP};
