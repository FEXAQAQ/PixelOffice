/**
 * =============================================================
 *  jira-create.js — 透過 Atlassian MCP 建立 Jira 工單（PM 開單用）
 * -------------------------------------------------------------
 *  沿用 jira-mcp.js 的 withSession（握手 / cloudId / 工具比對），只加上開單
 *  這條路徑需要的三件事：
 *    1. fetchParent()      依父系單號取回它的專案與標題（建立前的權威驗證）
 *    2. fetchCardContext()  一次取回專案、議題類型、父系候選與進行中 Sprint
 *    3. createIssue()      呼叫 createJiraIssue 真的開單
 *
 *  ⚠️ 衝刺是 custom field（各站台 ID 不同，例如 customfield_10020），
 *     所以只在使用者真的選了 Sprint 時，才臨時查一次欄位 metadata 取得 ID。
 *     schema.custom 以 `gh-sprint` 結尾的那個欄位才是 Sprint，不能用名稱猜。
 * =============================================================
 */

const { withSession, findTool, extractPayload, pickIssueNode } = require('./jira-mcp');
const { boardId, collectSprints, latestActiveSprint } = require('./latest-sprint');

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** MCP 的 isError 只說「壞了」，錯誤字串在 content 裡，撈出來才知道是權限、欄位還是格式問題。 */
function errorText(result) {
  const payload = extractPayload(result);
  if (typeof payload === 'string') return payload.slice(0, 500);
  if (payload && typeof payload === 'object') {
    const msg = payload.message || payload.error || (Array.isArray(payload.errorMessages) ? payload.errorMessages.join('；') : '');
    if (msg) return String(msg).slice(0, 500);
    return JSON.stringify(payload).slice(0, 500);
  }
  return '';
}

function assertKey(key, label) {
  const k = String(key || '').trim().toUpperCase();
  if (!KEY_PATTERN.test(k)) throw Error(`${label}格式不正確（例如 DEMO-123）：${key || '（空白）'}`);
  return k;
}

/**
 * 依父系單號取回開單需要的上下文。
 * 專案代碼優先用 Jira 回的 fields.project.key；真的沒回才退回單號前綴
 * （團隊管理專案兩者一致），並在 log 標記是推導來的。
 */
async function fetchParent(rawKey, opts = {}) {
  const key = assertKey(rawKey, '父系單號');
  return withSession(opts.onLog, async ({ client, tools, cloudId, log }) => {
    const issueTool = pickTool(tools, 'getJiraIssue');
    if (!issueTool) throw Error('找不到 Jira 工單讀取工具（getJiraIssue）');
    log(`[mcp] 查詢父系單：${key}\n`);
    const result = await client.callTool(issueTool, {
      cloudId,
      issueIdOrKey: key,
      fields: ['summary', 'project', 'issuetype'],
    });
    if (result.isError) throw Error(`查不到父系單 ${key}（不存在或沒有存取權限）`);
    const node = pickIssueNode(extractPayload(result));
    if (!node) throw Error(`查不到父系單 ${key}（不存在或沒有存取權限）`);

    const fields = node.fields || node;
    const projectKey = (fields.project && fields.project.key) || key.split('-')[0];
    if (!(fields.project && fields.project.key)) log(`[mcp] Jira 未回傳專案欄位，依單號前綴推導專案 ${projectKey}\n`);
    return {
      key: node.key || key,
      summary: typeof fields.summary === 'string' ? fields.summary : '',
      projectKey,
      projectName: (fields.project && fields.project.name) || '',
      issueType: (fields.issuetype && fields.issuetype.name) || '',
    };
  });
}

/**
 * 工具名稱在不同 Atlassian MCP 端點上不一致（例如 listJiraProjectIssueTypesMetadata
 * 在別的端點叫 getJira…），所以候選名稱一路試過去，最後才用片段模糊比對。
 */
