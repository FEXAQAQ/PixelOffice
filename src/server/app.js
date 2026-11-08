// HTTP、Socket 與手動任務的協調入口；獨立邏輯放在 features、integrations 和 workflow。

require('dotenv').config({path:require('path').resolve(__dirname,'../../.env')});

// 公司網路的 SSL 檢查會以自簽根憑證重簽 HTTPS；Node 預設不讀 Windows 憑證庫，
// 外部 API（例如 Jev）會出現 SELF_SIGNED_CERT_IN_CHAIN。這裡把系統信任的根憑證一併加入。
{
  const tls = require('tls');
  if (typeof tls.setDefaultCACertificates === 'function') {
    try { tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]); }
    catch (error) { console.warn('[tls] 無法載入系統根憑證：' + error.message); }
  }
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT_DIR = path.resolve(__dirname, '../..');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const { ApprovalGate } = require('./security/approval-gate');
const toolTokens = new Map();
const {TOOL_NAME:ASK_TOOL,parseQuestions,normalizeAnswers}=require('./security/ask-user-question');
// 工程師提問時等人回答的上限；逾時就當作略過，讓工程師自行判斷或回報受阻。
const QUESTION_TIMEOUT_MS=30*60*1000;
const actionLocks = new Map();
const {installActions}=require('./features/engineer-actions');
const {installJevReview}=require('./features/jev-review');

const express = require('express');
const { Server } = require('socket.io');
const { fetchUnassignedTasks, fetchIssuesDetail } = require('./integrations/jira-mcp');

// -------------------------------------------------------------
//  設定
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
// 預設只綁 loopback。這個服務沒有任何認證，而且能指定任意路徑執行 claude，
// 所以不該預設對區網開放（Node 的 listen 不指定 host 時是綁所有網卡）。
const HOST = process.env.HOST || '127.0.0.1';
// 預設：當前 Sprint 中、狀態為 To Do、且未指派的任務（可用 JIRA_JQL / JIRA_PROJECT 調整）
const JIRA_JQL = process.env.JIRA_JQL || '';
const {STATUS, label:taskStatusLabel, toCardStatus, REQUEUEABLE, RESUMABLE, REVIEWABLE, ARCHIVABLE, DELETABLE, FINISHED} = require('../../public/js/task-status');
const {normalizeAutomation}=require('./workflow/config');
const {clip, blockText, normalizeClaudeMessage, NOISE_SYSTEM_SUBTYPES}=require('./integrations/claude-stream');
const {MOCK_SPRINT,taskSource,filterBySource}=require('./jira-source');
const {openBrowser}=require('./open-browser');
const {createJiraCache}=require('./jira-cache');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const {runCodex,listModels:codexModels}=require('./integrations/codex');
const {PONYTAIL_GUIDANCE}=require('./ponytail-guidance');
const {createSettings,PROVIDERS}=require('./ai-settings');
const aiSettings=createSettings(process.env.AI_CONFIG || path.join(ROOT_DIR,'config','ai.json'),process.env.AI_PROVIDER || 'claude');
const {createRuntimeSettings,SETTING_KEYS, MODULE_KEYS}=require('./runtime-settings');
// env 給開機預設值，設定檔存畫面上的覆寫；兩者在這裡收斂成單一真相來源。
const LEGACY_REAL_MODE = ['mcp','real'].includes(String(process.env.JIRA_MODE || '').toLowerCase()) ||
  String(process.env.CLAUDE_MODE || '').toLowerCase() === 'real' ||
  String(process.env.CODEX_MODE || '').toLowerCase() === 'real';
const runtimeSettings=createRuntimeSettings(
  process.env.RUNTIME_CONFIG || path.join(ROOT_DIR,'config','runtime.json'),
  {mode:process.env.PIXEL_OFFICE_MODE || (LEGACY_REAL_MODE?'real':'mock'),
   accessMode:process.env.AI_ACCESS_MODE || 'auto', jiraBoardId:process.env.JIRA_BOARD_ID,
   jev:/^(1|true|on|yes)$/i.test(process.env.JEV_ENABLED || '')?'on':'off'}
);
function aiMode() { return runtimeSettings.get('mode'); }
function jiraMode(){return runtimeSettings.get('mode')==='real'?'mcp':'mock';}
function accessMode(){return runtimeSettings.get('accessMode');}
function runtimeSettingsView(){const mode=runtimeSettings.get('mode');return {settings:runtimeSettings.all(),effective:{mode,accessMode:accessMode(),claude:mode,codex:mode,jira:jiraMode()},overridden:runtimeSettings.overridden()};}
/** 選配功能模組是否啟用，前端依此決定要不要顯示對應畫面 */
function modules(){return {jev:runtimeSettings.get('jev')==='on'};}
function systemInfo(){return {modules:modules(),jiraMode:jiraMode(),claudeMode:aiMode('claude'),aiProvider:aiSettings.get(),aiMode:aiMode(),taskDir:TASK_DIR};}
function codexOptions(cwd){const bin=resolveBin(CODEX_BIN) || CODEX_BIN;return {bin,shell:needsShell(bin),cwd,env:process.env,kill:killTree};}
function engineerModel(engineer,provider){return (provider==='codex'?engineer.codexModel:engineer.model) || '';}


// task 資料夾（接取的工單存放處）與設定檔
const TASK_DIR = process.env.TASK_DIR || path.join(ROOT_DIR, 'task');
const PROJECTS_CONFIG = process.env.PROJECTS_CONFIG || path.join(ROOT_DIR, 'config', 'projects.json');
const ENGINEERS_CONFIG = process.env.ENGINEERS_CONFIG || path.join(ROOT_DIR, 'config', 'engineers.json');
const ROLES_CONFIG = process.env.ROLES_CONFIG || path.join(ROOT_DIR, 'config', 'roles.json');
const DEFAULT_WORKSPACE = process.env.WORKSPACE_DIR || ROOT_DIR;

// 確保 task 資料夾存在
fs.mkdirSync(TASK_DIR, { recursive: true });

const { loadProjects, saveProjects, resolveProject, loadEngineers, saveEngineers, loadRoles, saveRoles } =
  require('./config-store').createConfigStore({ projectsFile: PROJECTS_CONFIG, engineersFile: ENGINEERS_CONFIG, rolesFile: ROLES_CONFIG });
const { roleName } = require('../../public/js/office-roles');

const { MODEL_ALIASES, seenModels, fetchModelList } = require('./integrations/claude-models');

// -------------------------------------------------------------
//  工具：解析 CLI 路徑與安全地 spawn
// -------------------------------------------------------------
/**
 * 解析執行檔的實際路徑。找不到回 null。
 *
 * ⚠️ 已經是路徑的話要自己檢查檔案，不能丟給 where/which ——
 *    那兩個只查 PATH、不接受絕對路徑。少了這段，CLAUDE_BIN 填絕對路徑時
 *    會被判定成「找不到」，CLAUDE_MODE=auto 就會靜靜地退回 mock。
 */
function resolveBin(bin) {
  const raw = String(bin || '').trim();
  if (!raw) return null;

  if (/[\\/]/.test(raw)) {
    try {
      if (fs.existsSync(raw) && fs.statSync(raw).isFile()) return path.resolve(raw);
    } catch (_) {}
    // Windows 上常見省略副檔名的寫法
    if (process.platform === 'win32') {
      for (const ext of ['.cmd', '.bat', '.exe', '.com', '.ps1']) {
        try {
          if (fs.existsSync(raw + ext)) return path.resolve(raw + ext);
        } catch (_) {}
      }
    }
    return null;
  }

  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(probe, [bin], { encoding: 'utf8' });
    if (res.status !== 0) return null;
    const hits = String(res.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (process.platform !== 'win32') return hits[0] || null;
    // ⚠️ Windows 的 where 會一次列出同名的多個檔案，而且把「沒有副檔名」的排在最前面
    //    （npm 全域安裝會同時放下 claude 與 claude.cmd，前者是給 POSIX shell 用的包裝）。
    //    取 [0] 會挑到無副檔名那個：where 有回東西所以判定「找得到」、
    //    CLAUDE_MODE=auto 選 real，但 needsShell 看它不是 .cmd 就回 false，
    //    於是走「不開 shell」的路徑 —— 而 Windows 不開 shell 時只認得 PATHEXT 裡的
    //    副檔名，結果每次執行都 spawn ENOENT。所以要挑第一個真的能被 spawn 的。
    const exts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
    return hits.find((h) => exts.includes(path.extname(h).toLowerCase())) || null;
  } catch (_) {
    return null;
  }
}

/**
 * ⚠️ 安全規則：絕對不要用 { shell: true } 搭配含外部輸入的 args。
 *    Node 在那個組合下只做字串拼接、不做轉義，所以工單描述裡一個 & 就是命令注入，
 *    描述裡的換行還會讓命令在該處被截斷（Node 自己會丟 DEP0190 警告提醒這件事）。
 *
 * Windows 上的兩難：npm 全域安裝的 CLI 是 .cmd 包裝，而 Node 18.20+ 為了修
 * CVE-2024-27980，對 .cmd / .bat 不開 shell 會直接丟 EINVAL。所以規則是：
 *   - 目標是 .exe（或在 POSIX 上）→ 直接 spawn，args 可以安全地含任意內容
 *   - 目標是 .cmd / .bat（只能走 shell）→ args 必須全是固定字面值，
 *     外部輸入改走 stdin（見 runClaudeReal）
 */
function needsShell(bin) {
  if (process.platform !== 'win32') return false;
  const resolved = resolveBin(bin);
  if (!resolved) return true;                     // 解析不到就保守假設需要 shell
  return /\.(cmd|bat)$/i.test(resolved);
}

/** 走 shell 時執行檔路徑要自己加引號 —— Node 不會幫你包，路徑含空白就會失敗。 */
function shellQuote(bin) {
  return /[\s()]/.test(bin) ? `"${bin}"` : bin;
}

// 真的想讓 claude 走 API key 計費才設 true；預設一律讓它用自己的登入
const CLAUDE_USE_API_KEY = String(process.env.CLAUDE_USE_API_KEY || 'false') === 'true';

/**
 * 給 claude 子程序的環境變數。
 *
 * ⚠️ 預設把 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 濾掉，原因：
 *    dotenv 會把 .env 灌進 process.env，而我們用 env: process.env 去 spawn，
 *    所以 .env 裡為了「撈模型清單」而設的 key 會被 claude 繼承 ——
 *    Claude Code 看到那個變數就會改用它驗證（可能從你的訂閱變成 API 計費）。
 *    這個 dashboard 不該偷偷改動 claude 的身分，所以預設不傳。
 *    真的想走 API key 就設 CLAUDE_USE_API_KEY=true。
 */
