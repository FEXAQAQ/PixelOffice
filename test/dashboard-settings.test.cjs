const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSettingsActions } = require('../public/js/dashboard-settings');

test('settings panel edits drafts and saves each setting through its API', async () => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, body: options?.body ? JSON.parse(options.body) : null });
    const settings = { mode: 'mock', accessMode: 'auto', jiraBoardId: '42' };
    const data = url === '/api/ai' && !options
      ? { provider: 'codex' }
      : url.startsWith('/api/models')
        ? { aliases: [], models: ['example'], seen: [] }
        : url === '/api/ai'
          ? { provider: 'codex', mode: 'mock' }
          : url === '/api/runtime' && !options
            ? { settings, values: { mode: ['mock','real'], accessMode: ['ask','auto','full'], jiraBoardId: null }, defaults: settings,
                overridden: {}, effective: { mode: 'mock', accessMode: 'auto', claude: 'mock', codex: 'mock', jira: 'mock' } }
            : url === '/api/runtime'
              ? { ok: true, settings, overridden: { mode: true }, effective: { mode: 'mock', accessMode: 'auto', claude: 'mock', codex: 'mock', jira: 'mock' } }
              : {};
    return { ok: true, json: async () => data };
  };
  const ref = (value) => ({ value });
  const state = {
    showSettings: ref(false), setErr: ref(''), draftProjects: ref([]),
    draftEngineers: ref([]), draftAi: { provider: 'claude' },
    draftModes: { mode: 'mock', accessMode: 'auto', jiraBoardId: '' },
    modesInfo: { values: {}, defaults: {}, overridden: {}, effective: {} },
    aiLoading: ref(false), aiReady: ref(false), setSaving: ref(false),
    projects: ref([{ id: 'project', name: 'Project', path: '/project', automation: { commands: ['npm test'] } }]),
    engineerList: ref([{ id: 'devA', name: 'Dev A', model: 'sonnet' }]),
    modelInfo: {}, sys: {}, toast: () => {},
  };
  try {
    const actions = createSettingsActions(state);
    await actions.openSettings();
    assert.equal(state.showSettings.value, true);
    assert.equal(state.draftAi.provider, 'codex');
    assert.equal(state.draftProjects.value[0].automation.commands, undefined);
    assert.equal(state.draftProjects.value[0].automation.baseBranch, 'develop');
    assert.equal(state.draftModes.mode, 'mock', '開啟設定要載入目前模式');
    assert.equal(state.draftModes.jiraBoardId, '42', '看板 ID 也要載入');
    actions.addEngineer();
    await actions.saveSettings();
    assert.equal(state.showSettings.value, false);
    assert.equal(state.sys.aiProvider, 'codex');
    // 模式排在最後送：被擋下時（有任務在跑、Jira 缺憑證）錯誤訊息才不會被後續請求蓋掉。
    assert.deepEqual(calls.filter(({ url }) => url.startsWith('/api/')).map(({ url }) => url),
      ['/api/ai', '/api/runtime', '/api/models?provider=codex', '/api/projects', '/api/engineers', '/api/ai', '/api/runtime']);
    // 草稿是從伺服器載入的現況，不是元件的初始值
    assert.deepEqual(calls.filter(({ url }) => url === '/api/runtime').pop().body,
      { mode: 'mock', accessMode: 'auto', jiraBoardId: '42' });
    assert.equal(calls.find(({ url }) => url === '/api/engineers').body.engineers.length, 2);
  } finally {
    global.fetch = previousFetch;
  }
});

test('mock mode prefills a distinct demo path for each new project; real mode leaves it blank', () => {
  const ref = (value) => ({ value });
  const state = {
    showSettings: ref(true), setErr: ref(''), draftEngineers: ref([]), draftAi: { provider: 'claude' },
    draftProjects: ref([{ id: 'p1', name: 'Old', path: 'mock/project-1', automation: {} }]),
    draftModes: { mode: 'mock' }, modesInfo: {}, aiLoading: ref(false), aiReady: ref(true), setSaving: ref(false),
    projects: ref([]), engineerList: ref([]), modelInfo: {}, sys: {}, toast: () => {},
  };
  const actions = createSettingsActions(state);
  actions.addProject(); actions.addProject();
  // 同一路徑同時只能跑一個任務，所以示範路徑不能撞到既有的
  assert.deepEqual(state.draftProjects.value.map(p => p.path), ['mock/project-1', 'mock/project-2', 'mock/project-3']);
  state.draftModes.mode = 'real';
  actions.addProject();
  assert.equal(state.draftProjects.value.at(-1).path, '');
});
