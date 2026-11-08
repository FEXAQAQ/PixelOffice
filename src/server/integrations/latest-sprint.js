function boardId(value = process.env.JIRA_BOARD_ID) {
  if (!/^\d+$/.test(value || '')) throw Error('請設定 JIRA_BOARD_ID（Jira 看板數字 ID），才能選取該看板最新的進行中 Sprint。');
  return Number(value);
}
function latestActiveSprint(sprints) {
  const active = sprints.filter(s => s.state === 'active');
  if (active.some(s => !Number.isFinite(Date.parse(s.startDate)) || !/^\d+$/.test(String(s.id)) || !s.name)) throw Error('Sprint 資料缺少有效的開始日期、ID 或名稱，無法判定最新 Sprint。');
  return active.sort((a,b)=>Date.parse(b.startDate)-Date.parse(a.startDate) || Number(b.id)-Number(a.id))[0] || null;
}
async function collectSprints(fetchPage) {
  const all = [];
  for (let startAt=0; ; ) {
    const page = await fetchPage(startAt);
    const values = page?.values || page?.sprints;
    if (!Array.isArray(values)) throw Error('Sprint 清單回傳格式不正確');
    all.push(...values);
    startAt += values.length;
    if (page.isLast === true || (Number.isFinite(page.total) && startAt >= page.total)) return all;
    if (!values.length) {
      if (page.isLast === false || page.total > startAt) throw Error('Sprint 分頁不完整');
      return all;
    }
    if (page.isLast === undefined && page.total === undefined) throw Error('Sprint 清單缺少分頁資訊，無法確認最新 Sprint');
  }
}
/**
 * 組出預設 JQL：指定 Sprint 中、狀態為 To Do、且未指派的任務。
 *
 * 用 statusCategory 而非 status，是因為各團隊的狀態名稱不一（待辦 / To Do /
 * Open / Backlog…），但 statusCategory 是 Jira 標準化的三大類
 * （To Do / In Progress / Done），不會因命名差異而漏撈。
 *
 * extra（JIRA_JQL）與 project（JIRA_PROJECT）僅能縮小 Sprint 內的查詢範圍。
 */
function sprintJql(sprint, extra = '', project = process.env.JIRA_PROJECT) {
  if (!/^\d+$/.test(String(sprint.id))) throw Error('Sprint ID 不合法');
  const conditions = [`sprint = ${sprint.id}`, 'statusCategory = "To Do"', 'assignee is EMPTY'];
  if (project) conditions.push(`project = ${JSON.stringify(project)}`);
  // Custom filters narrow the selected sprint; never override its boundary.
  const filter = extra.replace(/\s*ORDER\s+BY\s+[^]*$/i, '').trim();
  if (filter) conditions.push(`(${filter})`);
  return conditions.join(' AND ') + ' ORDER BY created DESC';
}
module.exports = {boardId, latestActiveSprint, collectSprints, sprintJql};
