const test = require('node:test');
const assert = require('node:assert');
const { createJiraCache } = require('../src/server/jira-cache');

/** 可控制何時完成的 loader，用來測同時讀取與預熱。 */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('開機預熱後讀取不會再打一次 Jira', async () => {
  let calls = 0;
  const cache = createJiraCache({ loaders: { tasks: async () => { calls += 1; return { tasks: [calls] }; } } });

  cache.warm(['tasks']);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, '預熱應該撈一次');

  const first = await cache.read('tasks');
  assert.equal(calls, 1, '有快取就不該再撈');
  assert.equal(first.fromCache, true);
  assert.deepEqual(first.data, { tasks: [1] });
  assert.ok(first.fetchedAt > 0, '要帶回取得時間');

  await cache.read('tasks');
  assert.equal(calls, 1);
});

test('refresh 會重撈並換掉快取內容', async () => {
  let calls = 0;
  const cache = createJiraCache({ loaders: { tasks: async () => { calls += 1; return { n: calls }; } } });

  await cache.read('tasks');
  const refreshed = await cache.read('tasks', { refresh: true });
  assert.equal(calls, 2);
  assert.equal(refreshed.fromCache, false);
  assert.deepEqual(refreshed.data, { n: 2 });
  assert.deepEqual((await cache.read('tasks')).data, { n: 2 }, '之後讀到的是新的那份');
});

test('同時多個請求只會真的撈一次', async () => {
  let calls = 0;
  const gate = deferred();
  const cache = createJiraCache({ loaders: { tasks: async () => { calls += 1; await gate.promise; return { ok: true }; } } });

  const all = Promise.all([cache.read('tasks'), cache.read('tasks'), cache.read('tasks')]);
  gate.resolve();
  const results = await all;
  assert.equal(calls, 1, '三個同時進來只該打一次 Jira');
  for (const r of results) assert.deepEqual(r.data, { ok: true });
});

test('預熱失敗不會拋出，之後讀取會重試', async () => {
  let calls = 0;
  const cache = createJiraCache({
    loaders: { tasks: async () => { calls += 1; if (calls === 1) throw Error('MCP 請求逾時'); return { ok: true }; } },
  });

  cache.warm(['tasks']);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cache.state('tasks').ready, false);
  assert.equal(cache.state('tasks').error, 'MCP 請求逾時', '錯誤要留著給畫面顯示');

  const retried = await cache.read('tasks');
  assert.equal(calls, 2, '沒有資料時要重試，不能一直回舊錯誤');
  assert.deepEqual(retried.data, { ok: true });
});

test('讀取失敗會把錯誤往外拋，讓路由回 500', async () => {
  const cache = createJiraCache({ loaders: { tasks: async () => { throw Error('看板不存在'); } } });
  await assert.rejects(() => cache.read('tasks'), /看板不存在/);
});

test('invalidate 之後下次讀取會重撈', async () => {
  let calls = 0;
  const cache = createJiraCache({ loaders: { tasks: async () => { calls += 1; return { n: calls }; } } });

  await cache.read('tasks');
  cache.invalidate(['tasks']);
  assert.equal(cache.state('tasks').ready, false, '丟掉後就不該再宣稱有資料');

  assert.deepEqual((await cache.read('tasks')).data, { n: 2 });
  assert.equal(calls, 2);
});

test('狀態變化會通知出去（給 Socket.io 用）', async () => {
  const seen = [];
  const cache = createJiraCache({
    loaders: { tasks: async () => ({ ok: true }) },
    onState: (name, state) => seen.push({ name, loading: state.loading, ready: state.ready }),
  });

  await cache.read('tasks');
  assert.deepEqual(seen[0], { name: 'tasks', loading: true, ready: false }, '開始撈要先通知');
  assert.deepEqual(seen[seen.length - 1], { name: 'tasks', loading: false, ready: true }, '撈完再通知一次');
});

test('onState 自己爆掉不影響取資料', async () => {
  const cache = createJiraCache({
    loaders: { tasks: async () => ({ ok: true }) },
    onState: () => { throw Error('socket 壞了'); },
  });
  assert.deepEqual((await cache.read('tasks')).data, { ok: true });
});

test('未知的項目名稱直接報錯', () => {
  const cache = createJiraCache({ loaders: { tasks: async () => ({}) } });
  assert.throws(() => cache.state('nope'), /未知的快取項目/);
});

test('兩個項目各自獨立，互不影響', async () => {
  let a = 0, b = 0;
  const cache = createJiraCache({
    loaders: { tasks: async () => { a += 1; return { a }; }, cardOptions: async () => { b += 1; return { b }; } },
  });

  cache.warm();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(a, 1); assert.equal(b, 1);

  await cache.read('tasks', { refresh: true });
  assert.equal(a, 2, '只有 tasks 重撈');
  assert.equal(b, 1, 'cardOptions 不該被牽連');
  assert.equal(cache.states().length, 2);
});
