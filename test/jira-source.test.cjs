const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MOCK_SPRINT, taskSource, filterBySource } = require('../src/server/jira-source');

test('task source prefers the recorded mode and falls back to the built-in mock sprint', () => {
  // 接取時記下的模式優先，即使 sprint 看起來像 mock
  assert.equal(taskSource({ key: 'A-1', source: 'mcp' }), 'mcp');
  assert.equal(taskSource({ key: 'A-1', source: 'real', sprint: MOCK_SPRINT }), 'real');

  // 沒有 source 的舊任務：帶著內建示範 Sprint 的就是 mock
  assert.equal(taskSource({ key: 'JIRA-101', sprint: { ...MOCK_SPRINT } }), 'mock');

  // 認不出來就回 null，不要用猜的
  assert.equal(taskSource({ key: 'A-1' }), null);
  assert.equal(taskSource({ key: 'A-1', sprint: null }), null);
  assert.equal(taskSource({ key: 'A-1', sprint: { id: 42, name: 'Sprint 7' } }), null);
  // 只對上其中一半不算數（真實看板也可能有 id 1 或同名的 Sprint）
  assert.equal(taskSource({ key: 'A-1', sprint: { id: 1, name: 'Sprint 7' } }), null);
  assert.equal(taskSource({ key: 'A-1', sprint: { id: 9, name: MOCK_SPRINT.name } }), null);
  assert.equal(taskSource(null), null);
});

test('board filtering hides other modes but keeps tasks of unknown origin', () => {
  const tasks = [
    { key: 'M-1', source: 'mock' },
    { key: 'R-1', source: 'real' },
    { key: 'C-1', source: 'mcp' },
    { key: 'OLD-1', sprint: { ...MOCK_SPRINT } },  // 舊的 mock 單，靠 sprint 認出來
    { key: 'OLD-2' },                               // 來源不明，一律保留
  ];
  const keys = (mode) => filterBySource(tasks, mode).map((t) => t.key);

  assert.deepEqual(keys('mock'), ['M-1', 'OLD-1', 'OLD-2']);
  assert.deepEqual(keys('mcp'), ['C-1', 'OLD-2'], 'mcp 模式不該看到模擬資料的單');
  assert.deepEqual(keys('real'), ['R-1', 'OLD-2']);
});