function claudeEnv() {
  if (CLAUDE_USE_API_KEY) return process.env;
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

// CLAUDE_BIN 不會變，啟動時算一次就好（needsShell 會 spawn where/which）
const CLAUDE_NEEDS_SHELL = needsShell(CLAUDE_BIN);

// -------------------------------------------------------------
//  Agent（工程師）狀態
// -------------------------------------------------------------
// 執行期狀態（status / task）放記憶體，名單本身讀自 engineers.json
const engineerState = {};   // id -> { status, task }

function stateOf(id) {
  if (!engineerState[id]) engineerState[id] = { status: 'idle', task: null };
  return engineerState[id];
}

/** 名單（設定檔）+ 執行期狀態 合併後的檢視，供 API 與前端使用 */
function engineersView() {
  const out = {};
  for (const e of loadEngineers()) {
    const st = stateOf(e.id);
    out[e.id] = { id: e.id, name: e.name, model: e.model || '', codexModel:e.codexModel || '', ...(e.look ? { look: e.look } : {}), status: st.status, task: st.task };
  }
  return out;
}

/** 取單一工程師（含名稱），找不到回 null */
function getEngineer(id) {
  const e = loadEngineers().find((x) => x.id === id);
  if (!e) return null;
  const st = stateOf(id);
  return { id: e.id, name: e.name, model: e.model || '', codexModel:e.codexModel || '', ...(e.look ? { look: e.look } : {}), status: st.status, task: st.task };
}

// 執行中任務： cardId -> { info, proc }
const activeTasks = new Map();

// -------------------------------------------------------------
//  task 檔案存取（每單一個資料夾）
// -------------------------------------------------------------
const {markdownFile, eventsFile, saveTask, readTask, updateTask, listTasks, removeTask} = require('./task-store').createTaskStore(TASK_DIR);
// 驗收完成的工作日誌：note/<年>/<月日>.md
const {createWorkLog, installWorkLogRoutes} = require('./features/work-log');
const workLog = createWorkLog(process.env.NOTE_DIR || path.join(ROOT_DIR, 'note'));

// -------------------------------------------------------------
//  廣播小工具
// -------------------------------------------------------------
// 保留最近的 PM 訊息，讓重新整理 / 重新連線的前端能看到歷史
const pmHistory = [];
const PM_HISTORY_MAX = 80;

function pmSay(message, level = 'info') {
  const entry = { message, level, ts: Date.now() };
  pmHistory.push(entry);
  if (pmHistory.length > PM_HISTORY_MAX) pmHistory.shift();
  io.emit('pm:message', entry);
  const pm = roleName(loadRoles(), 'pm');
  const tag = { info: pm, success: `${pm} ✔`, warn: `${pm} ⚠`, error: `${pm} ✖` }[level] || pm;
  console.log(`[${tag}] ${message}`);
}
function pushEngineers() {
  io.emit('engineers:update', engineersView());
}
function pushRoles() {
  io.emit('roles:update', { roles: loadRoles() });
}
/** 待指派看板只顯示目前 Jira 模式下接取的任務（判斷邏輯見 jira-source.js）。 */
function boardTasks() {
  return filterBySource(listTasks('backlog'), jiraMode());
}
function pushBoard() {
  io.emit('board:update', boardTasks());
}

// -------------------------------------------------------------
//  專案互斥鎖
//  同一個專案路徑同時只允許一個執行中的任務。
//  原因：所有任務都在同一個工作目錄下 spawn claude 與切 git 分支，
//        兩個任務並行會互相把 working tree 切走、改到同一批檔案。
//  以「解析後的絕對路徑」為鎖的鍵，避免兩個 id 指到同一路徑而漏鎖。
// -------------------------------------------------------------
function lockedPaths() {
  const map = Object.fromEntries(actionLocks);
  for (const { info } of activeTasks.values()) {
    if (info.status !== 'running') continue;
    const p = path.resolve(info.projectPath || DEFAULT_WORKSPACE);
    map[p] = { engineerName: info.engineerName, taskKey: info.key, cardId: info.cardId };
  }
  return map;
}

/** 回傳 { [projectId]: {engineerName, taskKey} }，給前端把被佔用的專案 disable */
function projectLocks() {
  const busy = lockedPaths();
  const { projects } = loadProjects();
  const out = {};
  for (const pr of projects) {
    const rp = path.resolve(pr.path);
    if (busy[rp]) out[pr.id] = busy[rp];
  }
  return out;
}

function pushLocks() {
  io.emit('projects:locks', projectLocks());
}
// 對話事件先落地，再廣播，供重新連線與事後回放。
const EVENT_REPLAY_MAX = 2000;    // 回放上限，避免一次灌爆前端
const eventSeq = new Map();       // cardId -> 下一個序號

function cardTaskKey(cardId) {
  const e = activeTasks.get(cardId);
  return e ? e.info.key : null;
}

/** 把字串截到 n 字元，超過就標記截斷 */
function emitEvent(cardId, ev, taskKeyHint) {
  const seq = (eventSeq.get(cardId) || 0) + 1;
  eventSeq.set(cardId, seq);
  const full = { cardId, seq, ts: Date.now(), ...ev };

  const key = taskKeyHint || cardTaskKey(cardId);
  if (key) {
    try {
      fs.appendFileSync(eventsFile(key), JSON.stringify(full) + '\n', 'utf8');
    } catch (err) {
      console.warn(`[warn] 寫入事件檔失敗：${err.message}`);
    }
    persistFromEvent(key, full);
  }
  io.emit('task:event', full);
  return full;
}

/**
 * 從事件裡把值得留在 task JSON 的欄位撈出來存。
 * 放在 emitEvent 這個共同出口，real 與 mock 兩條路才會一致。
 */
function persistFromEvent(key, ev) {
  const patch = {};
  // CLI 自己報的真實模型 —— 累積起來給設定畫面當候選（CLI 沒有列出模型的指令）
  if (ev.kind === 'system' && ev.subtype === 'init' && ev.model) {
    if (ev.provider!=='codex' && !String(ev.model).includes('(mock)')) seenModels.add(String(ev.model));
    patch.model = ev.model;
  }
  if (ev.sessionId) patch.sessionId = ev.sessionId;      // 之後要做 --resume 就靠這個
  if (ev.provider) patch.provider=ev.provider;
  if (ev.kind === 'result') {
    if (ev.costUsd != null) patch.costUsd = ev.costUsd;
    if (ev.numTurns != null) patch.numTurns = ev.numTurns;
    if (ev.durationMs != null) patch.durationMs = ev.durationMs;
  }
  if (Object.keys(patch).length) {
    try { updateTask(key, patch); } catch (_) {}
  }
}

/** 供重新連線的前端重建已結束任務卡片。 */
function recentFinished(limit = 20) {
  return listTasks()
    // 已停下、還沒封存的都要有卡片，含 aborted —— 中止的單更需要點進去看原因
    .filter((t) => t.cardId && !t.archived && (FINISHED.includes(t.status) || ARCHIVABLE.includes(t.status)))
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
    .slice(0, limit)
    .map((t) => ({
      cardId: t.cardId, key: t.key, summary: t.summary, source: taskSource(t),
      engineerId: t.engineerId || null, engineerName: t.engineerName || '',
      projectId: t.projectId || null, projectName: t.projectName || null,
      projectPath: t.projectPath || null, branch: t.branch || null,
      startedAt: t.startedAt || t.claimedAt || null, finishedAt: t.finishedAt || null,
      status: t.status, exitCode: t.exitCode, acceptedAt: t.acceptedAt || null,
      costUsd: t.costUsd != null ? t.costUsd : null,
      phase:t.phase, blockedReason:t.blockedReason, policyNotice:t.policyNotice || null, automation:t.automation, resultSummary:t.resultSummary || null,
      resultReport:t.resultReport || null, resultReportMock:!!t.resultReportMock, resultReportError:t.resultReportError || null, mock:t.mock,
    }));
}

/** 讀回某張工單的事件（給重新連線與事後回看用） */
function readEvents(key, limit = EVENT_REPLAY_MAX) {
  try {
    // 先濾掉純進度訊息再取尾段：既有的 log 裡已經寫進去的那些（曾有單筆 log 達 868
    // 筆、佔 62%）不必重寫檔案就不會再出現，回放上限也不會被它們吃掉。
    const lines = fs.readFileSync(eventsFile(key), 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const l of lines) {
      try {
        const ev = JSON.parse(l);
        if (!NOISE_SYSTEM_SUBTYPES.has(ev.subtype)) out.push(ev);
      } catch (_) {}
    }
    const dropped = Math.max(0, out.length - limit);
    return { events: out.slice(-limit), dropped };
  } catch (_) {
    return { events: [], dropped: 0 };
  }
}

/** 非 JSON 的原始輸出（stderr、git、警告）也走同一條管道，才不會有東西看不到 */
function terminalLog(cardId, chunk, stream = 'stdout') {
  const { text, truncated } = clip(chunk, 8000);
  emitEvent(cardId, { kind: 'raw', stream, text, truncated });
}

// -------------------------------------------------------------
//  Jira：取得待辦未指派任務清單
// -------------------------------------------------------------
const MOCK_TASKS = [
  { key: 'JIRA-101', summary: '登入頁 RWD 破版修復', description: '修復登入頁在手機寬度下按鈕溢出的問題，並確保 375px~1440px 皆正常顯示。完成後執行專案內單元測試確認功能正常。', type: 'Bug', priority: 'High' },
  { key: 'JIRA-102', summary: '新增使用者資料 API endpoint', description: '在後端新增 GET /api/users/:id，回傳使用者基本資料，需含錯誤處理與輸入驗證，並補上對應單元測試。', type: 'Story', priority: 'Medium' },
  { key: 'JIRA-103', summary: '重構訂單服務並補測試', description: '將 orderService 內重複邏輯抽成共用函式，維持既有行為不變，並補齊單元測試覆蓋主要分支。', type: 'Task', priority: 'Medium' },
  { key: 'JIRA-104', summary: '首頁載入效能優化', description: '首頁 API 呼叫過多導致載入緩慢，請合併請求並加入快取，完成後跑一次測試確認無回歸。', type: 'Task', priority: 'Low' },
];

async function fetchJiraTasks() {
  if (jiraMode() === 'mcp') {
    pmSay('正在透過 Atlassian MCP 連線 Jira，選取最新進行中 Sprint 並撈取待辦未指派任務…', 'info');
    const { tasks, jql, sprint } = await fetchUnassignedTasks({
      jql: JIRA_JQL,
      boardId: runtimeSettings.get('jiraBoardId'),
      onLog: (chunk, stream) => io.emit('mcp:log', { chunk, stream: stream || 'stdout', ts: Date.now() }),
    });
    return { mode: 'mcp', tasks, jql, sprint };
  }
  const sprint = MOCK_SPRINT;
  return { mode:'mock', tasks:MOCK_TASKS.map(t=>({...t,sprint})), sprint, jql:'(mock 模式，未查詢 Jira)' };
}

// -------------------------------------------------------------
//  依單號直接撈工單（不受 Sprint / 未指派條件限制）
// -------------------------------------------------------------
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** 把使用者輸入拆成乾淨的單號陣列（支援逗號 / 空白 / 換行分隔） */
function normalizeKeys(input) {
  const raw = Array.isArray(input) ? input.join(',') : String(input || '');
  const seen = new Set();
  const out = [];
  const bad = [];
  for (const piece of raw.split(/[\s,;]+/)) {
    const k = piece.trim().toUpperCase();
    if (!k) continue;
    if (!KEY_PATTERN.test(k)) { bad.push(piece.trim()); continue; }
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return { keys: out, invalid: bad };
}

/** 依單號撈工單內容（mcp / mock 共用）。回傳 [{key, summary, description}] */
async function fetchIssuesByKeys(keys) {
  if (!keys.length) return [];

  if (jiraMode() === 'mcp') {
    return await fetchIssuesDetail(keys, {
      onLog: (chunk, stream) =>
        io.emit('mcp:log', { chunk, stream: stream || 'stdout', ts: Date.now() }),
    });
  }

  // mock
  return MOCK_TASKS.filter((t) => keys.includes(t.key));
}

// -------------------------------------------------------------
//  接取任務（存到 task 資料夾）
// -------------------------------------------------------------
const claimStatusLabel = status => taskStatusLabel(status);
async function claimTasks(incoming, skipped = []) {
  // 工單號會用於檔名與 Git 分支，必須先驗證格式。
  const tasks = [];
  const rejected = [];
  for (const t of incoming || []) {
    if (!t || !t.key) continue;
    const key = String(t.key).trim().toUpperCase();
    if (!KEY_PATTERN.test(key)) {
      rejected.push(String(t.key));
      continue;
    }
    tasks.push({ ...t, key });
  }
  if (rejected.length) pmSay(`已擋下格式不合法的工單號：${rejected.join('、')}`, 'warn');
  if (!tasks.length) {
    throw new Error(
      rejected.length ? `工單號格式不正確：${rejected.join('、')}` : '沒有要接取的任務'
    );
  }

  // MCP 模式下清單只有 key+summary，接取時補撈完整描述存檔
  let detailMap = {};
  if (jiraMode() === 'mcp') {
    const needDetail = tasks.filter((t) => !t.description).map((t) => t.key);
    if (needDetail.length) {
      try {
        const details = await fetchIssuesDetail(needDetail, {
          onLog: (chunk, stream) =>
            io.emit('mcp:log', { chunk, stream: stream || 'stdout', ts: Date.now() }),
        });
        for (const d of details) detailMap[d.key] = d;
        if (needDetail.some(key => !detailMap[key])) throw Error('部分工單未回傳詳情');
      } catch (err) {
        throw Error(`接取失敗，未儲存不完整工單：${err.message}`);
      }
    }
  }

  const claimed = [];
  for (const t of tasks) {
    const existing = readTask(t.key);
    // 執行中、或有待驗收產出的就不覆蓋；可退回待指派的（含 blocked/interrupted）允許重接
    if (existing && existing.status && !REQUEUEABLE.includes(existing.status)) {
      const reason=claimStatusLabel(existing.status);skipped.push({key:t.key,status:existing.status,reason});
      pmSay(`${t.key} ${reason}，略過重複接取`, 'warn');
      continue;
    }
    // 需求描述為空是「輸入資料缺陷」，不是執行失敗：在建檔前就擋掉，
    // 讓 PM 當場知道要回 Jira 補需求。若放它進到狀態機，會一路帶著空描述
    // 走到派工前才被 runner 擋成 blocked，理由指向錯的人、也多占一格刊版。
    // 逐張擋、不中斷整批：一張沒寫需求不該害得其他張都接不了。
    if (!String(t.description || (detailMap[t.key] && detailMap[t.key].description) || '').trim()) {
      const reason='Jira 上沒有需求描述';skipped.push({key:t.key,status:'no_description',reason});
      pmSay(`${t.key} ${reason}，未接取；請先補齊需求再接取`, 'warn');
      continue;
    }
    const record = {
      key: t.key,
      summary: t.summary || (detailMap[t.key] && detailMap[t.key].summary) || '',
      description: t.description || (detailMap[t.key] && detailMap[t.key].description) || '',
      type: t.type || '',
      priority: t.priority || '',
      sprint: t.sprint || null,
      status: STATUS.BACKLOG,
      // 記下接取當下的 Jira 模式，看板才能只顯示對應來源的任務
      source: jiraMode(),
      claimedAt: Date.now(),
    };
    saveTask(record);
    io.emit('task:requeued',{key:record.key});
    claimed.push(record);
    pmSay(`已接取 ${record.key}：${record.summary}（已存入 task/）`, 'success');
  }

  pushBoard();
  return claimed;
}

// -------------------------------------------------------------
//  Git branch（在指定專案路徑下）
// -------------------------------------------------------------
// Git 不經 shell，避免參數被解析；分支建立失敗時呼叫端必須停止任務。
async function runGit(args, cwd, cardId, { quiet = false, beforeRun, approvalDetails } = {}) {
  const approved = await approvals.request({kind:'git',cardId,cwd,command:['git',...args].map(a=>JSON.stringify(a)).join(' '),details:approvalDetails});
  if (!approved) throw new Error('Git 操作未核准，已停止。');
  if(beforeRun)await beforeRun();
  if (cardId && !activeTasks.has(cardId)) throw new Error('任務已停止。');
  return new Promise((resolve) => {
    let git;
    try {
      git = spawn('git', args, { cwd });
    } catch (err) {
      return resolve({ code: -1, out: '', err: err.message });
    }
    let out = '';
    let err = '';
    git.stdout.on('data', (d) => {
      out += d.toString();
      if (!quiet) terminalLog(cardId, d.toString());
    });
    git.stderr.on('data', (d) => {
      err += d.toString();
      if (!quiet) terminalLog(cardId, d.toString(), 'stderr');
    });
    git.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    git.on('close', (code) => resolve({ code, out, err }));
  });
}

// 成果檢查只會用到這些固定的唯讀子命令。它們不修改工作區、分支或遠端，
// 因此不進 ApprovalGate；真正會寫入的 add/commit/restore/push 仍一律走 runGit。
const READ_ONLY_GIT = new Set(['rev-parse','status','diff','ls-files','show-ref','log']);
async function runGitReadOnly(args,cwd){
  const safe=Array.isArray(args) && (READ_ONLY_GIT.has(args[0]) || (args[0]==='remote'&&args[1]==='get-url'));
  if(!safe)throw Error('不允許的唯讀 Git 操作');
  return new Promise(resolve=>{
    let git;
    try{git=spawn('git',args,{cwd});}catch(error){return resolve({code:-1,out:'',err:error.message});}
    let out='',err='';
    git.stdout.on('data',d=>out+=d.toString());git.stderr.on('data',d=>err+=d.toString());
    git.on('error',error=>resolve({code:-1,out,err:error.message}));git.on('close',code=>resolve({code,out,err}));
  });
}

/**
 * 讀取專案目前的 git 狀態（唯讀，不會改動任何東西）。
 * 給「驗收面板」與「派新單前的守門」共用。
 */
async function gitInspect(cwd) {
  const inRepo = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, null, { quiet: true });
  if (inRepo.code !== 0) return { isRepo: false, branch: null, dirty: [], stat: '' };

  const head = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, null, { quiet: true });
  const st = await runGit(['status', '--porcelain'], cwd, null, { quiet: true });
  const stat = await runGit(['diff', '--stat', 'HEAD'], cwd, null, { quiet: true });

  const dirty = String(st.out || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2).trim(), file: l.slice(3) }));

  return {
    isRepo: true,
    branch: String(head.out || '').trim(),
    dirty,
    stat: String(stat.out || '').trim(),
  };
}

