/**
 * 任務是從哪個 Jira 模式接取的，以及看板該顯示哪些。
 *
 * mock 的示範單和正式工單混在同一個看板上會分不清哪張是真的，
 * 所以接取時記下當下的模式（task.source），看板只顯示對應來源的任務。
 */

// mock 模式配給示範工單的 Sprint。它同時是「這張單是模擬資料」的識別依據，
// 所以只能有這一份定義。
const MOCK_SPRINT = {
  id: 1,
  name: '示範 Sprint（模擬資料）',
  state: 'active',
  startDate: '2026-09-01T00:00:00Z',
};

const isMockSprint = (sprint) =>
  !!sprint && sprint.id === MOCK_SPRINT.id && sprint.name === MOCK_SPRINT.name;

/**
 * 判斷任務來源。
 *
 * source 是後來才加的欄位，在那之前接取的任務沒有 —— 但 mock 任務帶著內建的
 * 示範 Sprint，那是 mock 分支才生得出來的，足以認定。
 * 認不出來的回 null：寧可顯示，也不要用猜的把使用者的資料藏起來。
 *
 * @returns {'mock'|'real'|'mcp'|null}
 */
function taskSource(task) {
  if (!task) return null;
  if (task.source) return task.source;
  if (isMockSprint(task.sprint)) return 'mock';
  return null;
}

/** 過濾出屬於指定模式的任務；來源不明的一律保留。 */
function filterBySource(tasks, mode) {
  return tasks.filter((task) => {
    const source = taskSource(task);
    return !source || source === mode;
  });
}

module.exports = { MOCK_SPRINT, taskSource, filterBySource };
