/**
 * PM 開單：需求內容 → AI 生成摘要與描述 → 預覽確認 → 建立 Jira 工單。
 *
 * 兩段式刻意分開成兩個 API：
 *   POST /api/jira/card/draft  只生成草稿，不碰 Jira（可以重生成、可以改）
 *   POST /api/jira/card        只建單，內容完全以畫面送來的為準
 * 生成與建立之間隔著使用者的確認，是這個功能的重點 —— 建 Jira 單對外可見、
 * 不可撤銷，不能讓 AI 生完就直接送出。
 */

const {
  ISSUE_TYPES, readPromptDoc, promptFilePath, parsePromptDoc, describeIssueTypes, buildCardPrompt, parseCardDraft, mockCardDraft,
} = require('../integrations/jira-card-prompt');
const { fetchParent, fetchCardContext, createIssue, KEY_PATTERN } = require('../integrations/jira-create');

const INPUT_MAX = 20000;       // 需求內容上限，避免整份文件貼進來把提示撐爆
const DESCRIPTION_MAX = 32000; // 對齊 createJiraIssue 的 description 欄位上限

/** 提示樣板裡真的有描述範本的類型；沒有範本就生不出內容，也就不該出現在畫面上。 */
function templatedTypes() {
  return new Set(Object.keys(parsePromptDoc(readPromptDoc()).templates));
}

/**
 * Jira 查不到類型時（mock／連不上）退回樣板自帶的那幾種。
 * 每個類型順便帶上樣板裡的用途、範例與章節，讓畫面說明兩種單的差異。
 */
function usableIssueTypes(jiraTypes) {
  const info = describeIssueTypes(readPromptDoc());
  const templated = new Set(Object.keys(info));
  const usable = (jiraTypes || []).filter((t) => templated.has(t.name));
  const types = usable.length
    ? usable
    : ISSUE_TYPES.filter((name) => templated.has(name)).map((name) => ({ name, subtask: false }));
  return types.map((t) => ({ ...t, ...info[t.name] }));
}

/**
 * 組出「開新單」面板要的東西：議題類型、父系候選、Sprint、提示樣板位置。
 *
 * 抽成獨立函式是為了讓開機預熱與路由共用同一段邏輯 —— mcp 模式下 fetchCardContext
 * 要走 MCP，是這個面板最慢的一段，值得快取。
 * Jira 那半邊取不到不擋整個面板 —— 帶著 contextError 回去，使用者仍可手動輸入父系單號。
 */
function createCardOptionsLoader({ jiraMode, aiMode, jiraBoardIdSetting, onLog }) {
  return async function loadCardOptions() {
    const mode = jiraMode();
    const base = {
      mode, aiMock: aiMode() !== 'real', promptFile: promptFilePath(),
      issueTypes: usableIssueTypes([]), parentGroups: [], sprints: [], projectKey: '', contextError: '',
    };
    if (mode !== 'mcp') {
      return {
        ...base, supported: true, projectKey: 'MOCK',
        parentGroups: [
          { type: '大型工作', issues: [
            { key: 'MOCK-1', summary: '示範大型工作（模擬資料）' },
            { key: 'MOCK-2', summary: '另一個示範大型工作（模擬資料）' },
          ] },
        ],
        sprints: [{ id: 1, name: '示範 Sprint（模擬資料）' }],
      };
    }
    try {
      const ctx = await fetchCardContext(jiraBoardIdSetting(), { onLog });
      return { ...base, supported: true, ...ctx, issueTypes: usableIssueTypes(ctx.issueTypes) };
    } catch (err) {
      return { ...base, supported: true, contextError: err.message };
    }
  };
}