/**
 * 建立分支的完整流程：
 *   1. checkout <base> + pull --ff-only origin <base>
 *   2. checkout -b <branch>            成功就結束
 *   3. 失敗 → 分支已經存在嗎？
 *   4. 存在 → checkout <branch>，再確認 HEAD 真的在上面
 *
 * 第 2、3 步是為了「中止後重派同一張單」—— 那時候分支已經被上一次建好了。
 * 切回「這張單自己的分支」是安全的；FN-1 要防的是在 main 之類的分支上亂改。
 */
async function runBranchFlow(branch, cardId, cwd, baseBranch='develop') {
  if(branch===baseBranch)return {ok:false,branch,reason:`任務分支不能與基底分支 ${baseBranch} 相同`};
  terminalLog(cardId, `$ (cd ${cwd}) git checkout ${baseBranch}\n`);
  const base=await runGit(['checkout',baseBranch],cwd,cardId);
  if(base.code!==0)return {ok:false,branch,reason:`無法切換到基底分支 ${baseBranch}，請確認本機已有此分支且工作區乾淨`};
  terminalLog(cardId, `$ (cd ${cwd}) git pull --ff-only origin ${baseBranch}\n`);
  const pulled=await runGit(['pull','--ff-only','origin',baseBranch],cwd,cardId);
  if(pulled.code!==0)return {ok:false,branch,reason:`無法從 origin/${baseBranch} fast-forward 更新，請先處理分支分歧或遠端設定`};
  terminalLog(cardId, `[git] ${baseBranch} 已更新至 origin/${baseBranch} 最新版本\n`);
  terminalLog(cardId, `$ (cd ${cwd}) git checkout -b ${branch}\n`);
  const created = await runGit(['checkout', '-b', branch], cwd, cardId);
  if (created.code === 0) {
    terminalLog(cardId, `[git] 已建立並切換到分支 ${branch}\n`);
    return { ok: true, branch };
  }
  if (created.code === -1) {
    return { ok: false, branch, reason: `無法執行 git：${created.err}` };
  }

  // 分支已經存在？（中止後重派會走到這裡）
  const exists = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd, cardId, { quiet: true });
  if (exists.code !== 0) {
    return {
      ok: false,
      branch,
      reason: `git checkout -b 回傳 ${created.code}（目錄可能不是 git repo，或工作區有未提交的變更）`,
    };
  }

  terminalLog(cardId, `[git] 分支 ${branch} 已存在，切換回去繼續\n`);
  const sw = await runGit(['checkout', branch], cwd, cardId);
  if (sw.code !== 0) {
    return { ok: false, branch, reason: `分支 ${branch} 已存在但切換失敗（工作區可能有未提交的變更）` };
  }

  // 確認真的站在該分支上，不要只信回傳碼
  const head = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, cardId, { quiet: true });
  const cur = String(head.out || '').trim();
  if (cur !== branch) {
    return { ok: false, branch, reason: `切換後 HEAD 在 ${cur || '(不明)'}，不是預期的 ${branch}` };
  }
  terminalLog(cardId, `[git] 已在分支 ${branch}\n`);
  return { ok: true, branch, reused: true };
}

// -------------------------------------------------------------
//  Claude Code CLI 執行
// -------------------------------------------------------------
// -------------------------------------------------------------
//  解析 claude --output-format stream-json
// -------------------------------------------------------------
/** 把 chunk 累積成整行再吐出（NDJSON 一行一個訊息，chunk 邊界不一定對齊換行） */
function makeLineReader(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
    // 防守：萬一對方一直不換行，別讓 buffer 無限長大
    if (buf.length > 1024 * 1024) { onLine(buf); buf = ''; }
  };
}


// 放在 argv 的固定指示句。寫死的常數，不含引號或 shell 元字元 —— 這是它能安全
// 放在命令列上的前提。工單內容一律走 stdin，不要動這條界線。
const PROMPT_ARG =
  '依照 stdin 傳入的工單內容完成這個任務，修改完成後請執行專案內的單元測試確認功能正常';

// 送回饋時用的指示句。同樣是寫死的常數，回饋內容本身走 stdin。
const PROMPT_ARG_FEEDBACK =
  '依照 stdin 傳入的驗收意見修正你剛才的變更，改完後請重跑專案內的單元測試';

/** 送進 stdin 的工單內容（不進 argv，所以可以安全含換行、引號與任何字元） */
function buildPrompt(task) {
  return `請先讀取需求檔：${markdownFile(task.key)}\n依該檔案需求完成開發與測試。${PONYTAIL_GUIDANCE}\ntask.json 與需求檔的狀態由系統維護；執行紀錄由系統寫入同目錄 log.jsonl。\n\n需求快照：\n${fs.readFileSync(markdownFile(task.key), 'utf8')}`;
}

/**
 * 依任務保存的平台執行對應 CLI；新任務才使用目前的平台設定。
 */