function pickTool(tools, ...candidates) {
  for (const name of candidates) {
    const hit = tools.find((t) => t.name === name)
      || tools.find((t) => t.name && t.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.name;
  }
  for (const name of candidates) {
    const hit = findTool(tools, name);
    if (hit) return hit;
  }
  return null;
}

/** 一次搜尋，回 [{key, summary}]；父系下拉只需要這兩個欄位。 */
async function searchIssues({ client, tools, cloudId }, jql, maxResults = 50) {
  const searchTool = pickTool(tools, 'searchJiraIssuesUsingJql', 'searchJiraIssues');
  if (!searchTool) throw Error('找不到 Jira JQL 搜尋工具（searchJiraIssuesUsingJql）');
  const result = await client.callTool(searchTool, { cloudId, jql, maxResults, fields: ['summary'] });
  if (result.isError) throw Error(errorText(result) || 'Jira 搜尋失敗');
  const payload = extractPayload(result) || {};
  const issues = payload.issues || payload.results || payload.values || [];
  const nodes = Array.isArray(issues) ? issues : issues.nodes || [];
  return nodes
    .map((it) => ({ key: it.key || '', summary: (it.fields && it.fields.summary) || it.summary || '' }))
    .filter((it) => it.key);
}

/** JQL 字串常值：雙引號與反斜線要跳脫。議題類型名稱是查出來的，仍不信任地帶進查詢。 */
function jqlString(value) {
  return '"' + String(value).replace(/["\\]/g, (c) => '\\' + c) + '"';
}

/** 專案的議題類型清單。 */
async function listIssueTypes({ client, tools, cloudId }, projectKey) {
  const typesTool = pickTool(
    tools, 'listJiraProjectIssueTypesMetadata', 'getJiraProjectIssueTypesMetadata', 'ProjectIssueTypesMetadata',
  );
  if (!typesTool) throw Error('MCP 未提供議題類型清單工具（listJiraProjectIssueTypesMetadata）');
  const res = await client.callTool(typesTool, { cloudId, projectIdOrKey: projectKey, maxResults: 200 });
  if (res.isError) throw Error(errorText(res) || '取得議題類型失敗');
  const payload = extractPayload(res) || {};
  const list = payload.issueTypes || payload.values || (Array.isArray(payload) ? payload : []);
  return list.filter((t) => t && t.name).map((t) => ({ id: String(t.id || ''), name: t.name, subtask: !!t.subtask }));
}

/**
 * 專案代碼原本是從父系單推導的，但父系改成下拉之後得先有專案才列得出候選，
 * 所以改由看板決定：JIRA_PROJECT 有設就用它，否則抓最新進行中 Sprint 裡
 * 任一張單的專案 —— 看板上的單本來就屬於同一個專案。
 */
async function resolveProjectKey(ctx, sprint, log) {
  const configured = String(process.env.JIRA_PROJECT || '').trim();
  if (configured) return configured.toUpperCase();
  if (!sprint) throw Error('看板沒有進行中的 Sprint，無法判斷專案；請在 .env 設定 JIRA_PROJECT');
  const [issue] = await searchIssues(ctx, `sprint = ${sprint.id} ORDER BY created DESC`, 1);
  if (!issue) throw Error('最新 Sprint 沒有任何工單，無法判斷專案；請在 .env 設定 JIRA_PROJECT');
  const key = issue.key.split('-')[0];
  log(`[mcp] 依 Sprint #${sprint.id} 的 ${issue.key} 判定專案為 ${key}\n`);
  return key;
}

/** 下拉要列出哪種議題類型當父系；預設只列大型工作（Epic）。 */
const PARENT_TYPES = (process.env.JIRA_PARENT_TYPES || '大型工作')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * 開單面板一次要的全部資料：專案、議題類型、父系候選、進行中 Sprint。
 * 刻意合併成單一 MCP session —— 起 mcp-remote 的成本遠高於多打幾次工具。
 *
 * ⚠️ 父系候選用「指定議題類型各撈一批」，而不是撈最近 N 張再分類：
 *    這個 MCP 端點把 issuetype 裁到只剩 name（沒有 hierarchyLevel），
 *    混在一起就分不出哪張是大型工作；而大型工作通常比較舊，
 *    只撈最近 N 張會整組看不到。指名去撈才保證選得到。
 *    專案裡沒有 PARENT_TYPES 指定的類型時，退回所有非子任務類型，
 *    免得換一個命名習慣不同的專案就整個下拉空掉（子任務不能當父系，不撈）。
 */
async function fetchCardContext(board, opts = {}) {
  const selectedBoard = boardId(board || process.env.JIRA_BOARD_ID);
  const perType = Number(opts.perType) > 0 ? Number(opts.perType) : 50;

  return withSession(opts.onLog, async (ctx) => {
    const { client, tools, cloudId, log } = ctx;

    const sprintTool = pickTool(tools, 'listJiraBoardSprints');
    if (!sprintTool) throw Error('MCP 未提供 listJiraBoardSprints');
    const rawSprints = await collectSprints(async (startAt) => {
      const result = await client.callTool(sprintTool, {
        cloudId, boardId: selectedBoard, state: 'active', startAt, maxResults: 50,
      });
      if (result.isError) throw Error(errorText(result) || 'MCP 取得 Sprint 失敗');
      return extractPayload(result);
    });
    const sprints = rawSprints
      .filter((s) => s && s.state === 'active' && s.id != null && s.name)
      .map((s) => ({ id: Number(s.id), name: s.name, startDate: s.startDate || '' }));

    const projectKey = await resolveProjectKey(ctx, latestActiveSprint(rawSprints), log);
    const issueTypes = await listIssueTypes(ctx, projectKey);

    const candidates = issueTypes.filter((t) => !t.subtask);
    const wanted = candidates.filter((t) => PARENT_TYPES.includes(t.name));
    if (!wanted.length) log(`[mcp] 專案 ${projectKey} 沒有 ${PARENT_TYPES.join('／')} 類型，父系候選改列全部非子任務類型\n`);

    const groups = await Promise.all((wanted.length ? wanted : candidates).map(async (t) => ({
      type: t.name,
      issues: await searchIssues(
        ctx,
        `project = ${projectKey} AND issuetype = ${jqlString(t.name)} AND statusCategory != Done ORDER BY created DESC`,
        perType,
      ),
    })));
    const parentGroups = groups.filter((g) => g.issues.length);
    log(`[mcp] 父系候選：${parentGroups.map((g) => `${g.type} ${g.issues.length} 張`).join('、') || '（無）'}\n`);

    return { projectKey, issueTypes, sprints, parentGroups };
  });
}

/**
 * 找出 Sprint custom field 的 ID（各站台不同，常見是 customfield_10020）。
 *
 * ⚠️ 不能只看 schema.custom：有些 MCP 端點會把 schema 裁成只剩 type/items，
 *    custom 整個不見。所以依序用三個訊號判斷，愈前面愈可靠。
 */
function findSprintField(fields) {
  const byCustom = (fields || []).find(
    (f) => f && f.schema && typeof f.schema.custom === 'string' && f.schema.custom.endsWith('gh-sprint'),
  );
  if (byCustom) return byCustom;
  const byName = (fields || []).find((f) => f && typeof f.name === 'string' && /^(sprint|衝刺)$/i.test(f.name.trim()));
  if (byName) return byName;
  return (fields || []).find((f) => f && f.schema && f.schema.type === 'array' && f.schema.items === 'json');
}

async function sprintFieldId({ client, tools, cloudId, projectKey, issueTypeName, log }) {
  const fieldsTool = pickTool(tools, 'getJiraIssueTypeMetaWithFields', 'IssueTypeMetaWithFields');
  if (!fieldsTool) throw Error('MCP 未提供欄位 metadata 工具，無法指定衝刺；請把衝刺留空後在 Jira 手動排入');

  const types = await listIssueTypes({ client, tools, cloudId }, projectKey);
  const type = types.find((t) => t.name === issueTypeName);
  if (!type) throw Error(`專案 ${projectKey} 沒有「${issueTypeName}」這個議題類型`);

  const metaRes = await client.callTool(fieldsTool, {
    cloudId, projectIdOrKey: projectKey, issueTypeId: String(type.id), requiredFieldsOnly: false, maxResults: 100,
  });
  if (metaRes.isError) throw Error(errorText(metaRes) || '取得欄位 metadata 失敗');
  const sprint = findSprintField(extractPayload(metaRes)?.fields || []);
  if (!sprint) throw Error(`「${issueTypeName}」找不到衝刺欄位，請把衝刺留空後在 Jira 手動排入`);
  const fieldId = sprint.fieldId || sprint.key;
  log(`[mcp] 衝刺欄位：${fieldId}\n`);
  return fieldId;
}

/**
 * createJiraIssue 的「議題類型」參數名。
 *
 * Atlassian 在遠端改過這個名字（issueTypeName → issueType），舊名會直接被擋下來：
 *   MCP error -32602: Invalid arguments for tool createJiraIssue: Required at issueType
 * 工具清單本來就會回 inputSchema，所以直接照它當下宣告的欄位送，不要寫死名字。
 */
function issueTypeArgName(tools, toolName) {
  const tool = (tools || []).find((t) => t && t.name === toolName);
  const properties = ((tool && (tool.inputSchema || tool.input_schema)) || {}).properties || {};
  if (properties.issueType) return 'issueType';
  if (properties.issueTypeName) return 'issueTypeName';
  return 'issueType';
}

/**
 * 真的建立一張 Jira 工單。
 * 描述以 markdown 送出（createJiraIssue 支援 contentFormat），不必自己轉 ADF。
 */
async function createIssue(input, opts = {}) {
  const projectKey = String(input.projectKey || '').trim();
  const issueTypeName = String(input.issueTypeName || '').trim();
  const summary = String(input.summary || '').trim();
  const description = String(input.description || '').trim();
  const parentKey = input.parentKey ? assertKey(input.parentKey, '父系單號') : '';
  const sprintId = input.sprintId == null || input.sprintId === '' ? null : Number(input.sprintId);

  if (!projectKey) throw Error('缺少專案代碼');
  if (!issueTypeName) throw Error('缺少議題類型');
  if (!summary) throw Error('缺少摘要');
  if (!description) throw Error('缺少描述');
  if (sprintId != null && !Number.isInteger(sprintId)) throw Error('衝刺 ID 不合法');

  return withSession(opts.onLog, async ({ client, tools, cloudId, log }) => {
    const createTool = pickTool(tools, 'createJiraIssue');
    if (!createTool) throw Error('MCP 未提供 createJiraIssue 工具');

    const args = { cloudId, projectKey, summary, description, contentFormat: 'markdown' };
    args[issueTypeArgName(tools, createTool)] = issueTypeName;
    if (parentKey) args.parent = parentKey;
    if (sprintId != null) {
      const fieldId = await sprintFieldId({ client, tools, cloudId, projectKey, issueTypeName, log });
      args.additional_fields = { [fieldId]: sprintId };
    }

    log(`[mcp] 建立 ${projectKey} 的「${issueTypeName}」，父系 ${parentKey || '（無）'}，衝刺 ${sprintId ?? '（未指定）'}\n`);
    const result = await client.callTool(createTool, args);
    if (result.isError) throw Error(errorText(result) || '建立 Jira 工單失敗');

    const payload = extractPayload(result);
    const key = payload?.key || payload?.issue?.key || pickIssueNode(payload)?.key;
    // 沒拿到單號時不能當成失敗重試 —— 單可能已經建出來了，重送會變兩張。
    if (!key) throw Error('Jira 已回應但沒有回傳單號，請先到 Jira 確認是否已建立，不要直接重送');
    log(`[mcp] 已建立 ${key}\n`);
    return { key, summary, url: issueUrl(payload, key) };
  });
}

/** 盡量給出可點的連結；推不出站台網址就回空字串，不硬湊。 */
function issueUrl(payload, key) {
  const direct = payload?.url || payload?.issue?.url || payload?.self || '';
  const site = String(direct).match(/^https:\/\/[^/]+\.atlassian\.net/);
  if (site) return `${site[0]}/browse/${key}`;
  const base = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  return base ? `${base}/browse/${key}` : '';
}

module.exports = { fetchParent, fetchCardContext, createIssue, KEY_PATTERN, pickTool, errorText, issueUrl, jqlString, findSprintField, issueTypeArgName, PARENT_TYPES };