function installJiraCardRoutes(app, deps) {
  const { jiraMode, aiMode, aiSettings, generate, pmSay, io, jiraBoardIdSetting, readCardOptions } = deps;

  const onLog = (chunk, stream) => io.emit('mcp:log', { chunk, stream: stream || 'stdout', ts: Date.now() });
  const isMockJira = () => jiraMode() !== 'mcp';

  /** 讀快取；?refresh=1 由畫面上的「重新整理」按鈕帶進來，強制重撈。 */
  app.get('/api/jira/card/options', async (req, res) => {
    try {
      const { data, fetchedAt, fromCache } = await readCardOptions({ refresh: String(req.query.refresh || '') === '1' });
      res.json({ ...data, fetchedAt, fromCache });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** 查父系單（手動輸入時用）：確認它存在、有權限，並取回它所屬的專案。 */
  app.get('/api/jira/card/parent', async (req, res) => {
    const key = String(req.query.key || '').trim().toUpperCase();
    if (!KEY_PATTERN.test(key)) return res.status(400).json({ error: `父系單號格式不正確（例如 DEMO-123）：${key || '（空白）'}` });
    if (isMockJira()) {
      return res.json({ key, summary: '示範父系單（模擬資料）', projectKey: key.split('-')[0], projectName: '（mock）', issueType: '大型工作', mock: true });
    }
    try {
      res.json({ ...(await fetchParent(key, { onLog })), mock: false });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** 生成草稿：只呼叫 AI，不碰 Jira。 */
  app.post('/api/jira/card/draft', async (req, res) => {
    const { text, issueType } = req.body || {};
    const input = String(text || '').trim();
    if (!input) return res.status(400).json({ error: '請先輸入需求內容' });
    if (input.length > INPUT_MAX) return res.status(400).json({ error: `需求內容超過 ${INPUT_MAX} 字，請精簡後再生成` });
    if (!templatedTypes().has(String(issueType || ''))) return res.status(400).json({ error: '請選擇議題類型' });

    try {
      const doc = readPromptDoc();
      if (aiMode() !== 'real') {
        return res.json({ ...mockCardDraft({ doc, issueType, input }), mock: true });
      }
      const prompt = buildCardPrompt({ doc, issueType, input });
      pmSay(`正在依開卡範本生成「${issueType}」工單內容…`, 'info');
      const result = await generate(prompt, '', aiSettings.get());
      const draft = parseCardDraft(result.text);
      pmSay(`已生成工單草稿：${draft.summary}`, 'success');
      res.json({ ...draft, mock: false });
    } catch (err) {
      pmSay(`生成工單內容失敗：${err.message}`, 'error');
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 建立工單：內容以畫面送來的為準（使用者可能在預覽時改過）。
   * 專案代碼一律回頭跟 Jira 要（fetchParent），不信畫面送來的值。
   */
  app.post('/api/jira/card', async (req, res) => {
    const { summary, description, parentKey, issueType, sprintId } = req.body || {};
    const title = String(summary || '').trim();
    const body = String(description || '').trim();
    const parent = String(parentKey || '').trim().toUpperCase();

    if (!title) return res.status(400).json({ error: '摘要不可為空' });
    if (!body) return res.status(400).json({ error: '描述不可為空' });
    if (body.length > DESCRIPTION_MAX) return res.status(400).json({ error: `描述超過 ${DESCRIPTION_MAX} 字，請精簡後再建立` });
    if (!templatedTypes().has(String(issueType || ''))) return res.status(400).json({ error: '請選擇議題類型' });
    if (!KEY_PATTERN.test(parent)) return res.status(400).json({ error: '父系為必填，請從清單選擇或手動輸入單號' });
    if (sprintId != null && sprintId !== '' && !Number.isInteger(Number(sprintId))) {
      return res.status(400).json({ error: '衝刺 ID 不合法' });
    }

    if (isMockJira()) {
      const key = `${parent.split('-')[0]}-${900 + Math.floor(Math.random() * 100)}`;
      pmSay(`【Mock】模擬建立工單 ${key}：${title}（未真的寫入 Jira）`, 'warn');
      return res.json({ ok: true, key, url: '', mock: true, summary: title });
    }

    try {
      const parentInfo = await fetchParent(parent, { onLog });
      pmSay(`正在建立 Jira 工單（父系 ${parentInfo.key} · 專案 ${parentInfo.projectKey}）…`, 'info');
      const created = await createIssue({
        projectKey: parentInfo.projectKey,
        issueTypeName: issueType,
        summary: title,
        description: body,
        parentKey: parentInfo.key,
        sprintId: sprintId === '' ? null : sprintId,
      }, { onLog });
      pmSay(`已建立 Jira 工單 ${created.key}：${title}`, 'success');
      res.json({ ok: true, ...created, mock: false });
    } catch (err) {
      pmSay(`建立 Jira 工單失敗：${err.message}`, 'error');
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { installJiraCardRoutes, createCardOptionsLoader, usableIssueTypes, INPUT_MAX, DESCRIPTION_MAX };