function runAIReal(task,cardId,cwd,onDone,opts={}) {
  const provider=opts.provider || task.provider || aiSettings.get();
  if(provider==='claude')return runClaudeReal(task,cardId,cwd,onDone,opts);
  const entry=activeTasks.get(cardId);
  const prompt=opts.stdinText || buildPrompt(task);
  emitEvent(cardId,{kind:'launch',provider,cwd,bin:CODEX_BIN,args:['app-server'],resumeFrom:opts.resumeFrom,model:opts.model || null,promptChars:prompt.length,...clip(prompt,4000)});
  try { return runCodex({...codexOptions(cwd),prompt,model:opts.model,resumeFrom:opts.resumeFrom,
    permissionMode:accessMode(),
    onProcess:proc=>{if(entry)entry.proc=proc;opts.onProcess?.(proc);},
    emit:ev=>{if(ev.kind==='result' && entry)entry.cliOutcome=ev;emitEvent(cardId,{...ev,provider});},
    done:onDone,
    approve:async(method,params,item)=>{
      if(!entry || !activeTasks.has(cardId) || entry.aborting || entry.controller?.signal.aborted)return false;
      if(accessMode()!=='ask')return false;
      const approved=await approvals.request({kind:'tool',cardId,cwd,command:params.command || (method.includes('fileChange')?'Codex Edit':'Codex Bash'),input:{...params,item}});
      return approved && activeTasks.has(cardId) && !entry.aborting && !entry.controller?.signal.aborted;
    }
  }); } catch(error) {terminalLog(cardId,`[codex] 啟動失敗：${error.message}\n`,'stderr');onDone(1);}
}

/**
 * 執行 claude。
 *
 * @param {object}  opts
 * @param {string}  opts.stdinText  送進 stdin 的內容（工單或回饋）
 * @param {string}  opts.promptArg  argv 上的固定指示句
 * @param {string} [opts.resumeFrom] 有值就用 --resume 接續同一個 session
 */
function runClaudeReal(task, cardId, cwd, onDone, opts = {}) {
  const prompt = opts.stdinText || buildPrompt(task);
  const promptArg = opts.promptArg || PROMPT_ARG;
  const resumeFrom = opts.resumeFrom || null;
  if(resumeFrom && !/^[A-Za-z0-9_-]+$/.test(resumeFrom))throw Error('Session ID 格式不合法');
  const model = String(opts.model || '').trim();

  // ⚠️ 工單內容一律走 stdin，絕對不進 argv。
  //
  // 原因：Windows 上 claude 是 .cmd，只能走 shell（見 needsShell），而 shell 搭配
  // 未轉義的 args 會產生兩個實際可重現的問題：
  //   1. 描述裡的 & | > 會被 cmd.exe 當成語法 → 任意命令執行
  //   2. 描述裡的換行會讓命令在該處被截斷 → prompt 只剩第一行，
  //      而且排在後面的 --dangerously-skip-permissions 根本送不到，
  //      claude 於是停在互動式權限詢問、永遠不結束
  // 走 stdin 之後 argv 只剩固定字面值，順便也解掉 Windows 8191 字元的命令列長度上限。
  //
  // 注意分工：Claude Code 的 -p 是「prompt 走 argv、stdin 當附加資料」
  // （文件範例：cat build-error.txt | claude -p '解釋這個錯誤'），
  // 所以 argv 這邊留一句固定的指示句，真正的工單內容從 stdin 進去。
  // PROMPT_ARG 是程式裡寫死的常數、不含引號與 shell 元字元，所以放在 argv 是安全的；
  // 它含空白，走 shell 時要自己加引號，否則會被 cmd.exe 拆成多個參數。
  // stream-json 讓 stdout 變成 NDJSON，每一行是一個訊息（system / assistant /
  // user / result）。這是「看得到工程師在做什麼」的來源：讀了哪個檔、改了什麼、
  // 跑了哪個指令，都在裡面。
  // 自動模式用 Claude Code 原生的 --permission-mode auto：
  // -p 沒有人能回答權限詢問，沒放行的操作會被拒絕。
  // 手動模式維持 dontAsk + hook，每個工具呼叫都送到核准佇列讓人回答。
  //
  // AskUserQuestion（工程師丟選項給人選）三種模式都要能答，所以 hook 一律掛上：
  // 手動模式 hook 攔全部工具；其他模式只攔 AskUserQuestion，其餘工具照原本規則走。
  // 不能再加 --permission-prompts none —— 它會直接把 AskUserQuestion 從工具清單拿掉，hook 永遠等不到。
  const entry=activeTasks.get(cardId);
  const permission=accessMode();
  const permissionArgs=permission==='full'
    ? ['--permission-mode','bypassPermissions']
    : permission==='auto'
      ? ['--permission-mode','auto']
      : ['--permission-mode','dontAsk'];
  const args = [
    '-p',
    CLAUDE_NEEDS_SHELL ? `"${promptArg}"` : promptArg,
    ...permissionArgs,
    '--output-format', 'stream-json',
    '--verbose',
  ];
  const approvalToken=randomUUID();
  toolTokens.set(approvalToken,{cardId,cwd,questionsOnly:permission!=='ask'});
  const settingsDir=fs.mkdtempSync(path.join(os.tmpdir(),'rpg-approval-'));
  const settingsPath=path.join(settingsDir,'settings.json');
  // hook 的逾時要比「等人回答問題」長，否則 CLI 會先放棄、把問題當成失敗。
  fs.writeFileSync(settingsPath,JSON.stringify({hooks:{PreToolUse:[{matcher:permission==='ask'?'':ASK_TOOL,
    hooks:[{type:'command',command:`"${process.execPath.replace(/\\/g,'/')}" "${path.join(__dirname,'security','approval-hook.cjs').replace(/\\/g,'/')}"`,timeout:Math.ceil(QUESTION_TIMEOUT_MS/1000)+30}]}]}}));
  args.push('--settings',CLAUDE_NEEDS_SHELL ? shellQuote(settingsPath) : settingsPath);
  // session id 是我們自己從 stream-json 收下來的，格式受控，可以安全放在 argv
  if (resumeFrom) args.push('--resume', resumeFrom);
  // 模型名來自 engineers.json（別名或完整 id）。這會進 argv，而 Windows 上會經過
  // shell，所以先擋掉不該出現的字元 —— 只允許英數、底線、點、@ 與減號。
  if (model) {
    if (/^[A-Za-z0-9._@-]+$/.test(model)) args.push('--model', model);
    else emitEvent(cardId, { kind: 'raw', stream: 'stderr',
      text: `[warn] 模型名「${model}」含不允許的字元，已忽略，改用 claude 的預設
` });
  }
  const bin = CLAUDE_NEEDS_SHELL ? shellQuote(CLAUDE_BIN) : CLAUDE_BIN;

  emitEvent(cardId, {
    kind: 'launch', cwd, bin: CLAUDE_BIN, resumeFrom, model: model || null,
    args: ['-p', promptArg, ...permissionArgs, '--settings', settingsPath, '--output-format', 'stream-json', '--verbose']
      .concat(resumeFrom ? ['--resume', resumeFrom] : []),
    promptChars: prompt.length,
    ...clip(prompt, 4000),
  });

  let proc;
  try {
    proc = spawn(bin, args, { cwd, env: {...claudeEnv(),RPG_APPROVAL_TOKEN:approvalToken,RPG_APPROVAL_PORT:String(PORT),RPG_HOOK_TIMEOUT_MS:String(QUESTION_TIMEOUT_MS+20000)}, shell: CLAUDE_NEEDS_SHELL });
  } catch (err) {
    terminalLog(cardId, `[claude] 啟動失敗：${err.message}\n`, 'stderr');
    return onDone(1);
  }
  opts.onProcess?.(proc);
  proc.once('close',()=>{toolTokens.delete(approvalToken);fs.rmSync(settingsDir,{recursive:true,force:true});});
  if (entry) entry.proc = proc;

  // 寫完就關掉 stdin，讓 claude 讀到 EOF 才會開始跑
  proc.stdin.on('error', (err) => {
    terminalLog(cardId, `[claude] 寫入 stdin 失敗：${err.message}\n`, 'stderr');
  });
  proc.stdin.write(prompt);
  proc.stdin.end();

  // stdout 是 NDJSON：逐行解析成對話事件。解不開的行照原樣當 raw 送出去。
  const feed = makeLineReader((line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return emitEvent(cardId, { kind: 'raw', stream: 'stdout', ...clip(line, 4000) });
    }
    // session_id、成本、輪數的落地統一在 emitEvent → persistFromEvent 處理
    for (const ev of normalizeClaudeMessage(msg)) {
      if (ev.kind==='result' && entry) entry.cliOutcome=ev;
      emitEvent(cardId, ev);
    }
  });

  proc.stdout.on('data', (d) => feed(d.toString()));
  proc.stderr.on('data', (d) => terminalLog(cardId, d.toString(), 'stderr'));
  proc.on('error', (err) => { terminalLog(cardId, `[claude] 執行錯誤：${err.message}\n`, 'stderr'); onDone(1); });
  proc.on('close', (code) => {
    emitEvent(cardId, { kind: 'exit', code });
    onDone(code);
  });
}

/**
 * 模擬模式：吐出跟真實 stream-json 「同一組正規化事件」，
 * 所以前端只有一條渲染路徑 —— 沒裝 claude 的機器也能看到完整的對話畫面。
 */
