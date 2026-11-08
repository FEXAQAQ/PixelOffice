const fs=require('fs'),path=require('path');
const {runPipeline}=require('./pipeline');
const {canonical,within}=require('../security/autonomous-policy');
function writeJson(file,value){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,file);}
// 這支只負責「準備乾淨的任務分支」和「跑開發」。提交、推送與開 MR/PR 一律由使用者
// 在成果面板由使用者決定；這裡只更新基底分支並建立任務分支，不 add、commit 或 push。
async function runTaskWorkflow(task, options, deps) {
  const {config,cwd,directory,branchMode,branchName,resume=false,mock=false}=options;
  const git=async args=>{const result=await deps.exec('git',args);if(result.code!==0)throw Error(result.err||result.out||'Git 執行失敗');if(result.truncated)throw Error('Git 結果過大，請縮小變更範圍');return result.out.trim();};
  let branch=task.branch, baseline=task.baseCommit;
  await deps.stage('preparing');
  if (!mock && !String(task.description || '').trim()) throw Error('需求描述為空，請先補齊需求再開發');
  if (!mock) {
    const root=canonical(await git(['rev-parse','--show-toplevel']));
    if (root!==canonical(cwd)) throw Error('專案路徑必須是 Git repository 根目錄');
    if (within(root,canonical(directory))) throw Error('TASK_DIR 必須位於開發專案之外，避免系統紀錄混入提交');
    if (resume) {
      const current=await git(['rev-parse','--abbrev-ref','HEAD']);
      if (!branch || current!==branch) throw Error('目前分支與原任務不同，請先切回原任務分支再恢復');
    } else {
      if (branchMode==='auto') {
        // 自動模式要切換分支並 pull，工作目錄必須乾淨；手動模式由使用者自行負責既有修改。
        if ((await git(['status','--porcelain'])).trim()) throw Error('自動模式要求乾淨的工作目錄，請先提交或保存既有修改');
        // 自動模式永遠從最新基底分支開始，避免任務分支建立在過期的 develop 上。
        await git(['checkout',config.baseBranch]);
        await git(['pull','--ff-only','origin',config.baseBranch]);
        baseline=await git(['rev-parse','HEAD']);
        // A new task never silently adopts an old branch with unrelated commits.
        await git(['checkout','-b',branchName]);branch=branchName;
      } else {branch=await git(['rev-parse','--abbrev-ref','HEAD']);baseline=await git(['rev-parse','HEAD']);}
    }
    if (!branch || ['HEAD','main','master',config.baseBranch].includes(branch)) throw Error('請使用獨立任務分支，不能在主分支開發');
  } else {branch=branch || branchName || `${task.provider || 'claude'}/${task.key}`;baseline='mock';}
  await deps.update({branch,baseCommit:baseline,automation:config,blockedReason:null});
  const outcome=await runPipeline({
    checkCancelled:deps.checkCancelled,stage:deps.stage,develop:deps.develop,
  },options.prompt || '');
  writeJson(path.join(directory,'workflow-result.json'),{...outcome,at:Date.now(),mock});
  return outcome;
}
module.exports={runTaskWorkflow};
