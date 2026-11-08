const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createJiraCardActions, MANUAL_PARENT } = require('../public/js/dashboard-jira-card');

const ref = (value) => ({ value });

const TYPES = [
  { name: '任務', subtask: false },
  { name: '故事', subtask: false },
  { name: '大型工作', subtask: false },
  { name: '子任務', subtask: true },
];
const OPTIONS = {
  supported: true, projectKey: 'DEMO', issueTypes: TYPES, sprints: [{ id: 7, name: 'S7' }],
  promptFile: 'C:/repo/config/jira-card-prompt.md', aiMock: false, contextError: '',
  parentGroups: [
    { type: '任務', issues: [{ key: 'DEMO-1400', summary: '登入頁破版' }] },
    { type: '大型工作', issues: [{ key: 'DEMO-1377', summary: '社交工程' }] },
  ],
};

function setup(handler) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null });
    return handler(url, options);
  };
  const toasts = [];
  const panel = createJiraCardActions({ ref, toast: (msg, type) => toasts.push({ msg, type }) });
  return { panel, calls, toasts };
}

const ok = (data) => ({ ok: true, json: async () => data });
const fail = (error) => ({ ok: false, json: async () => ({ error }) });

async function opened(handler = () => ok(OPTIONS)) {
  const s = setup(handler);
  await s.panel.openCreate();
  return s;
}

test('開啟面板會載入專案、類型、父系候選與提示樣板位置', async () => {
  const { panel } = await opened();
  assert.equal(panel.showCreate.value, true);
  assert.equal(panel.cardType.value, '任務');
  assert.equal(panel.cardOptions.value.projectKey, 'DEMO');
  assert.match(panel.cardOptions.value.promptFile, /jira-card-prompt\.md$/);
});

test('父系候選依議題類型分組，數量可統計', async () => {
  const { panel } = await opened();
  assert.deepEqual(panel.parentGroups().map((g) => g.type), ['任務', '大型工作']);
  assert.equal(panel.parentCount(), 2);
});

test('下拉選好父系就能建單，不必再打 API 查一次', async () => {
  const { panel, calls } = await opened((url) => (url === '/api/jira/card/options' ? ok(OPTIONS) : ok({ ok: true, key: 'DEMO-500' })));
  panel.cardDraft.value = { summary: 's', description: 'd' };
  panel.cardParent.value = 'DEMO-1377';
  assert.equal(panel.parentReady(), true);
  await panel.createCard();
  const create = calls.find((c) => c.url === '/api/jira/card');
  assert.equal(create.body.parentKey, 'DEMO-1377');
  assert.equal(calls.filter((c) => c.url.startsWith('/api/jira/card/parent')).length, 0);
});

test('沒選父系時不送出建單請求', async () => {
  const { panel, calls } = await opened();
  panel.cardDraft.value = { summary: 's', description: 'd' };
  assert.equal(panel.parentReady(), false);
  await panel.createCard();
  assert.equal(calls.filter((c) => c.url === '/api/jira/card').length, 0);
});

test('手動輸入的父系要查得到才算備妥', async () => {
  const { panel } = await opened((url) => (url === '/api/jira/card/options'
    ? ok(OPTIONS)
    : ok({ key: 'DEMO-99', summary: '手動的單', projectKey: 'DEMO' })));
  panel.cardParent.value = MANUAL_PARENT;
  panel.cardParentManual.value = ' demo-99 ';
  assert.equal(panel.parentReady(), false, '還沒查就不能建');
  await panel.lookupParent();
  assert.equal(panel.cardParentManual.value, 'DEMO-99');
  assert.equal(panel.parentReady(), true);
  assert.equal(panel.parentKey(), 'DEMO-99');
});

test('手動輸入查不到時留下錯誤，且不視為備妥', async () => {
  const { panel } = await opened((url) => (url === '/api/jira/card/options' ? ok(OPTIONS) : fail('查不到父系單 DEMO-99')));
  panel.cardParent.value = MANUAL_PARENT;
  panel.cardParentManual.value = 'DEMO-99';
  await panel.lookupParent();
  assert.equal(panel.cardParentInfo.value, null);
  assert.match(panel.cardParentErr.value, /查不到父系單/);
  assert.equal(panel.parentReady(), false);
});

test('手動查完又改了單號，要重查才算數', async () => {
  const { panel } = await opened((url) => (url === '/api/jira/card/options'
    ? ok(OPTIONS)
    : ok({ key: 'DEMO-99', summary: '手動的單', projectKey: 'DEMO' })));
  panel.cardParent.value = MANUAL_PARENT;
  panel.cardParentManual.value = 'DEMO-99';
  await panel.lookupParent();
  panel.cardParentManual.value = 'DEMO-100';
  assert.equal(panel.parentReady(), false);
});

test('換議題類型不會弄丟已經選好的父系', async () => {
  const { panel } = await opened();
  panel.cardParent.value = 'DEMO-1377';
  panel.cardType.value = '子任務';
  assert.equal(panel.parentReady(), true);
  assert.equal(panel.parentKey(), 'DEMO-1377');
});

test('生成草稿只呼叫 draft API，不會順手建單', async () => {
  const { panel, calls } = await opened((url) => (url === '/api/jira/card/options'
    ? ok(OPTIONS) : ok({ summary: '摘要', description: '描述', mock: false })));
  panel.cardText.value = '需求'; panel.cardType.value = '故事';
  await panel.generateCard();
  const draft = calls.find((c) => c.url === '/api/jira/card/draft');
  assert.deepEqual(draft.body, { text: '需求', issueType: '故事' });
  assert.deepEqual(panel.cardDraft.value, { summary: '摘要', description: '描述' });
  assert.equal(calls.filter((c) => c.url === '/api/jira/card').length, 0);
});

