// Transport-independent lifecycle: subprocesses, storage and UI are supplied by the host.
//
// 交付是人工決策：開發回報完成後，使用者看成果報告與檔案清單，再決定是否按下
// commit、還原或 push。所以自動開發管線不跑系統驗證、也不寫入 git ——
// 工程師是否真的建置／測試過，由它在 PIXELOFFICE_DONE 摘要裡交代，人看 diff 時判斷。
async function runPipeline(deps, initialPrompt = '') {
  deps.checkCancelled();
  await deps.stage('developing');
  const result = await deps.develop(initialPrompt, 0);
  deps.checkCancelled();
  // 被政策擋下的命令：不影響流程走向，但要一路帶到結果裡讓人看見。
  const policyNotice = result.policyNotice || null;
  if (result.blocked) return {status:'blocked',reason:result.blocked,policyNotice};
  if (result.code !== 0 || result.isError) return {status:'failed',reason:result.reason || '工程師程序執行失敗',policyNotice};
  if (!result.complete) return {status:'blocked',reason:'工程師未回報明確完成結果，請確認需求或補充指示。',policyNotice};
  return {status:'done',summary:result.summary,policyNotice};
}
function parseOutcome(text, isError = false) {
  const lines=String(text || '').trim().split(/\r?\n/), last=lines.at(-1) || '';
  const blocked=last.match(/^PIXELOFFICE_BLOCKED:\s*(.+)$/);
  const done=last.match(/^PIXELOFFICE_DONE:\s*(.+)$/);
  return {isError,blocked:blocked?.[1],complete:!!done && !isError,summary:done?.[1] || ''};
}
module.exports = {runPipeline,parseOutcome};