// mock 劇本裡示範用的提問，格式與 Claude 原生 AskUserQuestion 相同
const MOCK_QUESTION = { questions: [{
  question: '登入按鈕在窄螢幕放不下時，要怎麼排列？', header: '按鈕排列', multiSelect: false,
  options: [
    { label: '自動換行', description: '維持橫排，空間不夠時換到下一行（flex-wrap）' },
    { label: '垂直堆疊', description: '窄螢幕一律改成上下排列，每顆按鈕滿版寬度' },
  ],
}] };
function runClaudeMock(task, cardId, cwd, onDone, opts = {}) {
  const provider=opts.provider || task.provider || aiSettings.get();
  const prompt = opts.stdinText || buildPrompt(task);
  const tu = (n) => `mock_tool_${n}`;

  // 回饋模式：演一段「接續原本對話、依意見修正」的短流程
  const script = opts.resumeFrom ? [
    { kind: 'launch', cwd, bin: CLAUDE_BIN, resumeFrom: opts.resumeFrom,
      args: ['-p', PROMPT_ARG_FEEDBACK, '--resume', opts.resumeFrom],
      promptChars: prompt.length, ...clip(prompt, 4000) },
    { kind: 'system', subtype: 'init', model: 'claude-sonnet-4-5 (mock)',
      sessionId: opts.resumeFrom, toolCount: 14, cwd },
    { kind: 'system', subtype: 'mock',
      text: '模擬模式：這裡示範接續同一個 session。真實模式下 AI 會記得剛才讀過哪些檔、改了什麼。' },
    { kind: 'thinking', text: '使用者說我改的方向不對。我先回去看一下自己剛才動過的那個檔案。' },
    { kind: 'text', role: 'assistant', text: '了解，我依你的意見重新處理。先確認我剛才改過的地方。' },
    { kind: 'tool_use', id: tu(11), name: 'Read', text: JSON.stringify({ file_path: 'src/components/Login.vue' }) },
    { kind: 'tool_result', id: tu(11), text: '.actions { display:flex; flex-wrap:wrap; gap:8px }   ← 我上一輪改的' },
    { kind: 'tool_use', id: tu(12), name: 'Edit',
      text: JSON.stringify({ file_path: 'src/components/Login.vue', old_string: 'gap:8px', new_string: 'gap:12px; justify-content:flex-end' }) },
    { kind: 'tool_result', id: tu(12), text: '已套用編輯：src/components/Login.vue（1 處變更）' },
    { kind: 'tool_use', id: tu(13), name: 'Bash', text: JSON.stringify({ command: 'npm test', description: '重跑測試' }) },
    { kind: 'tool_result', id: tu(13), text: 'PASS tests/login.spec.js\n\nTests: 12 passed, 12 total' },
    { kind: 'text', role: 'assistant', text: '已依你的意見調整並重跑測試，12 項全部通過。請再看一次。' },
    { kind: 'result', subtype: 'success', isError: false, durationMs: 4200, numTurns: 2,
      costUsd: 0.0188, sessionId: opts.resumeFrom, text: '已依意見修正' },
    { kind: 'exit', code: 0 },
  ] : [
    { kind: 'launch', cwd, bin: CLAUDE_BIN, args: ['-p', PROMPT_ARG, '--output-format', 'stream-json'],
      promptChars: prompt.length, ...clip(prompt, 4000) },
    { kind: 'system', subtype: 'init', model: 'claude-sonnet-4-5 (mock)',
      sessionId: `mock-${cardId}`, toolCount: 14, cwd },
    { kind: 'system', subtype: 'mock',
      text: '這是模擬模式：機器上找不到 claude CLI，以下對話為假資料，不會修改任何檔案。' },
    { kind: 'thinking', text: `先看一下 ${task.key} 要動哪些檔案。從描述判斷應該集中在登入相關的元件與樣式。` },
    { kind: 'text', role: 'assistant', text: `我先看一下專案結構，確認 ${task.key} 要改的範圍。` },
    { kind: 'tool_use', id: tu(1), name: 'Glob', text: JSON.stringify({ pattern: 'src/**/*.vue' }) },
    { kind: 'tool_result', id: tu(1), text: 'src/components/Login.vue\nsrc/components/Header.vue\nsrc/views/Home.vue' },
    { kind: 'tool_use', id: tu(2), name: 'Read', text: JSON.stringify({ file_path: 'src/components/Login.vue' }) },
    { kind: 'tool_result', id: tu(2), text: '<template>\n  <form class="login">\n    <input v-model="email" />\n    …（共 84 行）' },
    { kind: 'text', role: 'assistant', text: '找到問題了：按鈕的容器用了固定寬度，窄螢幕會溢出。修法有兩種，需求沒寫要哪一種，我先問一下。' },
    // 示範 AskUserQuestion：劇本在這裡暫停，真的跳出提問視窗等人回答，後續步驟依答案產生
    { ask: MOCK_QUESTION, id: tu(5), then: (answer) => {
      const stack = !answer || answer.includes('垂直');
      const css = stack ? '.actions { display:flex; flex-direction:column; gap:8px }' : '.actions { display:flex; flex-wrap:wrap; gap:8px }';
      return [
        { kind: 'text', role: 'assistant', text: answer
          ? `收到，照你選的「${answer}」處理。`
          : '沒有收到回答，我先用比較保守的「垂直堆疊」，完成摘要會註明這是我的假設。' },
        { kind: 'tool_use', id: tu(3), name: 'Edit',
          text: JSON.stringify({ file_path: 'src/components/Login.vue', old_string: '.actions { width: 420px }', new_string: css }) },
        { kind: 'tool_result', id: tu(3), text: '已套用編輯：src/components/Login.vue（1 處變更）' },
      ];
    } },
    { kind: 'tool_use', id: tu(4), name: 'Bash', text: JSON.stringify({ command: 'npm test', description: '跑單元測試' }) },
    { kind: 'tool_result', id: tu(4), text: 'PASS tests/login.spec.js\nPASS tests/api.spec.js\n\nTests: 12 passed, 12 total' },
    { kind: 'text', role: 'assistant',
      text: `${task.key} 完成。改了 src/components/Login.vue 一處，測試 12 項全部通過，變更已就緒待 Review。` },
    { kind: 'result', subtype: 'success', isError: false, durationMs: 7000, numTurns: 4,
      costUsd: 0.0412, sessionId: `mock-${cardId}`, text: `${task.key} 已完成` },
    { kind: 'exit', code: 0 },
  ];

  const send = (step) => {
    const event={...step,provider};
    if(provider==='codex') {
      if(event.kind==='launch'){event.bin=CODEX_BIN;event.args=['app-server'];}
      if(event.model)event.model='Codex (mock)';
      if(event.subtype==='mock')event.text='Codex 模擬模式：以下為示範資料，不會修改檔案。';
      if(event.kind==='result')event.costUsd=null;
    }
    emitEvent(cardId, event);
  };
  // 一步一步播；遇到提問步驟就停下來等人回答（走跟真實流程同一個提問佇列與視窗）
  let timer = null, stopped = false;
  const queue = [...script];
  const next = () => {
    if (stopped) return;
    if (!queue.length) return onDone(0);
    const step = queue.shift();
    if (!step.ask) { send(step); timer = setTimeout(next, 700); return; }
    send({ kind: 'tool_use', id: step.id, name: ASK_TOOL, text: JSON.stringify(step.ask) });
    const key = cardTaskKey(cardId);
    if (key) pmSay(`[${key}] 工程師有問題需要你選擇，請到「任務追蹤」該工程師的對話視窗回答。（模擬）`, 'warn');
    approvals.request({ kind:'question', cardId, cwd, taskKey:key, mock:true, questions:parseQuestions(step.ask) }, { timeout:QUESTION_TIMEOUT_MS })
      .then((result) => {
        if (stopped) return;
        const answer = result ? Object.values(result.answers)[0] : null;
        send({ kind: 'tool_result', id: step.id, isError: !answer,
          text: answer ? `User has answered your questions: ${JSON.stringify(result.answers)}` : '使用者沒有回答（略過或逾時）。' });
        queue.unshift(...step.then(answer));
        timer = setTimeout(next, 700);
      });
  };
  timer = setTimeout(next, 700);

  const entry = activeTasks.get(cardId);
  // 沒有 pid，abort 時 killTree 會走「有 kill() 就呼叫」那條路；等待中的提問由 finishTask 的 approvals.cancel 收掉
  if (entry) entry.proc = { kill: () => { stopped = true; clearTimeout(timer); approvals.cancel(cardId); }, mock: true };
}

// -------------------------------------------------------------
//  指派任務給工程師（開專屬管道執行）
// -------------------------------------------------------------
async function assignTask(taskKey, engineerId, projectId, force = false, branchMode, branchName) {
  if (!['manual','auto'].includes(branchMode)) throw new Error('請選擇手動切換或自動切換分支。');
  if (branchMode==='auto' && (typeof branchName!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(branchName) || /\.\.|\/\/|\.lock(?:\/|$)|[/.]$/.test(branchName))) throw new Error('分支名稱格式不合法。');
  const provider=aiSettings.get();
  const originalEngineer=getEngineer(engineerId);
  const eng=originalEngineer && {...originalEngineer,model:engineerModel(originalEngineer,provider)};
  if (!eng) throw new Error(`未知的工程師：${engineerId}`);
  if (eng.status !== 'idle') throw new Error(`${eng.name} 目前非 Idle 狀態，無法指派`);

  const task = readTask(taskKey);
  if (!task) throw new Error(`找不到任務 ${taskKey}（尚未接取？）`);
  if (task.status && task.status !== 'backlog') throw new Error(`${taskKey} 目前狀態為 ${task.status}，無法重複指派`);

  // 解析專案路徑
  const project = projectId ? resolveProject(projectId) : null;
  const cwd = (project && project.path) || DEFAULT_WORKSPACE;
  if (projectId && !project) throw new Error(`找不到專案設定：${projectId}`);
  if (normalizeAutomation(project?.automation).enabled) {
    return automationHost.start({...task,provider},eng,project,{branchMode,branchName});
  }

  // ---- 工作區必須乾淨 ----
  // commit 是使用者的職責（這是設計決定），所以這裡負責「確認他做了」。
  // 不檢查的話，上一張單的未提交變更會被 checkout -b 帶進這張單的分支，
  // 兩張單的差異混在同一個 diff 裡，就沒辦法分開驗收了。
  // 注意：這個 await 必須在互斥鎖檢查「之前」，否則檢查到設鎖之間會出現空窗。
  if (!force && aiMode(provider) === 'real') {
    const g = await gitInspect(cwd);
    if (g.isRepo && g.dirty.length) {
      const names = g.dirty.slice(0, 5).map((d) => d.file).join('、');
      const more = g.dirty.length > 5 ? ` 等 ${g.dirty.length} 個檔案` : '';
      const err = new Error(
        `專案「${project ? project.name : cwd}」還有未提交的變更（${names}${more}）。` +
        `請先 commit 或 stash —— 否則這些變更會被帶進 ${taskKey} 的分支，兩張單的差異會混在一起。`
      );
      err.code = 'DIRTY_TREE';
      err.dirty = g.dirty;
      err.branch = g.branch;
      throw err;
    }
  }

  // ---- 專案互斥鎖：同一專案同時只能有一個人執行 ----
  if (getEngineer(engineerId)?.status!=='idle' || readTask(taskKey)?.status!=='backlog') throw new Error('任務或工程師狀態已變更，請重新指派。');
  const busy = lockedPaths()[path.resolve(cwd)];
  if (busy) {
    throw new Error(
      `專案「${project ? project.name : cwd}」正由 ${busy.engineerName} 執行 ${busy.taskKey}，` +
      `請等該任務完成後再指派`
    );
  }

  const cardId = `${taskKey}-${engineerId}-${Date.now()}`;
  const startedAt = Date.now();

  // 工程師 -> Working
  const st = stateOf(engineerId);
  st.status = 'working';
  st.task = { key: taskKey, summary: task.summary, cardId };
  pushEngineers();

  // 更新 task 檔狀態（移出 backlog）
  updateTask(taskKey, {
    status: STATUS.IN_PROGRESS, provider, model:eng.model || '', sessionId:null, costUsd:null,
    engineerId,
    engineerName: eng.name,
    projectId: projectId || null,
    projectName: project ? project.name : null,
    projectPath: cwd,
    cardId,
    startedAt,
  });
  pushBoard();

  const cardInfo = {
    cardId, key: taskKey, summary: task.summary,
    engineerId, engineerName: eng.name,
    projectId: projectId || null, projectName: project ? project.name : null, projectPath: cwd,
    provider, model: eng.model || '', startedAt, status: toCardStatus(STATUS.IN_PROGRESS),
    source: taskSource(task),
  };
  activeTasks.set(cardId, { info: cardInfo, proc: null });
  // 同一張單可能跑好幾次（中止後重派），事件檔是累積的，所以標記一次新的開始
  emitEvent(cardId, {
    kind: 'assign', engineerName: eng.name,
    projectName: project ? project.name : cwd, cwd,
    ...clip(`${taskKey}：${task.summary}`, 500),
  }, taskKey);
  io.emit('task:started', cardInfo);
  pushLocks();   // 專案已被佔用，通知前端 disable
  pmSay(`已為 ${eng.name} 開專屬管道處理 ${taskKey}：${task.summary}（專案：${project ? project.name : cwd}）`, 'info');

  // 1) git branch（在專案路徑下）
  let git;
  try {
    if (aiMode(provider) !== 'real') git={ok:true,branch:branchMode==='auto' ? branchName : null};
    else if (branchMode==='manual') {
      const head=await runGit(['rev-parse','--abbrev-ref','HEAD'],cwd,cardId,{quiet:true});
      git={ok:head.code===0 && head.out.trim()!=='HEAD',branch:head.out.trim(),reason:'請先手動切換到有效分支。'};
    } else git=await runBranchFlow(branchName,cardId,cwd,normalizeAutomation(project?.automation).baseBranch);
  } catch(err) { finishTask(cardId,engineerId,taskKey,1); throw err; }
  if (!activeTasks.has(cardId)) return;
  io.emit('task:branch', { cardId, branch: git.branch });
  updateTask(taskKey, { branch: git.branch });   // 存起來，重整後才看得到分支

  // 分支沒開成功就不能讓 AI 動手 —— 否則它會直接改在當前分支（很可能是 main）上。
  // mock 模式不會真的修改檔案，而且預設工作目錄是本專案、本來就不是 git repo，
  // 所以那邊只警告、不中止。
  if (!git.ok) {
    if (aiMode(provider) === 'real') {
      terminalLog(cardId, `\n[abort] ${git.reason}\n`, 'stderr');
      terminalLog(cardId, `[abort] 已中止任務，避免 AI 在非預期的分支上修改檔案。\n`, 'stderr');
      pmSay(`[${taskKey}] 分支未建立成功，已中止：${git.reason}`, 'error');
      return finishTask(cardId, engineerId, taskKey, 1);
    }
    terminalLog(cardId, `[git] ${git.reason}\n`, 'stderr');
    terminalLog(cardId, `[git] mock 模式不會修改檔案，繼續示範。\n`);
  }

  // 2) 執行 claude
  const done = (code) => finishTask(cardId, engineerId, taskKey, code);
  const runOpts = { provider, model: eng.model || '' };
  if (aiMode(provider) === 'real') runAIReal(task, cardId, cwd, done, runOpts);
  else runClaudeMock(task, cardId, cwd, done, runOpts);
}

