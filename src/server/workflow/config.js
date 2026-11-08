function normalizeAutomation(value = {}) {
  const timeout = Number(value.timeoutMinutes ?? 30);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120) throw Error('每階段逾時須為 1～120 分鐘');
  // 自動分支先更新這個基底分支，再由它建立任務分支；同時也是 MR 草稿的預設目標。
  const baseBranch = String(value.baseBranch || 'develop').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseBranch) || /\.\.|\/\/|[/.]$|\.lock(?:\/|$)/.test(baseBranch)) throw Error('請設定有效的基底分支');
  return {enabled:value.enabled !== false, timeoutMinutes:timeout, baseBranch};
}
module.exports = {normalizeAutomation};