test('建單送出的是預覽區改過的內容，衝刺留空送 null', async () => {
  const { panel, calls, toasts } = await opened((url) => (url === '/api/jira/card/options'
    ? ok(OPTIONS) : ok({ ok: true, key: 'DEMO-500', url: 'https://x/browse/DEMO-500' })));
  panel.cardDraft.value = { summary: '我改過的摘要', description: '我改過的描述' };
  panel.cardParent.value = 'DEMO-1377'; panel.cardSprintId.value = '';
  await panel.createCard();
  const body = calls.find((c) => c.url === '/api/jira/card').body;
  assert.equal(body.summary, '我改過的摘要');
  assert.equal(body.description, '我改過的描述');
  assert.equal(body.sprintId, null);
  assert.equal(panel.cardCreated.value.key, 'DEMO-500');
  assert.equal(toasts[0].type, 'success');
});

test('負責端：未指定維持原標題，指定了就加前綴', async () => {
  const { panel, calls } = await opened((url) => (url === '/api/jira/card/options' ? ok(OPTIONS) : ok({ ok: true, key: 'DEMO-502' })));
  panel.cardDraft.value = { summary: '登入頁改版', description: 'd' };
  panel.cardParent.value = 'DEMO-1377';
  assert.equal(panel.cardTitle(), '登入頁改版');
  for (const [scope, title] of [['前端', '[前端] 登入頁改版'], ['後端', '[後端] 登入頁改版'], ['前後端', '[前後端] 登入頁改版']]) {
    panel.cardScope.value = scope;
    assert.equal(panel.cardTitle(), title);
  }
  await panel.createCard();
  assert.equal(calls.find((c) => c.url === '/api/jira/card').body.summary, '[前後端] 登入頁改版');
});

test('負責端：摘要自己帶了標籤不會重複，換選項也跟著換', async () => {
  const { panel } = await opened();
  panel.cardDraft.value = { summary: '[前端] 登入頁改版', description: 'd' };
  panel.cardScope.value = '後端';
  assert.equal(panel.cardTitle(), '[後端] 登入頁改版');
  panel.cardScope.value = '';
  assert.equal(panel.cardTitle(), '登入頁改版');
});

test('重開面板時負責端回到未指定', async () => {
  const { panel } = await opened();
  panel.cardScope.value = '前端';
  await panel.openCreate();
  assert.equal(panel.cardScope.value, '');
});

test('選了衝刺會送出數字 ID', async () => {
  const { panel, calls } = await opened((url) => (url === '/api/jira/card/options' ? ok(OPTIONS) : ok({ ok: true, key: 'DEMO-501' })));
  panel.cardDraft.value = { summary: 's', description: 'd' };
  panel.cardParent.value = 'DEMO-1377'; panel.cardSprintId.value = '7';
  await panel.createCard();
  assert.equal(calls.find((c) => c.url === '/api/jira/card').body.sprintId, 7);
});

test('建單失敗顯示錯誤且不記成已建立，避免誤以為要重送', async () => {
  const { panel } = await opened((url) => (url === '/api/jira/card/options' ? ok(OPTIONS) : fail('欄位不合法')));
  panel.cardDraft.value = { summary: 's', description: 'd' };
  panel.cardParent.value = 'DEMO-1377';
  await panel.createCard();
  assert.equal(panel.cardCreated.value, null);
  assert.equal(panel.cardErr.value, '欄位不合法');
  assert.equal(panel.cardCreating.value, false);
});

test('重新開啟面板會清掉上一次的草稿、父系與結果', async () => {
  const { panel } = await opened();
  panel.cardDraft.value = { summary: 's', description: 'd' };
  panel.cardCreated.value = { key: 'DEMO-1' };
  panel.cardParent.value = 'DEMO-1377';
  panel.cardParentManual.value = 'DEMO-99';
  panel.cardErr.value = '舊錯誤';
  await panel.openCreate();
  assert.equal(panel.cardDraft.value, null);
  assert.equal(panel.cardCreated.value, null);
  assert.equal(panel.cardParent.value, '');
  assert.equal(panel.cardParentManual.value, '');
  assert.equal(panel.cardErr.value, '');
});

test('取不到父系候選時仍保留手動輸入這條路', async () => {
  const { panel } = await opened(() => ok({ ...OPTIONS, parentGroups: [], contextError: '看板沒有進行中的 Sprint' }));
  assert.equal(panel.parentCount(), 0);
  assert.match(panel.cardOptions.value.contextError, /Sprint/);
  panel.cardParent.value = MANUAL_PARENT;
  assert.equal(panel.isManualParent(), true);
});

test('接取新單走既有的依單號接取；Jira 還沒同步時不關視窗', async () => {
  const { panel, calls } = await opened((url) => (url === '/api/jira/card/options'
    ? ok(OPTIONS) : ok({ ok: true, claimed: [], missing: ['DEMO-500'] })));
  panel.cardCreated.value = { key: 'DEMO-500', mock: false };
  await panel.claimCreated();
  assert.ok(calls.some((c) => c.url === '/api/tasks/claim-by-key'));
  assert.equal(panel.showCreate.value, true);
  assert.match(panel.cardErr.value, /還查不到/);
});