// -------------------------------------------------------------
//  中止執行中的任務
// -------------------------------------------------------------
/**
 * 殺掉整棵程序樹。
 *
 * Windows 上 claude 是透過 shell 啟動的，proc.kill() 只會殺掉那個 cmd.exe，
 * 真正在跑的 node 程序會變成孤兒繼續改你的檔案 —— 所以一定要用 taskkill /T。
 * POSIX 上先送 SIGINT（Claude Code 會把當前回合收尾），撐太久才 SIGKILL。
 */
function killTree(proc) {
  if (!proc) return;
  if (!proc.pid) {                       // mock：只是一個 setInterval
    try { proc.kill(); } catch (_) {}
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (_) {
      try { proc.kill(); } catch (_) {}
    }
    return;
  }
  try { proc.kill('SIGINT'); } catch (_) {}
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 5000);
}

/**
 * 把使用者的驗收意見送回給「同一個 session」繼續修。
 *
 * 靠 --resume <session_id>：AI 會帶著完整上下文（它讀過哪些檔、改了什麼、
 * 為什麼那樣改）繼續，不用從零重新理解一次。
 * 沿用同一個 cardId，所以對話會接在原本那一串後面。
 */
async function sendFeedback(taskKey, message) {
  const text = String(message || '').trim();
  if (!text) throw new Error('請輸入回饋內容');

  const task = readTask(taskKey);
  if (!task) throw new Error(`找不到任務 ${taskKey}`);
  if (task.automation?.enabled) {
    if (!RESUMABLE.includes(task.status)) throw Error('任務仍在執行，不能恢復');
    const original=getEngineer(task.engineerId);
    const engineer=original && {...original,model:task.model && !task.model.includes('(mock)') ? task.model : engineerModel(original,task.provider || 'claude')};
    if(!engineer)throw Error('原工程師不存在');
    // 還沒建立分支就被擋下的任務會重跑準備階段，必須沿用派工時選的分支模式，不能默默改成自動。
    const branchMode=task.branchMode || 'auto';
    const branchName=task.branchName || `${task.provider || 'claude'}/${task.key}`;
    return automationHost.start({...task,provider:task.provider || 'claude'},engineer,resolveProject(task.projectId),{resume:!!task.branch,prompt:text,branchMode,branchName});
  }
  if (!REVIEWABLE.includes(task.status)) {
    throw new Error(`${taskKey} 目前狀態是 ${taskStatusLabel(task.status)}，只有執行完的任務可以送回饋`);
  }
  if (!task.sessionId) {
    throw new Error(`${taskKey} 沒有 session id，無法接續原本的對話（請改用重新指派）`);
  }
  if (!task.cardId) throw new Error(`${taskKey} 沒有執行紀錄，無法接續`);

  const eng = getEngineer(task.engineerId);
  if (!eng) throw new Error('找不到原本的工程師（名單可能改過了），請改用重新指派');
  if (eng.status !== 'idle') throw new Error(`${eng.name} 正在忙，請等他手上的任務結束再送`);

  const cwd = task.projectPath || DEFAULT_WORKSPACE;
  const busy = lockedPaths()[path.resolve(cwd)];
  if (busy) {
    throw new Error(`專案正由 ${busy.engineerName} 執行 ${busy.taskKey}，請等它完成後再送回饋`);
  }

  const cardId = task.cardId;

  // 事件檔是累積的。接續時要把序號接在既有的後面 —— 伺服器重啟過的話
  // eventSeq 會歸零，前端的去重邏輯就會把新事件誤判成重複而丟掉。
  const prev = readEvents(taskKey);
  const maxSeq = prev.events.reduce((m, e) => (e.cardId === cardId && e.seq > m ? e.seq : m), 0);
  if ((eventSeq.get(cardId) || 0) < maxSeq) eventSeq.set(cardId, maxSeq);

  const st = stateOf(task.engineerId);
  st.status = 'working';
  st.task = { key: taskKey, summary: task.summary, cardId };
  pushEngineers();

  updateTask(taskKey, { status: STATUS.IN_PROGRESS, feedbackAt: Date.now(), finishedAt: null });
  pushBoard();

  const cardInfo = {
    cardId, key: taskKey, summary: task.summary,
    engineerId: task.engineerId, engineerName: eng.name,
    projectId: task.projectId || null, projectName: task.projectName || null, projectPath: cwd,
    branch: task.branch || null,
    startedAt: task.startedAt || Date.now(), status: toCardStatus(STATUS.IN_PROGRESS),
    source: taskSource(task),
  };
  activeTasks.set(cardId, { info: cardInfo, proc: null });
  io.emit('task:started', cardInfo);
  pushLocks();

  emitEvent(cardId, { kind: 'feedback', ...clip(text, 4000) });
  pmSay(`[${taskKey}] 你送出了驗收意見，${eng.name} 接續原本的對話繼續修`, 'info');

  const done = (code) => finishTask(cardId, task.engineerId, taskKey, code);
  const provider=task.provider || 'claude';
  const opts = { provider, stdinText: `${PONYTAIL_GUIDANCE}\n驗收意見：\n${text}`, promptArg: PROMPT_ARG_FEEDBACK, resumeFrom: task.sessionId,
                 model: task.model && !task.model.includes('(mock)') ? task.model : engineerModel(eng,provider) };
  if (aiMode(provider) === 'real') runAIReal(task, cardId, cwd, done, opts);
  else runClaudeMock(task, cardId, cwd, done, opts);

  return { ok: true, cardId, key: taskKey };
}

function abortTask(cardId) {
  const entry = activeTasks.get(cardId);
  if (!entry) throw new Error('找不到這筆執行中的任務（可能已經結束）');
  if (entry.aborting) throw new Error('已經在中止中，請稍等');
  if(entry.autonomous){entry.controller.abort();return {ok:true,cardId,key:entry.info.key};}
  entry.aborting = true;

  emitEvent(cardId, { kind: 'system', subtype: 'abort', text: '收到中止指令，正在停止工程師…' });
  pmSay(`[${entry.info.key}] 收到中止指令，正在停止 ${entry.info.engineerName}`, 'warn');
  killTree(entry.proc);

  // mock 的 kill 只是 clearInterval，不會觸發 close，所以自己收尾
  if (entry.proc && entry.proc.mock) {
    finishTask(cardId, entry.info.engineerId, entry.info.key, 130);
  }
  return { ok: true, cardId, key: entry.info.key };
}

function finishTask(cardId, engineerId, taskKey, code) {
  approvals.cancel(cardId);
  for(const [token,owner] of toolTokens)if(owner.cardId===cardId)toolTokens.delete(token);
  const eng = getEngineer(engineerId);
  const entry = activeTasks.get(cardId);
  if (!entry) return;                    // 已經收尾過了（例如 abort 與 close 都跑到）
  const aborted = !!entry.aborting;
  const status = aborted ? STATUS.ABORTED : code === 0 ? STATUS.DONE : STATUS.FAILED;
  if (entry) { entry.info.status = status; entry.info.finishedAt = Date.now(); }

  const st2 = stateOf(engineerId);
  st2.status = 'idle';
  st2.task = null;
  pushEngineers();

  // 保留中止狀態與 cardId，讓使用者重整後仍能查看對話並選擇重新派工。
  updateTask(taskKey, {
    status, exitCode: code, finishedAt: Date.now(),
    ...(aborted ? { abortedAt: Date.now() } : {}),
  });

  io.emit('task:finished', {
    cardId, key: taskKey, engineerId, exitCode: code, status, aborted, finishedAt: Date.now(),
  });

  if (aborted) {
    pmSay(`[${taskKey}] 已中止 ${eng ? eng.name : engineerId} 的執行。看過對話確認原因後，可用「退回待指派」重新派工。`, 'warn');
  } else if (code === 0) {
    pmSay(`[${taskKey}] 任務已由 ${eng ? eng.name : engineerId} 完成並跑完測試！請您進行 Code Review 與最後驗收。`, 'success');
  } else {
    pmSay(`[${taskKey}] 執行結束但回傳非 0（code ${code}），請檢視對話內容後再驗收。`, 'warn');
  }
  activeTasks.delete(cardId);
  pushLocks();   // 釋放專案鎖
}

// -------------------------------------------------------------
//  Express / HTTP / Socket.io
// -------------------------------------------------------------
const app = express();
app.use(express.json());
app.use('/assets/MetroCity', express.static(path.join(ROOT_DIR, 'assets', 'characters', 'MetroCity')));
app.get('/test.html', (req,res)=>res.sendFile(path.join(ROOT_DIR,'public/pages/test.html')));
app.get('/character-check.html', (req,res)=>res.sendFile(path.join(ROOT_DIR,'public/pages/character-check.html')));
app.use(express.static(path.join(ROOT_DIR, 'public')));

const server = http.createServer(app);
// 前端是由同一個 Express 服務出去的，所以不需要跨來源。
// 原本的 cors:{origin:'*'} 會讓任何網站的頁面都能連上這個 socket 並下指令。
const io = new Server(server);
const approvals = new ApprovalGate(items=>io.emit('approvals:update',items));
const automationHost=require('./workflow/host').createAutomationHost({
  readTask,updateTask,listTasks,activeTasks,stateOf,pushEngineers,pushBoard,pushLocks,io,emitEvent,pmSay,killTree,runClaudeReal:runAIReal,runClaudeMock,markdownFile,lockedPaths,readEvents,eventSeq,
  defaultWorkspace:DEFAULT_WORKSPACE,isMock:task=>aiMode(task.provider || 'claude')!=='real',generate:generateActionDraft,cancelApprovals:cardId=>{approvals.cancel(cardId);for(const [token,owner] of toolTokens)if(owner.cardId===cardId)toolTokens.delete(token);}
});
automationHost.recover();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{automationHost.shutdown();server.close();setTimeout(()=>process.exit(0),500).unref();});
async function generateActionDraft(prompt,model,provider=aiSettings.get()){
  if(provider==='codex' && aiMode(provider)==='real'){
    const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'rpg-codex-draft-'));
    try{return await new Promise((resolve,reject)=>{
      let output='',failure;let client;
      const timer=setTimeout(()=>{failure=Error('草稿生成逾時');client?.close();},120000);
      client=runCodex({...codexOptions(cwd),prompt,model,readOnly:true,
        emit:ev=>{if(ev.kind==='result'){output=ev.text || '';if(ev.isError)failure=Error(output);}},
        done:code=>{clearTimeout(timer);code===0 && !failure && output.trim()?resolve({text:output,mock:false}):reject(failure || Error('Codex 草稿生成失敗'));}});
    });}finally{fs.rmSync(cwd,{recursive:true,force:true});}
  }
  if(aiMode(provider)!=='real')return {mock:true,text:'【Mock 示範，非 AI 生成】\n'+prompt.split('\n').filter(l=>l.startsWith('任務：')||l.startsWith('分支：')).join('\n')+'\n\n請切換 real 模式，才能生成完整草稿。'};
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'rpg-draft-'));
  try{return await new Promise((resolve,reject)=>{
    const args=['-p',CLAUDE_NEEDS_SHELL?'"Generate the requested draft from stdin"':'Generate the requested draft from stdin','--tools',CLAUDE_NEEDS_SHELL?'""':'','--permission-mode','dontAsk','--output-format','text'];
    if(model && /^[A-Za-z0-9._@-]+$/.test(model))args.push('--model',model);
    const proc=spawn(CLAUDE_NEEDS_SHELL?shellQuote(CLAUDE_BIN):CLAUDE_BIN,args,{cwd,env:claudeEnv(),shell:CLAUDE_NEEDS_SHELL});
    let output='',error='',failure;const timer=setTimeout(()=>{failure=Error('草稿生成逾時');killTree(proc);},120000);
    proc.stdout.on('data',d=>{output+=d;if(output.length>200000){failure=Error('草稿輸出過長');killTree(proc);}});
    proc.stderr.on('data',d=>error=(error+d).slice(-4000));proc.on('error',e=>{clearTimeout(timer);reject(e);});
    proc.on('close',code=>{clearTimeout(timer);if(failure){reject(failure);return;}code===0&&output.trim()?resolve({text:output.trim(),mock:false}):reject(Error(error||'草稿生成失敗'));});proc.stdin.on('error',()=>{});proc.stdin.end(prompt);
  });}finally{fs.rmSync(cwd,{recursive:true,force:true});}
}
installActions(app,{loadEngineers,readTask,lockedPaths,actionLocks,runGit,readGit:runGitReadOnly,generate:generateActionDraft,pushLocks});
installJevReview(app,{readTask,markdownFile,readGit:runGitReadOnly,isMock:()=>runtimeSettings.get('mode')==='mock',isEnabled:()=>modules().jev});
installWorkLogRoutes(app,{workLog});
require('./features/task-reset').installTaskReset(app,{readTask,saveTask,eventsFile,activeTasks,lockedPaths,actionLocks,pushLocks,runGit,readGit:runGitReadOnly,eventSeq,pushBoard,io,pmSay,
  cancelApprovals:cardId=>{approvals.cancel(cardId);for(const [token,owner] of toolTokens)if(owner.cardId===cardId)toolTokens.delete(token);},
  baseBranchOf:task=>task.automation?.baseBranch || normalizeAutomation(loadProjects().projects.find(p=>p.id===task.projectId)?.automation).baseBranch});
app.post('/api/tasks/clear-finished',(req,res)=>{
  const keys=req.body.keys;
  if(!Array.isArray(keys) || keys.some(k=>typeof k!=='string' || !KEY_PATTERN.test(k)))return res.status(400).json({error:'任務清單格式不合法'});
  const cleared=[];
  for(const key of keys){
    const t=readTask(key); if(!t || [...activeTasks.values()].some(a=>a.info.key===key))continue;
    if(REQUEUEABLE.includes(t.status)){
      updateTask(key,{status:STATUS.BACKLOG,claimedAt:Date.now(),blockedReason:null});io.emit('task:requeued',{key});cleared.push(key);
    }else if(ARCHIVABLE.includes(t.status)){
      updateTask(key,{archived:true});io.emit('task:requeued',{key});cleared.push(key);
    }
  }
  pushBoard();res.json({ok:true,cleared});
});
/** 工程師用 AskUserQuestion 提問：放進確認佇列等人點選，答案透過 hook 的 updatedInput 交回 CLI。 */
async function askUser(owner,input,token){
  let questions;
  try{questions=parseQuestions(input);}catch(error){return {approved:false,reason:error.message};}
  const key=cardTaskKey(owner.cardId);
  if(key)pmSay(`[${key}] 工程師有問題需要你選擇，請到「任務追蹤」該工程師的對話視窗回答。`,'warn');
  const result=await approvals.request({kind:'question',...owner,taskKey:key,questions},{timeout:QUESTION_TIMEOUT_MS});
  if(!result || !activeTasks.has(owner.cardId) || !toolTokens.has(token))
    return {approved:false,reason:'使用者沒有回答（略過或逾時）。請依需求自行判斷最合理的做法並在完成摘要說明；若無法判斷，以 PIXELOFFICE_BLOCKED 回報問題。'};
  // updatedInput 會整個取代原本的輸入，所以 questions 要原樣帶回去
  return {approved:true,updatedInput:{...input,answers:result.answers}};
}
app.get('/api/approvals',(req,res)=>res.json(approvals.list()));
app.post('/api/approvals/:id',(req,res)=>{
  if(req.body.answers!==undefined){
    const item=approvals.get(req.params.id);
    if(!item || item.kind!=='question')return res.status(409).json({error:'問題已逾時或由其他視窗處理'});
    try{return res.json({ok:approvals.answer(req.params.id,{answers:normalizeAnswers(item.questions,req.body.answers)})});}
    catch(error){return res.status(400).json({error:error.message});}
  }
  if(typeof req.body.approved!=='boolean')return res.status(400).json({error:'需明確允許或拒絕'});
  res.status(approvals.decide(req.params.id,req.body.approved)?200:409).json({ok:true});
});
app.post('/api/tool-approval',async(req,res)=>{
  const owner=toolTokens.get(req.body.token);
  if(!owner || !activeTasks.has(owner.cardId))return res.status(403).json({approved:false});
  const event=req.body.event || {};
  if(event.tool_name===ASK_TOOL)return res.json(await askUser(owner,event.tool_input,req.body.token));
  // 只掛來接提問的 hook 不該管其他工具；萬一收到了，交回 CLI 自己的權限規則。
  if(owner.questionsOnly)return res.json({passthrough:true});
  const approved=await approvals.request({kind:'tool',...owner,command:event.tool_name || '未知工具',input:event.tool_input || {}});
  res.json({approved:approved && activeTasks.has(owner.cardId) && toolTokens.has(req.body.token)});
});

// -------------------------------------------------------------
//  REST API
// -------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ok:true,...systemInfo()});
});

app.get('/api/ai', (req,res)=>res.json({provider:aiSettings.get(),mode:aiMode(),providers:PROVIDERS}));
app.put('/api/ai',(req,res)=>{
  if(!PROVIDERS.includes(req.body?.provider))return res.status(400).json({error:'AI 平台必須為 claude 或 codex'});
  try {
    aiSettings.set(req.body.provider);
    io.emit('system:info',systemInfo());
    res.json({ok:true,provider:aiSettings.get(),mode:aiMode()});
  } catch(error){res.status(500).json({error:`儲存 AI 設定失敗：${error.message}`});}
});

app.get('/api/runtime',(req,res)=>res.json({
  ...runtimeSettingsView(), values:runtimeSettings.values(), defaults:runtimeSettings.defaults(),
}));

app.put('/api/runtime',(req,res)=>{
  const incoming=req.body && typeof req.body==='object' ? req.body : {};
  const wanted=Object.fromEntries(Object.entries(incoming)
    .filter(([key])=>SETTING_KEYS.includes(key))
    .map(([key,value])=>[key,String(value==null?'':value).trim().toLowerCase()]));
  const changed=Object.entries(wanted).filter(([key,value])=>runtimeSettings.get(key)!==value);
  if(!changed.length)return res.json({ok:true,...runtimeSettingsView()});

  // 切換模式不會影響「已經起來」的 process，硬切會造成畫面顯示 mock、
  // 實際卻在 real 模式動你的程式碼。有任務在跑就一律擋下。
  // 功能模組的開關不影響執行中的任務，不必等任務結束。
  const busy=changed.some(([key])=>!MODULE_KEYS.includes(key)) ? Object.values(lockedPaths()) : [];
  if(busy.length){
    const who=busy.map(b=>`${b.engineerName}（${b.taskKey}）`).join('、');
    return res.status(409).json({error:`${who} 正在執行任務，請等它結束或停止後再變更設定。`});
  }
  // real / mcp 都要靠看板 ID 選 Sprint，缺了會等到撈任務時才炸，不如現在就說。
  const nextMode='mode' in wanted ? wanted.mode : runtimeSettings.get('mode');
  const nextBoard='jiraBoardId' in wanted ? wanted.jiraBoardId : runtimeSettings.get('jiraBoardId');
  if(nextMode==='real' && !nextBoard){
    return res.status(400).json({error:'Real 模式的 Jira MCP 需要先填看板 ID（JIRA_BOARD_ID）。'});
  }
  try{
    for(const [key,value] of changed)runtimeSettings.set(key,value);
  }catch(error){return res.status(400).json({error:error.message});}
  io.emit('system:info',systemInfo());
  pushBoard();
  // 換了 Jira 模式或看板，手上那份快取就是別人的資料，丟掉並立刻在背景重撈。
  if(changed.some(([key])=>key==='mode'||key==='jiraBoardId')){
    jiraCache.invalidate();
    jiraCache.warm();
  }
  pmSay(`設定已更新：${changed.map(([k,v])=>`${k} → ${v||'（清空）'}`).join('、')}`,'info');
  res.json({ok:true,...runtimeSettingsView()});
});

require('./features/settings-routes').installSettingsRoutes(app, {
  loadProjects, saveProjects, loadEngineers, saveEngineers, engineersView, engineerState,
  lockedPaths, io, pushLocks, pmSay, pushEngineers, loadRoles, saveRoles, pushRoles,
});

// 撈 Jira 要走 MCP，實測 9~50 秒。開機先背景撈一次放著，畫面就不用等；
// 之後只有使用者按「重新整理」或改了 Jira 設定才重撈（見 jira-cache.js）。
const jiraCache = createJiraCache({
  loaders: {
    tasks: () => fetchJiraTasks(),
    cardOptions: require('./features/jira-card-routes').createCardOptionsLoader({
      jiraMode, aiMode,
      jiraBoardIdSetting: () => runtimeSettings.get('jiraBoardId'),
      onLog: (chunk, stream) => io.emit('mcp:log', { chunk, stream: stream || 'stdout', ts: Date.now() }),
    }),
  },
  onState: (name, state) => io.emit('jira:cache', state),
});

require('./features/jira-card-routes').installJiraCardRoutes(app, {
  jiraMode, aiMode, aiSettings, generate: generateActionDraft, pmSay, io,
  jiraBoardIdSetting: () => runtimeSettings.get('jiraBoardId'),
  readCardOptions: (opts) => jiraCache.read('cardOptions', opts),
});

/** 目前兩份快取的狀態（畫面用來顯示「資料取得於 HH:MM」）。 */
app.get('/api/jira/cache', (req, res) => res.json({ entries: jiraCache.states() }));

app.get('/api/jira/tasks', async (req, res) => {
  const refresh = String(req.query.refresh || '') === '1';
  try {
    const { data: result, fetchedAt, fromCache } = await jiraCache.read('tasks', { refresh });
    // 本地狀態每次都重算，不進快取 —— 快取只放 Jira 撈回來的原始清單，
    // 否則剛接取的單會在清單上顯示成還沒接。
    const available = result.tasks.filter(t=>{const status=readTask(t.key)?.status;return !status || REQUEUEABLE.includes(status);});
    pmSay(fromCache
      ? `待辦清單已就緒（資料取得於 ${new Date(fetchedAt).toLocaleTimeString('zh-TW',{hour12:false})}），${available.length} 個可接取任務`
      : `成功連線 Jira（${result.mode} 模式），目前有 ${available.length} 個可接取任務`, 'success');
    res.json({...result,fetchedAt,fromCache,tasks:available.map(t=>{const status=readTask(t.key)?.status;return {...t,localStatus:status,unavailable:false,localStatusLabel:status?claimStatusLabel(status):''};})});
  } catch (err) {
    pmSay(`連線 Jira 失敗：${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

// 任務刊版（backlog：已接取、尚未指派）
app.get('/api/tasks', (req, res) => res.json(listTasks(req.query.status)));

// 接取任務（可多選）
app.post('/api/tasks/claim', async (req, res) => {
  try {
    const skipped=[];
    const claimed = await claimTasks(req.body && req.body.tasks, skipped);
    res.json({ok:true,claimed,skipped});
  } catch (err) {
    pmSay(`接取失敗：${err.message}`, 'error');
    res.status(400).json({ error: err.message });
  }
});

// 依單號直接接取（不經清單）：{ keys: "DEMO-123, DEMO-456" 或 ["DEMO-123"] }
app.post('/api/tasks/claim-by-key', async (req, res) => {
  const { keys, invalid } = normalizeKeys(req.body && req.body.keys);
  if (!keys.length) {
    return res.status(400).json({
      error: invalid.length ? `單號格式不正確：${invalid.join('、')}` : '請輸入至少一個單號',
    });
  }
  try {
    pmSay(`正在查詢指定單號：${keys.join('、')}`, 'info');
    const found = await fetchIssuesByKeys(keys);
    const foundKeys = found.map((f) => f.key);
    const missing = keys.filter((k) => !foundKeys.includes(k));

    const claimed = found.length ? await claimTasks(found) : [];

    if (missing.length) pmSay(`查無這些單號：${missing.join('、')}`, 'warn');
    res.json({ ok: true, claimed, missing, invalid });
  } catch (err) {
    pmSay(`依單號接取失敗：${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

// 從刊版移除一張 backlog 任務
app.delete('/api/tasks/:key', (req, res) => {
  const t = readTask(req.params.key);
  if (!t) return res.status(404).json({ error: '找不到任務' });
  if (t.status && !DELETABLE.includes(t.status)) {
    // 已經跑過的單留著紀錄，不直接刪；但一定要指出它的出口在哪，
    // 否則使用者會以為卡死（blocked 以前就是這樣走進死路的）。
    const hint = REQUEUEABLE.includes(t.status) ? '，請用「退回待指派」' : '';
    return res.status(400).json({ error: `${t.key} 目前是「${claimStatusLabel(t.status)}」，無法直接放棄${hint}` });
  }
  removeTask(req.params.key);
  pushBoard();
  pmSay(`已放棄 ${t.key}：${t.summary}（已從刊版與 task/ 移除，Jira 上仍為未指派）`, 'warn');
  res.json({ ok: true });
});

require('./features/connection-routes').installConnectionRoutes(app, {
  io, aiSettings, aiMode, resolveBin, needsShell, shellQuote, claudeEnv,
  runCodex, codexOptions, killTree, makeLineReader, clip, normalizeClaudeMessage,
  CLAUDE_BIN, CODEX_BIN, CLAUDE_NEEDS_SHELL, CLAUDE_USE_API_KEY, runtimeSettings,
  HOST, PORT, jiraMode,
});

// 可選的模型清單（給設定畫面的下拉用）
app.get('/api/models', async (req, res) => {
  const provider=req.query.provider || aiSettings.get();
  if(!PROVIDERS.includes(provider))return res.status(400).json({error:'不支援的 AI 平台'});
  if(provider==='codex') {
    try{return res.json({provider,aliases:[],models:await codexModels(codexOptions(ROOT_DIR)),seen:[],error:null,note:'模型清單由本機 Codex CLI 提供；留空使用 Codex 預設模型。'});}
    catch(error){return res.json({provider,aliases:[],models:[],seen:[],error:error.message,note:'可留空使用 Codex 預設模型，或填入帳號可用的模型 ID。'});}
  }
  const { models, error } = await fetchModelList();
  res.json({
    aliases: MODEL_ALIASES,
    models,                                  // 有 ANTHROPIC_API_KEY 才有值
    seen: [...seenModels].sort(),             // 從實際執行學到的
    error,                                   // 撈不到的原因（給畫面說明）
    note: 'claude CLI 沒有列出模型的指令；別名永遠指向該系列最新版本。',
  });
});

// 某張工單的對話事件（重新整理、或事後回看已完成的單都用這支）
app.get('/api/tasks/:key/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || EVENT_REPLAY_MAX, EVENT_REPLAY_MAX);
  const { events, dropped } = readEvents(req.params.key, limit);
  res.json({ key: req.params.key, events, dropped });
});

// 驗收面板要的資料：這張單的專案現在有哪些變更、在哪條分支、能不能送回饋
app.get('/api/tasks/:key/review', async (req, res) => {
  const t = readTask(req.params.key);
  if (!t) return res.status(404).json({ error: '找不到任務' });
  const cwd = t.projectPath || DEFAULT_WORKSPACE;
  try {
    const g = await gitInspect(cwd);
    res.json({
      key: t.key, status: t.status, cwd,
      isRepo: g.isRepo, branch: g.branch, dirty: g.dirty, stat: g.stat,
      expectedBranch: t.branch || null,
      onExpectedBranch: !t.branch || g.branch === t.branch,
      canFeedback: !!(t.sessionId && t.cardId),
      costUsd: t.costUsd != null ? t.costUsd : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 使用者驗收完成：{ key }
app.post('/api/tasks/accept', (req, res) => {
  const { key } = req.body || {};
  const t = readTask(key);
  if (!t) return res.status(404).json({ error: '找不到任務' });
  if (t.status !== STATUS.DONE) {
    return res.status(400).json({ error: `${t.key} 目前狀態是 ${taskStatusLabel(t.status)}，只有待驗收任務可以驗收完成` });
  }
  const accepted = updateTask(key, { status: STATUS.ACCEPTED, acceptedAt: Date.now() });
  pmSay(`[${t.key}] 你已驗收並標記完成。`, 'success');
  // 日誌寫不進去不該讓驗收失敗；任務狀態已經存好了，提醒使用者即可。
  try {
    const log = workLog.record(accepted, readEvents(key).events.filter(ev => !t.cardId || ev.cardId === t.cardId));
    io.emit('worklog:update', { date: log.date, count: log.count });
  } catch (err) { pmSay(`[${t.key}] 工作日誌寫入失敗：${err.message}`, 'warn'); }
  io.emit('task:accepted', { key: t.key, acceptedAt: Date.now() });
  pushBoard();
  res.json({ ok: true });
});

// 送驗收意見回給同一個 session：{ key, message }
app.post('/api/tasks/feedback', async (req, res) => {
  const { key, message } = req.body || {};
  if (!key) return res.status(400).json({ error: '缺少 key' });
  try {
    res.json(await sendFeedback(key, message));
  } catch (err) {
    pmSay(`送回饋失敗：${err.message}`, 'error');
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/tasks/:key/resume',async(req,res)=>{
  try{res.json(await sendFeedback(req.params.key,req.body.message || '請接續原任務，確認現況後完成需求，並自行建置或測試確認成果。'));}
  catch(error){res.status(400).json({error:error.message});}
});
// 中止執行中的任務：{ cardId }
app.post('/api/tasks/abort', (req, res) => {
  const { cardId } = req.body || {};
  if (!cardId) return res.status(400).json({ error: '缺少 cardId' });
  try {
    res.json(abortTask(cardId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 指派：{ taskKey, engineerId, projectId }
app.post('/api/assign', async (req, res) => {
  const { taskKey, engineerId, projectId, force, branchMode, branchName } = req.body || {};
  if (!taskKey || !engineerId) return res.status(400).json({ error: '缺少 taskKey 或 engineerId' });
  try {
    await assignTask(taskKey, engineerId, projectId, !!force, branchMode, branchName);
    res.json({ ok: true });
  } catch (err) {
    // 工作區不乾淨要讓前端能顯示「哪些檔案」並提供「仍要繼續」
    if (err.code === 'DIRTY_TREE') {
      return res.status(409).json({ error: err.message, code: 'DIRTY_TREE', dirty: err.dirty, branch: err.branch });
    }
    pmSay(`指派失敗：${err.message}`, 'error');
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------
//  Socket.io 連線
// -------------------------------------------------------------
io.on('connection', (socket) => {
  socket.emit('approvals:update',approvals.list());
  socket.emit('engineers:update', engineersView());
  socket.emit('roles:update', { roles: loadRoles() });
  socket.emit('system:info', systemInfo());
  socket.emit('projects:update', loadProjects());
  socket.emit('board:update', boardTasks());
  socket.emit('pm:history', pmHistory);
  socket.emit('projects:locks', projectLocks());
  // 重新連線時回放執行中的任務事件。
  for (const { info } of activeTasks.values()) {
    socket.emit('task:started', info);
    const { events, dropped } = readEvents(info.key);
    socket.emit('task:events', { cardId: info.cardId, key: info.key, events, dropped });
  }
  // 最近結束的任務也給前端，這樣重整後還點得進去回看對話
  socket.emit('task:history', recentFinished());
});

// -------------------------------------------------------------
//  啟動
// -------------------------------------------------------------
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

// port 被占用時，Node 預設會丟出一整串 stack trace。對非工程背景的使用者來說
// 那完全看不懂，而且最常見的原因只是「已經開過一個了」。
server.on('error', err => {
  const shownHost = LOOPBACK.includes(HOST) ? 'localhost' : HOST;
  if (err && err.code === 'EADDRINUSE') {
    const url = `http://${shownHost}:${PORT}`;
    console.log('=============================================');
    console.log(`  PixelOffice 似乎已經在執行中（${PORT} 埠已被占用）。`);
    console.log(`  ➜  直接使用原本那個視窗，或開啟 ${url}`);
    console.log('');
    console.log('  如果確定沒有其他 PixelOffice 在跑，代表這個埠被別的程式占用；');
    console.log('  請在 .env 把 PORT 改成別的數字（例如 3100）後重新啟動。');
    console.log('=============================================');
    openBrowser(url);
    process.exitCode = 1;
    return;
  }
  console.error('PixelOffice 啟動失敗：', err && err.message ? err.message : err);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const { projects } = loadProjects();
  const shownHost = LOOPBACK.includes(HOST) ? 'localhost' : HOST;
  console.log('=============================================');
  console.log('  PixelOffice 已啟動');
  console.log(`  ➜  http://${shownHost}:${PORT}`);
  console.log(`  綁定位址   : ${HOST}`);
  const overridden=runtimeSettings.overridden();
  const mark=key=>overridden[key] ? '  ← 由畫面設定覆寫 .env' : '';
  console.log(`  Jira 模式  : ${jiraMode()}${mark('jira')}`);
  console.log(`  AI 平台    : ${aiSettings.get()} (${aiMode()})${mark(aiSettings.get())}`);
  console.log(`  task 資料夾: ${TASK_DIR}`);
  console.log(`  已載入專案 : ${projects.length} 個`);
  console.log('=============================================');
  openBrowser(`http://${shownHost}:${PORT}`);
  // 背景預熱待辦清單與開新單選項，使用者點開時就不用等 MCP。
  jiraCache.warm();
  if (!LOOPBACK.includes(HOST)) {
    console.log('');
    console.log(`  ⚠️  目前綁定在 ${HOST}，同網段的其他人可以連進來。`);
    console.log('      這個服務沒有任何認證：連進來的人可以改專案路徑，');
    console.log('      並讓 claude 在那個路徑下執行。');
    console.log('      除非你已自行加上認證與網路隔離，請改回 HOST=127.0.0.1。');
    console.log('');
  }
});
